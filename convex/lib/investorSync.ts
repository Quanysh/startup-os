// Visible write-back: what a change to an investor here queues for Visible,
// and how the daily pull from Visible treats a queued change.
//
// Visible has no API for its pipeline but its MCP, so the OS never writes to
// it itself. A change made here applies at once and leaves one `investorSync`
// row per investor (the latest value of each field wins); the daily connector
// run reads the outbox, writes each item with Visible's own tools and acks it
// (convex/visibleOutbox.ts, docs/setup.md "Visible"). Until then the
// pull keeps the OS's value of a queued field, so a read cannot undo an edit
// that has not reached Visible yet.
//
// What is stored and sent is the card's own fields, a note's text, and codes.
// Nothing here logs or throws a name.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { NATIVE_SOURCE, type PipelineRow } from "./pipelineRules";

/** The source whose investors are written back. */
export const VISIBLE_SOURCE = "visible";

export const SYNC_FIELDS = ["stage", "amount", "name"] as const;
export type SyncField = (typeof SYNC_FIELDS)[number];
export type SyncFields = { stage?: string; amount?: number | null; name?: string };
export type SyncNote = { nextStep?: string | null; notes?: string | null };
export type SyncStatus = Doc<"investorSync">["status"];

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a card says a change sent from here was changed again in Visible. */
export const CHANGED_IN_VISIBLE_MS = 7 * DAY_MS;
/** How long a confirmed row is kept as history. */
export const CONFIRMED_KEPT_MS = 30 * DAY_MS;
/** The most items one outbox read lists; the rest wait for the next. */
export const MAX_OUTBOX_ITEMS = 100;
export const MAX_ACK_RESULTS = MAX_OUTBOX_ITEMS;
export const MAX_ACK_BYTES = 64 * 1024;
/** The most investors one bulk action takes. */
export const MAX_BULK_INVESTORS = 100;
/** Rows one investor's history lists. */
export const MAX_SYNC_HISTORY = 20;
/** Rows of one status the board reads to show each card's sync state. */
const MAX_OPEN_READ = 1_000;
/** Confirmed rows one pull prunes. */
const MAX_PRUNED = 200;

/** Fixed words: no refusal here says a name or a value. */
export const SYNC_WORDS = {
  nothingFailed: "Nothing failed to sync for that investor.",
  noneChosen: "Pick at least one investor.",
  tooMany: `Pick at most ${MAX_BULK_INVESTORS} investors at once.`,
  gone: "That investor no longer exists.",
  notArchived: "That investor is not archived.",
  archivedBySource:
    "Visible took this investor off its pipeline. It comes back when Visible lists it again.",
  failed: "That did not work.",
} as const;

/** Codes the OS itself sets on a row, beside the ones the run sends. */
export const OS_ERROR_CODES = {
  missingVisibleId: "missing_visible_id",
  alreadyInOs: "already_in_os",
} as const;

/** Whether an investor takes part in write-back: Visible's own, or one made here. */
export const syncsToVisible = (row: { source: string }) =>
  row.source === VISIBLE_SOURCE || row.source === NATIVE_SOURCE;

type Card = Pick<Doc<"investors">, "name" | "stage" | "amount" | "nextStep" | "notes">;

/** What changed between two states of a card, as Visible would be told it. */
export function changeOf(before: Card, after: Card): { fields: SyncFields; note: SyncNote | undefined } {
  const fields: SyncFields = {};
  if (before.stage !== after.stage) fields.stage = after.stage;
  if (before.name !== after.name) fields.name = after.name;
  if ((before.amount ?? null) !== (after.amount ?? null)) fields.amount = after.amount ?? null;
  const note: SyncNote = {};
  if (before.nextStep !== after.nextStep) note.nextStep = after.nextStep ?? null;
  if (before.notes !== after.notes) note.notes = after.notes ?? null;
  return { fields, note: Object.keys(note).length > 0 ? note : undefined };
}

export const mergeFields = (queued: SyncFields, next: SyncFields): SyncFields => ({ ...queued, ...next });

export function mergeNote(queued: SyncNote | undefined, next: SyncNote | undefined): SyncNote | undefined {
  if (queued === undefined) return next;
  if (next === undefined) return queued;
  return { ...queued, ...next };
}

const isEmpty = (fields: SyncFields) => SYNC_FIELDS.every((field) => fields[field] === undefined);

