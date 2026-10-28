// Rules for pipeline rows pushed through the ingest endpoint, shared by the
// endpoint (which answers 422 with what is wrong) and the write itself (which
// checks again, so no other caller can skip them).
//
// No message here repeats a value from the push. Rows carry company and
// person names, and a failure message is stored in the run log.

import { MAX_PIPELINE_AMOUNT } from "./limits";
import { SOURCES } from "../connectors/manifest";
import type { Currency } from "./metricRegistry";
import { isCanonicalPeriodStart } from "./periods";
import { UNMAPPED, isClosedStage, normalizeStage, type Pipeline } from "./pipelineStages";

export type Market = "us" | "kz";

/**
 * Which source may push each pipeline, and what that fixes. A source that is
 * not listed here cannot write the pipeline at all; "manual" is never listed,
 * because native rows are written only by the owner's own mutations.
 */
export const PIPELINE_OWNERS = {
  deals: { kz_crm: { market: "kz", currency: "KZT" } },
  investors: { visible: { market: null, currency: "USD" } },
} as const satisfies Record<
  Pipeline,
  Record<string, { market: Market | null; currency: Currency }>
>;

export function pipelineOwner(
  pipeline: Pipeline,
  source: string,
): { market: Market | null; currency: Currency } | null {
  const owners: Record<string, { market: Market | null; currency: Currency }> =
    PIPELINE_OWNERS[pipeline];
  return Object.hasOwn(owners, source) ? owners[source]! : null;
}

/** Whether a source pushes any pipeline, and so sends company and person names. */
export function ownsAPipeline(source: string): boolean {
  return Object.values(PIPELINE_OWNERS).some((owners) => Object.hasOwn(owners, source));
}

/** The source of a row the owner made here. */
export const NATIVE_SOURCE = "manual";

/** Markets where a deal can be created by hand. Kazakhstan's come from its CRM. */
export const NATIVE_DEAL_MARKETS: readonly Market[] = ["us"];

/** How a source reads inside a sentence: "the Kazakhstan CRM", "Visible". */
export function sourceNamed(source: string): string {
  return SOURCES.find((s) => s.id === source)?.named ?? "another system";
}

/** A row as it arrives in the envelope. */
export type PipelineRowInput = {
  externalId: string;
  name: string;
  contact?: string;
  stage: string;
  amount?: number;
  currency?: string;
  lastActivityAt?: string;
  closedAt?: string;
};

/** A row ready to store: stage normalised, dates as timestamps, text trimmed. */
export type PipelineRow = {
  externalId: string;
  name: string;
  contact?: string;
  stage: string;
  sourceStage: string;
  amount?: number;
  lastActivityAt?: number;
  closedAt?: number;
};

export type PipelineIssue = { path: string; message: string };

const DAY_MS = 24 * 60 * 60 * 1000;
const CLOSED_WORDS: Record<Pipeline, string> = {
  deals: "Only a won or lost deal has a close date.",
  investors: "Only a committed or passed investor has a close date.",
};

/**
 * Check a batch of pushed rows and turn it into rows to store. Returns every
 * problem found, at most one per row. `rows` is meaningful only when `issues`
 * is empty.
 */
export function checkPipelineRows(
  pipeline: Pipeline,
  source: string,
  input: readonly PipelineRowInput[],
  now: number,
): { issues: PipelineIssue[]; rows: PipelineRow[] } {
  const owner = pipelineOwner(pipeline, source);
  if (owner === null) {
    return {
      issues: [{ path: pipeline, message: `This source does not own ${pipeline}.` }],
      rows: [],
    };
  }

  const issues: PipelineIssue[] = [];
  const rows: PipelineRow[] = [];
  const seen = new Set<string>();

  input.forEach((row, index) => {
    const fail = (field: keyof PipelineRowInput, message: string) =>
      issues.push({ path: `${pipeline}.${index}.${field}`, message });

    const externalId = row.externalId.trim();
    if (externalId === "") return fail("externalId", "Is blank.");
    if (seen.has(externalId)) return fail("externalId", "Appears more than once in this push.");
    seen.add(externalId);

    const name = row.name.trim();
    if (name === "") return fail("name", "Is blank.");
    const contact = row.contact?.trim();
    if (contact === "") return fail("contact", "Is blank. Leave it out instead.");
    if (row.stage.trim() === "") return fail("stage", "Is blank.");

    if (row.amount === undefined) {
      if (row.currency !== undefined) return fail("currency", "A currency without an amount.");
    } else {
      if (!Number.isFinite(row.amount) || row.amount < 0 || row.amount > MAX_PIPELINE_AMOUNT) {
        return fail("amount", `Must be between 0 and ${MAX_PIPELINE_AMOUNT}.`);
      }
      if (row.currency === undefined) return fail("currency", "An amount needs its currency.");
      if (row.currency !== owner.currency) {
        return fail("currency", `Amounts from this source are in ${owner.currency}.`);
      }
    }

    const stage = normalizeStage(pipeline, row.stage);
    const dates: { lastActivityAt?: number; closedAt?: number } = {};
    for (const field of ["lastActivityAt", "closedAt"] as const) {
      const value = row[field];
      if (value === undefined) continue;
      if (!isCanonicalPeriodStart("day", value)) return fail(field, "Is not a date (YYYY-MM-DD).");
      const at = Date.parse(`${value}T00:00:00Z`);
      // A day of grace for a sender ahead of UTC.
      if (at > now + DAY_MS) return fail(field, "Is in the future.");
      dates[field] = at;
    }
    if (dates.closedAt !== undefined && stage !== UNMAPPED && !isClosedStage(pipeline, stage)) {
      return fail("closedAt", CLOSED_WORDS[pipeline]);
    }

    rows.push({
      externalId,
      name,
      contact,
      stage,
      sourceStage: row.stage.trim(),
      amount: row.amount,
      ...dates,
    });
  });

  return { issues, rows };
}
