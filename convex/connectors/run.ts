// The one way a connector runs. Fetch and build every row first; then write
// the numbers and the run record in a single mutation. Side tables, when a
// connector has them, are written only after that commit, each batch an
// overwrite of its own rows. Every other outcome (no key, a failed request,
// an empty result, a row the registry refuses, a number write that throws)
// is logged and leaves those side tables exactly as they were.

import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { sourceOn } from "../lib/featureGates";
import type { SourceId } from "../lib/metricRegistry";
import { validateSnapshots, type SnapshotInput } from "../lib/snapshotRules";
import { ConnectorError } from "./errors";
import { SOURCES, feedOf, missingEnv } from "./manifest";

export type RunOutcome = "ok" | "not_configured" | "empty" | "error";

// What a class name looks like. A thrown object's `name` is not our own
// writing either, so it is kept only when it is a bare identifier: too short
// and too plain to carry a URL, a header or a response body.
const CLASS_NAME = /^[A-Za-z][A-Za-z0-9]{0,39}$/;

/**
 * What goes in the run log for something a connector threw. Only a
 * ConnectorError's message is the connector's own words. Anything else may
 * quote a URL, a header or a response body, so only its class name is kept.
 *
 * Never throws: whatever was thrown can be any value at all, and a getter on
 * it can throw too. The name is read once, so it cannot differ between the
 * check and the use.
 */
export function describeError(error: unknown): string {
  try {
    if (error instanceof ConnectorError) return error.message;
    const name: unknown = (error as { name?: unknown }).name;
    const kept = typeof name === "string" && CLASS_NAME.test(name) ? name : "unknown";
    return `The run failed unexpectedly (${kept}).`;
  } catch {
    return "The run failed unexpectedly (unknown).";
  }
}

export async function runConnector(
  ctx: ActionCtx,
  source: SourceId,
  /** Told the run's start time, so a connector never reads a clock of its own. */
  fetchRows: (now: number) => Promise<SnapshotInput[]>,
  /**
   * What else the run writes besides numbers (Globex's clinics, doctors
   * and breakdowns). Called only after the numbers have committed. A clinic's
   * year does not fit in one mutation, so this writes in batches, each an
   * overwrite of its own rows: the next run replaces a batch that stopped
   * partway. A throw here fails the run; the numbers stay.
   */
  writeAlso?: () => Promise<void>,
): Promise<RunOutcome> {
  // A source a switched-off feature takes away (convex/lib/featureGates.ts):
  // its schedule does nothing, and leaves no run behind.
  if (!sourceOn(source)) return "not_configured";
  const startedAt = Date.now();
  const fail = async (status: Exclude<RunOutcome, "ok">, message: string) => {
    await ctx.runMutation(internal.snapshots.recordFailure, { source, startedAt, status, message });
    return status;
  };

  const definition = SOURCES.find((s) => s.id === source);
  if (!definition) return fail("error", `"${source}" is not in the connector manifest.`);
  // Fed by a connector run instead (its ingest token is set and its API
  // variables are not): the schedule has nothing to do, and a daily "not
  // configured" would sit over every good push.
  if (feedOf(definition) === "push") return "not_configured";
  const missing = missingEnv(definition);
  if (missing.length > 0) {
    return fail("not_configured", `Set ${missing.join(", ")} on the Convex deployment.`);
  }

  let rows: SnapshotInput[];
  try {
    rows = await fetchRows(startedAt);
  } catch (error) {
    return fail("error", describeError(error));
  }
  // "Nothing" is far more often a broken request than a true zero.
  if (rows.length === 0) return fail("empty", "The source returned nothing.");

  // Checked here, as the ingest endpoint does, so a refused row is logged in
  // the registry's words instead of being thrown out of the write.
  const issues = validateSnapshots(source, rows, undefined, { now: startedAt });
  if (issues.length > 0) return fail("error", issues.map((issue) => issue.message).join(" "));

  try {
    await ctx.runMutation(internal.snapshots.applySync, { source, startedAt, rows });
  } catch (error) {
    // If the write commits but the call fails on the way back, this records
    // "error" over rows that were written. The effect is a false "last run
    // failed" until the next run, never a wrong number. A throw from the
    // mutation itself rolls back, and the side tables are written only after
    // this returns, so they stay as they were.
    return fail("error", describeError(error));
  }

  if (writeAlso !== undefined) {
    try {
      await writeAlso();
    } catch (error) {
      // The numbers are already committed. Each side batch overwrites its own
      // rows, so the next run replaces a batch that stopped partway.
      return fail("error", describeError(error));
    }
  }
  return "ok";
}