/** The note written to Visible, one part a line; undefined when there is none. */
export function noteText(note: SyncNote | undefined): string | undefined {
  if (note === undefined) return undefined;
  const lines: string[] = [];
  if (note.nextStep !== undefined) lines.push(`Next step: ${note.nextStep ?? "(cleared)"}`);
  if (note.notes !== undefined) lines.push(`Notes: ${note.notes ?? "(cleared)"}`);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/** Whether a pulled value is the one that was queued. A missing amount equals a cleared one. */
export function sameSyncValue(field: SyncField, pulled: unknown, queued: unknown): boolean {
  if (field === "amount") return (pulled ?? null) === (queued ?? null);
  if (field === "name") return typeof pulled === "string" && typeof queued === "string" && pulled.trim() === queued.trim();
  return pulled === queued;
}

// ── The ack's shape ──────────────────────────────────────────────────────

export type AckResult = { id: string; revision: number; ok: boolean; visibleId?: string; errorCode?: string };
export type AckIssue = { path: string; message: string };

const ACK_KEYS = new Set(["id", "revision", "ok", "visibleId", "errorCode"]);
// A row id as the outbox gave it: printable, no spaces. Whether it is one is the write's to ask.
const ROW_ID = /^[\x21-\x7e]{1,64}$/;
const VISIBLE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * The ack, checked whole. Every issue is a path and fixed words: nothing the
 * run sent is quoted back, since a reply is logged.
 */
export function parseAck(raw: unknown): { ok: true; results: AckResult[] } | { ok: false; issues: AckIssue[] } {
  const refuse = (path: string, message: string) => ({ ok: false as const, issues: [{ path, message }] });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return refuse("results", "Send an object with one key, results.");
  }
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "results") || !Array.isArray(body.results)) {
    return refuse("results", "Send an object with one key, results.");
  }
  if (body.results.length === 0) return refuse("results", "Is empty.");
  if (body.results.length > MAX_ACK_RESULTS) {
    return refuse("results", `Holds more than ${MAX_ACK_RESULTS} results.`);
  }
  const results: AckResult[] = [];
  const seen = new Set<string>();
  for (const [index, item] of body.results.entries()) {
    const at = `results.${index}`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) return refuse(at, "Is not an object.");
    const row = item as Record<string, unknown>;
    if (Object.keys(row).some((key) => !ACK_KEYS.has(key))) return refuse(at, "Has a field the OS does not accept.");
    if (typeof row.id !== "string" || !ROW_ID.test(row.id)) return refuse(`${at}.id`, "Is not an outbox item's id.");
    if (seen.has(row.id)) return refuse(`${at}.id`, "Appears more than once in this ack.");
    seen.add(row.id);
    if (typeof row.revision !== "number" || !Number.isInteger(row.revision) || row.revision < 0) {
      return refuse(`${at}.revision`, "Is not the item's revision.");
    }
    if (typeof row.ok !== "boolean") return refuse(`${at}.ok`, "Is not true or false.");
    if (row.ok) {
      if (row.errorCode !== undefined) return refuse(`${at}.errorCode`, "A written item has no error code.");
      if (row.visibleId !== undefined && (typeof row.visibleId !== "string" || !VISIBLE_ID.test(row.visibleId))) {
        return refuse(`${at}.visibleId`, "Is not a Visible id (letters, digits, - and _).");
      }
    } else {
      if (row.visibleId !== undefined) return refuse(`${at}.visibleId`, "A failed item has no Visible id.");
      if (typeof row.errorCode !== "string" || !ERROR_CODE.test(row.errorCode)) {
        return refuse(`${at}.errorCode`, "A failed item needs a snake_case error code.");
      }
    }
    results.push({
      id: row.id,
      revision: row.revision,
      ok: row.ok,
      ...(typeof row.visibleId === "string" ? { visibleId: row.visibleId } : null),
      ...(typeof row.errorCode === "string" ? { errorCode: row.errorCode } : null),
    });
  }
  return { ok: true, results };
}

// ── Reading the queue ────────────────────────────────────────────────────

/** An investor's rows, newest first. */
export function syncRowsOf(ctx: QueryCtx, investorId: Id<"investors">, limit = MAX_SYNC_HISTORY) {
  return ctx.db
    .query("investorSync")
    .withIndex("by_investorId_and_queuedAt", (q) => q.eq("investorId", investorId))
    .order("desc")
    .take(limit);
}

/** What a card says about its sync: the row that matters most, or null. */
export type SyncSummary = { status: SyncStatus; errorCode: string | null; queuedAt: number };

