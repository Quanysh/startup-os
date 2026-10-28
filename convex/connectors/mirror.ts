// The one way a work-tool connector runs: runConnector's sibling for mirrored
// records. Read everything first; then one mutation writes the records and
// the run. Every other outcome leaves what is stored exactly as it was.

import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import {
  GOOGLE_SOURCES,
  refusal,
  type MirrorRecord,
  type MirrorSource,
} from "../lib/mirrorRules";
import { ConnectorError } from "./errors";
import { SOURCES, feedOf, missingEnv } from "./manifest";
import { describeError, type RunOutcome } from "./run";

/** Thrown by a read that needs a connection the owner has not made yet. */
export class NotConnected extends ConnectorError {}

export async function runMirror(
  ctx: ActionCtx,
  source: MirrorSource,
  options: {
    /** True only where an empty, well-shaped answer is a real one (an empty inbox). */
    allowEmpty: boolean;
  },
  /** Told the run's start time, so a connector never reads a clock of its own. */
  read: (now: number) => Promise<MirrorRecord[]>,
): Promise<RunOutcome> {
  const startedAt = Date.now();
  const fail = async (status: "error" | "empty", message: string) => {
    await ctx.runMutation(internal.snapshots.recordFailure, { source, startedAt, status, message });
    return status;
  };
  const notConfigured = async (message: string) => {
    await ctx.runMutation(internal.mirror.noteNotConfigured, { source, message });
    return "not_configured" as const;
  };

  const definition = SOURCES.find((s) => s.id === source);
  if (!definition) return fail("error", `"${source}" is not in the connector manifest.`);
  // Fed by a connector run instead: nothing to read, and nothing to note. A
  // note here would replace the status its last push left.
  if (feedOf(definition) === "push") return "not_configured";
  const missing = missingEnv(definition);
  if (missing.length > 0) {
    return notConfigured(`Set ${missing.join(", ")} on the Convex deployment.`);
  }
  if (await ctx.runQuery(internal.workTools.isOff, { source })) {
    return notConfigured("Turned off under Settings → Work tools.");
  }

  // Which grant this read begins under, noted before anything is fetched. The
  // write is dropped unless the same grant is still the stored one, so a read
  // that outlives "disconnect, then connect again" cannot land.
  const grantAt = GOOGLE_SOURCES.includes(source)
    ? ((await ctx.runQuery(internal.google.grantAt, {})) ?? undefined)
    : undefined;

  let rows: MirrorRecord[];
  try {
    rows = await read(startedAt);
  } catch (error) {
    if (error instanceof NotConnected) return notConfigured(error.message);
    return fail("error", describeError(error));
  }
  if (rows.length === 0 && !options.allowEmpty) {
    return fail("empty", "The source returned nothing.");
  }
  const refused = refusal(source, rows);
  if (refused !== null) return fail("error", refused);

  try {
    const written = await ctx.runMutation(internal.mirror.apply, {
      source,
      startedAt,
      rows,
      ...(grantAt === undefined ? null : { grantAt }),
    });
    // Switched off or disconnected while the read was in flight: the write
    // was dropped, and whoever did that has already set the source's status.
    if (written === null) return "not_configured";
  } catch (error) {
    return fail("error", describeError(error));
  }
  return "ok";
}