const summaryOf = (row: Doc<"investorSync">): SyncSummary => ({
  status: row.status,
  errorCode: row.errorCode ?? null,
  queuedAt: row.queuedAt,
});

// A failure needs the owner (Retry), then what is still to go, then what is on its way.
const RANK: Record<SyncStatus, number> = { failed: 0, pending: 1, sent: 2, confirmed: 3 };

function better(a: Doc<"investorSync"> | undefined, b: Doc<"investorSync">) {
  if (a === undefined) return b;
  if (RANK[b.status] !== RANK[a.status]) return RANK[b.status] < RANK[a.status] ? b : a;
  return b.queuedAt > a.queuedAt ? b : a;
}

/** One investor's sync state, from its newest rows. */
export async function syncSummaryOf(ctx: QueryCtx, investorId: Id<"investors">): Promise<SyncSummary | null> {
  let best: Doc<"investorSync"> | undefined;
  for (const row of await syncRowsOf(ctx, investorId)) {
    if (row.status !== "confirmed") best = better(best, row);
  }
  return best === undefined ? null : summaryOf(best);
}

/** Every investor's sync state, for the board: three bounded reads, not one a card. */
export async function syncSummaries(ctx: QueryCtx): Promise<Map<Id<"investors">, SyncSummary>> {
  const best = new Map<Id<"investors">, Doc<"investorSync">>();
  for (const status of ["failed", "pending", "sent"] as const) {
    const rows = await ctx.db
      .query("investorSync")
      .withIndex("by_status_and_queuedAt", (q) => q.eq("status", status))
      .take(MAX_OPEN_READ);
    for (const row of rows) best.set(row.investorId, better(best.get(row.investorId), row));
  }
  return new Map([...best].map(([id, row]) => [id, summaryOf(row)]));
}

/** The row a new change merges into: the newest pending or failed one. */
async function openRowOf(ctx: QueryCtx, investorId: Id<"investors">) {
  return (await syncRowsOf(ctx, investorId)).find((row) => row.status === "pending" || row.status === "failed") ?? null;
}

// ── Writing the queue ────────────────────────────────────────────────────

/**
 * Queue a change of an investor for Visible. An investor made here is queued
 * whole as a `create` (Visible has never seen it); one of Visible's as an
 * `update` of what changed. A change merges into the investor's pending or
 * failed row, which goes (back) to pending with its revision bumped.
 * Anything else (a Kazakhstan deal is not an investor; an investor of another
 * source) queues nothing.
 */
export async function enqueueSync(
  ctx: MutationCtx,
  investor: Doc<"investors">,
  change: { fields: SyncFields; note: SyncNote | undefined },
  options: { by: string; now: number },
): Promise<void> {
  if (!syncsToVisible(investor)) return;
  const create = investor.source === NATIVE_SOURCE;
  // A create carries the card whole, as it is now.
  const fields: SyncFields = create
    ? { stage: investor.stage, name: investor.name, amount: investor.amount ?? null }
    : change.fields;
  const note = change.note;
  const open = await openRowOf(ctx, investor._id);
  const kind = create ? "create" : "update";
  if (!create && isEmpty(fields) && note === undefined) return;

  if (open !== null && open.kind === kind) {
    await ctx.db.patch(open._id, {
      fields: create ? fields : mergeFields(open.fields, fields),
      note: mergeNote(open.note, note),
      status: "pending",
      errorCode: undefined,
      revision: open.revision + 1,
      queuedAt: options.now,
      by: options.by,
    });
    return;
  }
  await ctx.db.insert("investorSync", {
    investorId: investor._id,
    kind,
    fields,
    ...(note === undefined ? null : { note }),
    status: "pending",
    revision: 0,
    attempts: 0,
    queuedAt: options.now,
    by: options.by,
  });
}

/** Queue whatever changed between two states of the same investor. */
export async function enqueueChange(
  ctx: MutationCtx,
  before: Doc<"investors">,
  after: Doc<"investors">,
  options: { by: string; now: number },
): Promise<void> {
  const change = changeOf(before, after);
  if (isEmpty(change.fields) && change.note === undefined) return;
  await enqueueSync(ctx, after, change, options);
}

/** A failed row back to pending, as Retry asks. False when nothing had failed. */
export async function retryFailed(ctx: MutationCtx, investorId: Id<"investors">, now: number): Promise<boolean> {
  const failed = (await syncRowsOf(ctx, investorId)).filter((row) => row.status === "failed");
  for (const row of failed) {
    await ctx.db.patch(row._id, { status: "pending", errorCode: undefined, revision: row.revision + 1, queuedAt: now });
  }
  return failed.length > 0;
}

// ── The pull ─────────────────────────────────────────────────────────────

const keepOsValue = (row: PipelineRow, investor: Doc<"investors">, field: SyncField): PipelineRow => {
  if (field === "stage") {
    return { ...row, stage: investor.stage, sourceStage: investor.sourceStage ?? row.sourceStage, closedAt: investor.closedAt };
  }
  if (field === "amount") return { ...row, amount: investor.amount };
  return { ...row, name: investor.name };
};

export type PullSyncCounts = { kept: number; confirmed: number; overridden: number };

/**
 * Before a Visible pull is applied: for each pulled investor with queued
 * changes,
 *   - a field still pending keeps the OS's value, unless Visible already
 *     holds the queued value, when the field is done;
 *   - a row already sent is settled: a field Visible holds as sent is
 *     confirmed, and one Visible holds differently was changed there since,
 *     so Visible's value wins and the card says so for seven days;
 *   - a pending row left with nothing to send is confirmed.
 * Returns the rows to apply. Also clears a "changed in Visible" flag older
 * than seven days and prunes confirmed rows older than thirty.
 */
export async function reconcilePull(
  ctx: MutationCtx,
  rows: readonly PipelineRow[],
  now: number,
): Promise<{ rows: PipelineRow[]; counts: PullSyncCounts }> {
  const counts: PullSyncCounts = { kept: 0, confirmed: 0, overridden: 0 };
  const out: PipelineRow[] = [];
  for (const pulled of rows) {
    const investor = await ctx.db
      .query("investors")
      .withIndex("by_source_and_externalId", (q) => q.eq("source", VISIBLE_SOURCE).eq("externalId", pulled.externalId))
      .unique();
    if (investor === null) {
      out.push(pulled);
      continue;
    }
    const open = (await syncRowsOf(ctx, investor._id)).filter((row) => row.status === "pending" || row.status === "sent");
    if (open.length === 0) {
      out.push(pulled);
      continue;
    }
    const pending = open.filter((row) => row.status === "pending");
    const sent = open.filter((row) => row.status === "sent");
    let next = pulled;
    let overridden = false;
    const remaining = new Map(pending.map((row) => [row._id, { ...row.fields }]));
    for (const field of SYNC_FIELDS) {
      const queuedIn = pending.filter((row) => row.fields[field] !== undefined);
      if (queuedIn.length > 0) {
        // The newest pending value is what Visible should end up with.
        if (sameSyncValue(field, pulled[field], queuedIn[0]!.fields[field])) {
          for (const row of queuedIn) delete remaining.get(row._id)![field];
        } else {
          next = keepOsValue(next, investor, field);
          counts.kept++;
        }
        continue;
      }
      const sentWith = sent.find((row) => row.fields[field] !== undefined);
      if (sentWith !== undefined && !sameSyncValue(field, pulled[field], sentWith.fields[field])) overridden = true;
    }
    for (const row of sent) {
      await ctx.db.patch(row._id, { status: "confirmed", confirmedAt: now });
      counts.confirmed++;
    }
    for (const row of pending) {
      const fields = remaining.get(row._id)!;
      if (isEmpty(fields) && row.note === undefined) {
        await ctx.db.patch(row._id, { fields, status: "confirmed", confirmedAt: now });
        counts.confirmed++;
      } else if (Object.keys(fields).length !== Object.keys(row.fields).length) {
        await ctx.db.patch(row._id, { fields });
      }
    }
    if (overridden) {
      await ctx.db.patch(investor._id, { changedInVisibleAt: now });
      counts.overridden++;
    }
    out.push(next);
  }

  // Housekeeping, bounded: the flag's seven days, the history's thirty.
  for (const investor of await ctx.db
    .query("investors")
    .withIndex("by_source_and_externalId", (q) => q.eq("source", VISIBLE_SOURCE))
    .collect()) {
    if (investor.changedInVisibleAt !== undefined && investor.changedInVisibleAt <= now - CHANGED_IN_VISIBLE_MS) {
      await ctx.db.patch(investor._id, { changedInVisibleAt: undefined });
    }
  }
  const old = await ctx.db
    .query("investorSync")
    .withIndex("by_status_and_queuedAt", (q) => q.eq("status", "confirmed").lt("queuedAt", now - CONFIRMED_KEPT_MS))
    .take(MAX_PRUNED);
  for (const row of old) await ctx.db.delete(row._id);

  return { rows: out, counts };
}
