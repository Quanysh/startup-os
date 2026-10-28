// The only writers of mirrorRecords. A run's rows, its log entry and the
// source's status land in one transaction. The log entry holds counts.
//
// Three doors, one write (`writeRows`). `apply` writes the deployment owner's
// rows (no `owner`): a read made here, or a push on a source's own token.
// `applyPersonal` writes one teammate's rows, from a push on their personal
// token; it touches no row but theirs, and neither the run log nor the
// deployment's `sourceStatus`, which the owner reads. `applyShared` writes one
// of Apollo's shared lists (the team's, no `owner`) and can be handed nothing
// else: its validators and the other two doors' do not overlap.
//
// Two retentions as well, each its own scheduled mutation: `prune` for what
// is the deployment's, `prunePersonal` for what is a teammate's.

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { hasOwner } from "./authOwner";
import { PRODUCT } from "./lib/identity";
import { MAX_RUN_MESSAGE_LENGTH } from "./lib/limits";
import {
  GOOGLE_SOURCES,
  KIND_OF,
  MEETING_NOTE_DAYS,
  MIRROR_SOURCES,
  REPLACES,
  keyOf,
  refusal,
  type MirrorRecord,
  type MirrorSource,
  type SharedKind,
  type SharedSource,
} from "./lib/mirrorRules";
import {
  mirrorSourceValidator,
  recordValidator,
  sharedKindValidator,
  sharedRecordValidator,
  sharedSourceValidator,
} from "./lib/mirrorValidators";
import {
  NOT_THIS_SOURCES_KIND,
  sharedKeyOf,
  sharedKindOf,
  sharedRefusal,
  type SharedRecord,
} from "./lib/sharedRecords";
import {
  deleteHeld,
  forgetPerson,
  holderKey,
  isHeldBy,
  mayHold,
  patchPersonalStatus,
  tokenHolder,
  type Holder,
} from "./lib/personal";
import { PERSONAL_BYTES, PERSONAL_CAPS, storedBytes } from "./lib/personalRules";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A source not read successfully for this long loses what it stored. */
export const DEAD_SOURCE_DAYS = 30;
const PRUNE_BATCH = 500;

export const TURNED_OFF_MESSAGE = "Turned off under Settings → Work tools.";
export const CONNECT_GOOGLE_MESSAGE = "Connect Google under Settings → Work tools.";
/** The grant died at Google (access removed there, or expired): what was read with it is gone. */
export const GOOGLE_REMOVED_MESSAGE = "Google access was removed. Connect Google again.";
/** Disconnected here, but Google never confirmed the grant was revoked. */
export const REVOKE_UNCONFIRMED_MESSAGE =
  `Google could not confirm that access was removed. Remove "${PRODUCT.name}" in your Google Account's third-party access page.`;
/**
 * Reasons that say more than "not connected". The scheduled reads only know
 * that there is no grant, and must not overwrite one of these with that.
 */
const KEPT_OVER_NOT_CONNECTED: readonly string[] = [
  GOOGLE_REMOVED_MESSAGE,
  REVOKE_UNCONFIRMED_MESSAGE,
];

const statusRow = (ctx: MutationCtx, source: string) =>
  ctx.db
    .query("sourceStatus")
    .withIndex("by_source", (q) => q.eq("source", source))
    .unique();

// The same shape snapshots.ts keeps for metric sources (its helper is private).
async function setStatus(
  ctx: MutationCtx,
  source: string,
  update: { state: "ok" | "not_configured"; message?: string; at: number; forget?: boolean },
) {
  const existing = await statusRow(ctx, source);
  const next = {
    source,
    state: update.state,
    message: update.message,
    lastRunAt: update.at,
    // `forget` is for the moment the records themselves are deleted: a page
    // must not go on saying "read an hour ago" over a list that is gone.
    lastOkAt:
      update.state === "ok" ? update.at : update.forget ? undefined : existing?.lastOkAt,
  };
  if (existing === null) await ctx.db.insert("sourceStatus", next);
  else await ctx.db.replace(existing._id, next);
}

/**
 * Delete everything the OS mirrored from one source for the deployment owner
 * (the rows with no `owner`). A teammate's own rows of the same tool are not
 * the owner's to delete and are left alone. Returns how many records went.
 */
export async function deleteRecords(ctx: MutationCtx, source: MirrorSource): Promise<number> {
  return await deleteHeld(ctx, { kind: "owner" }, source);
}

/**
 * The one write of mirrored records, for one holder's rows of one source and
 * no others: the stored rows are read by `owner` first, so a row of anybody
 * else is never matched, changed or removed, whatever ids the batch holds.
 *
 * A teammate's rows also carry the person (`userId`). A row found under the
 * address that some other identity sent is not matched or updated: it is
 * deleted here, so nothing an earlier holder of the address left stays on.
 */
async function writeRows(
  ctx: MutationCtx,
  holder: Holder,
  source: MirrorSource | SharedSource,
  rows: readonly Keyed[],
  now: number,
  options: {
    /** True where the rows are the whole current set: a stored row they do not name is removed. */
    replace: boolean;
    /**
     * For a source that holds several lists (Apollo): the one kind this write
     * is about. Stored rows of another kind are neither matched nor removed.
     */
    only?: SharedKind;
    /**
     * Stamp an unchanged row with this write's time too, so every row of a
     * list says when the list was last pushed (it is still counted unchanged).
     */
    touch?: boolean;
  },
) {
  const owner = holderKey(holder);
  const stored = await ctx.db
    .query("mirrorRecords")
    .withIndex("by_owner_and_source_and_externalId", (q) => q.eq("owner", owner).eq("source", source))
    .collect();
  const left = new Map<string, (typeof stored)[number]>();
  for (const doc of stored) {
    // A row under this address that is not this person's is nobody's: it goes.
    if (!isHeldBy(holder, doc)) {
      await ctx.db.delete(doc._id);
      continue;
    }
    if (options.only === undefined || doc.record.kind === options.only) {
      left.set(doc.externalId, doc);
    }
  }

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  for (const { externalId, sortAt, record } of rows) {
    const existing = left.get(externalId);
    left.delete(externalId);
    if (existing === undefined) {
      await ctx.db.insert("mirrorRecords", {
        ...(holder.kind === "owner" ? {} : { owner: holder.email, userId: holder.userId }),
        source,
        externalId,
        sortAt,
        syncedAt: now,
        record,
      });
      inserted += 1;
    } else if (JSON.stringify(existing.record) !== JSON.stringify(record)) {
      await ctx.db.patch(existing._id, { sortAt, syncedAt: now, record });
      updated += 1;
    } else {
      if (options.touch) await ctx.db.patch(existing._id, { syncedAt: now });
      unchanged += 1;
    }
  }
  if (options.replace) for (const gone of left.values()) await ctx.db.delete(gone._id);
  return { inserted, updated, unchanged };
}

/** A record with the key it is matched on and what its list is ordered by. */
type Keyed = { externalId: string; sortAt: number; record: MirrorRecord | SharedRecord };

/** A work tool's rows keyed, and whether a read of that tool is its whole set. */
const toolRows = (source: MirrorSource, rows: readonly MirrorRecord[]) => ({
  keyed: rows.map((record) => ({ ...keyOf(record), record })),
  options: { replace: REPLACES[KIND_OF[source]] },
});

/**
 * Record that a source cannot run (no key, not connected, switched off)
 * without adding to the run log: these sources are asked every few minutes,
 * and a setup step is not an event worth a row each time. With `forget`, the
 * time of the last good read is cleared too (its records were just deleted).
 */
export async function markNotConfigured(
  ctx: MutationCtx,
  source: MirrorSource,
  text: string,
  options: { forget?: boolean } = {},
): Promise<void> {
  const message = text.slice(0, MAX_RUN_MESSAGE_LENGTH);
  const existing = await statusRow(ctx, source);
  if (
    existing?.state === "not_configured" &&
    existing.message === message &&
    !(options.forget && existing.lastOkAt !== undefined)
  ) {
    return;
  }
  await setStatus(ctx, source, {
    state: "not_configured",
    message,
    at: Date.now(),
    forget: options.forget,
  });
}

/**
 * Whether a write for this source may land right now. For a Google source the
 * read must have begun under the grant that is stored now (`grantAt` is that
 * grant's `connectedAt`): after "disconnect, then connect again" a read still
 * in flight belongs to the old grant, perhaps to another mailbox.
 */
async function mayWrite(
  ctx: MutationCtx,
  source: MirrorSource,
  grantAt: number | undefined,
): Promise<boolean> {
  const settings = await ctx.db.query("workToolSettings").first();
  if (settings?.off.includes(source)) return false;
  if (!GOOGLE_SOURCES.includes(source)) return true;
  // When it was made, and nothing else: the grant itself is read in
  // convex/google.ts and nowhere else.
  const grant = await ctx.db
    .query("oauthConnections")
    .withIndex("by_provider", (q) => q.eq("provider", "google"))
    .first();
  return grant !== null && grantAt !== undefined && grant.connectedAt === grantAt;
}

/** Whether the owner switched this source off. The one check a pushed write and a pulled one share. */
async function switchedOff(ctx: MutationCtx, source: MirrorSource): Promise<boolean> {
  const settings = await ctx.db.query("workToolSettings").first();
  return settings?.off.includes(source) === true;
}

export const apply = internalMutation({
  args: {
    source: mirrorSourceValidator,
    startedAt: v.number(),
    rows: v.array(recordValidator),
    /** For a Google source: the `connectedAt` of the grant the read began under. */
    grantAt: v.optional(v.number()),
    /**
     * True when the rows arrived through POST /ingest/v1 (`records`) rather
     * than a read made here. Such a write needs no Google grant, because the
     * pushing session read the source through its own connector; the off
     * switch holds for it all the same.
     */
    pushed: v.optional(v.boolean()),
  },
  handler: async (ctx, { source, startedAt, rows, grantAt, pushed }) => {
    // The runner checks first so it can log the refusal; this is the guard
    // that holds whoever calls.
    const refused = refusal(source, rows);
    if (refused !== null) throw new ConvexError(refused);

    // "Turn off and delete" or "Disconnect and delete" may land while a read
    // is in flight. What that read brings back is dropped, not stored again.
    const open =
      pushed === true ? !(await switchedOff(ctx, source)) : await mayWrite(ctx, source, grantAt);
    if (!open) return null;

    const now = Date.now();
    const { keyed, options } = toolRows(source, rows);
    const { inserted, updated, unchanged } = await writeRows(
      ctx,
      { kind: "owner" },
      source,
      keyed,
      now,
      options,
    );

    await ctx.db.insert("syncRuns", {
      source,
      startedAt,
      finishedAt: now,
      status: "ok",
      inserted,
      updated,
      unchanged,
    });
    await setStatus(ctx, source, { state: "ok", at: now });
    return { inserted, updated, unchanged };
  },
});

/**
 * One of a shared source's lists (Apollo's sequences, or its contacts and
 * accounts by stage; GitHub's repositories), pushed with that source's own
 * token. The team's list, stored with no `owner`.
 *
 * The third door to the one write, and the narrowest: its validators take the
 * shared sources and the shared kinds and nothing else, so it cannot be
 * handed a work tool's source or a mail, an event, an issue or a meeting; and
 * `apply` / `applyPersonal` cannot be handed these. A push is the whole of
 * one kind: stored rows of that kind it does not name are removed, and rows
 * of the other kind, like every other source's and every person's, are not
 * read at all (`only`).
 *
 * The run log gets counts. No off switch and no grant apply: this is not a
 * work tool.
 */
export const applyShared = internalMutation({
  args: {
    source: sharedSourceValidator,
    kind: sharedKindValidator,
    startedAt: v.number(),
    rows: v.array(sharedRecordValidator),
  },
  handler: async (ctx, { source, kind, startedAt, rows }) => {
    // The endpoint checks first so it can log the refusal in paths; these are
    // the guards that hold whoever calls. Each source writes its own lists
    // only: a sequence is Apollo's, a repository GitHub's.
    if (!sharedKindOf(source, kind)) throw new ConvexError(NOT_THIS_SOURCES_KIND);
    const refused = sharedRefusal(kind, rows);
    if (refused !== null) throw new ConvexError(refused);

    const now = Date.now();
    const counts = await writeRows(
      ctx,
      { kind: "owner" },
      source,
      rows.map((record) => ({ ...sharedKeyOf(record), record })),
      now,
      { replace: true, only: kind, touch: true },
    );
    await ctx.db.insert("syncRuns", {
      source,
      startedAt,
      finishedAt: now,
      status: "ok",
      ...counts,
    });
    await setStatus(ctx, source, { state: "ok", at: now });
    return counts;
  },
});

/**
 * A teammate's own records, pushed with their personal token. The token is
 * looked up again here, in the transaction that writes: a push that began
 * before "Revoke", before the teammate was removed, before their Today
 * area was taken away or before their address passed to another identity
 * is refused when it lands, so nothing is stored after the delete. Only
 * that person's rows are touched; no run-log row is written, and the
 * deployment's `sourceStatus` is left as it was.
 *
 * The owner's switches (`workToolSettings.off`) and the Google grant are the
 * owner's own tools' and play no part here.
 */
export const applyPersonal = internalMutation({
  args: {
    /** SHA-256 of the bearer token. The token itself never reaches a function. */
    tokenHash: v.string(),
    source: mirrorSourceValidator,
    rows: v.array(recordValidator),
  },
  handler: async (ctx, { tokenHash, source, rows }) => {
    const refused = refusal(source, rows);
    if (refused !== null) throw new ConvexError(refused);

    const known = await tokenHolder(ctx, tokenHash);
    if (known === null) return { ok: false as const, reason: "unauthorized" as const };
    const { token, holder } = known;

    // One person's caps: how many, and how much. Where a tool accumulates
    // (meeting notes), what is held already counts too, except a note this
    // push sends again, which it replaces.
    const sizeOf = (row: MirrorRecord) => storedBytes(holder.email, keyOf(row).externalId, row);
    let held = rows.length;
    let bytes = rows.reduce((sum, row) => sum + sizeOf(row), 0);
    if (!REPLACES[KIND_OF[source]]) {
      const ids = new Set(rows.map((row) => keyOf(row).externalId));
      const stored = await ctx.db
        .query("mirrorRecords")
        .withIndex("by_owner_and_source_and_externalId", (q) =>
          q.eq("owner", holder.email).eq("source", source),
        )
        .collect();
      // What another identity left under the address is deleted by the write.
      for (const doc of stored) {
        if (!isHeldBy(holder, doc)) continue;
        // A work tool's rows hold only that tool's records, never Apollo's shared lists.
        if (!ids.has(doc.externalId)) bytes += sizeOf(doc.record as MirrorRecord);
        ids.add(doc.externalId);
      }
      held = ids.size;
    }
    if (held > PERSONAL_CAPS[source]) return { ok: false as const, reason: "too_many" as const };
    if (bytes > PERSONAL_BYTES[source]) return { ok: false as const, reason: "too_much" as const };

    const now = Date.now();
    const { keyed, options } = toolRows(source, rows);
    const counts = await writeRows(ctx, holder, source, keyed, now, options);
    await patchPersonalStatus(ctx, holder, source, {
      state: "ok",
      message: undefined,
      lastRunAt: now,
      lastOkAt: now,
    });
    await ctx.db.patch(token._id, { lastUsedAt: now });
    return { ok: true as const, ...counts };
  },
});

/** The runner's way to say a source cannot run. What is stored stays; so does its last good read. */
export const noteNotConfigured = internalMutation({
  args: { source: mirrorSourceValidator, message: v.string() },
  handler: async (ctx, args) => {
    if (args.message === CONNECT_GOOGLE_MESSAGE) {
      const existing = await statusRow(ctx, args.source);
      if (
        existing?.state === "not_configured" &&
        KEPT_OVER_NOT_CONNECTED.includes(existing.message ?? "")
      ) {
        return null;
      }
    }
    await markNotConfigured(ctx, args.source, args.message, { forget: false });
    return null;
  },
});

/**
 * Retention for what the deployment itself stores: the owner's mirrored
 * records and expired "Connect Google" attempts. Runs daily.
 *
 * It reads and deletes nothing of a teammate's. That is `prunePersonal`, a
 * mutation of its own on a schedule of its own, so that however much is
 * waiting there, and whatever happens to it, this one is done: neither can
 * roll the other back.
 */
export const prune = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let removed = 0;

    for (const source of MIRROR_SOURCES) {
      const status = await statusRow(ctx, source);
      if ((status?.lastOkAt ?? 0) < now - DEAD_SOURCE_DAYS * DAY_MS) {
        removed += await deleteRecords(ctx, source);
        // Nothing is stored any more, so there is no "last read" to show.
        if (status !== null && status.lastOkAt !== undefined) {
          await ctx.db.patch(status._id, { lastOkAt: undefined });
        }
      }
    }

    const oldNotes = await ctx.db
      .query("mirrorRecords")
      .withIndex("by_owner_and_source_and_sortAt", (q) =>
        q
          .eq("owner", undefined)
          .eq("source", "fireflies")
          .lt("sortAt", now - MEETING_NOTE_DAYS * DAY_MS),
      )
      .take(PRUNE_BATCH);
    for (const note of oldNotes) await ctx.db.delete(note._id);
    removed += oldNotes.length;

    const expired = await ctx.db
      .query("oauthStates")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(PRUNE_BATCH);
    for (const state of expired) await ctx.db.delete(state._id);

    return removed;
  },
});

// ── Retention for teammates' own records ───────────────────────────────────

/**
 * What one run of `prunePersonal` may do before it stops and asks for
 * another. A Convex transaction may write 16,000 documents, scan 32,000 and
 * read 16 MiB; many people's records going stale on one day must not take a
 * run past that, or it would fail the same way every day after.
 *   - `people`: addresses a run looks at;
 *   - `docs`: documents it deletes;
 *   - `bytes`: what it has read of the records it deletes (their JSON, in
 *     UTF-8), checked after each batch of `PERSONAL_PRUNE_BATCH`.
 * With these a run reads at most `bytes` and one batch more: about 12 MiB if
 * every record were as large as a record can be and written in three-byte
 * characters throughout, and far less in practice.
 */
export const PERSONAL_PRUNE_BUDGET = { people: 10, docs: 2000, bytes: 6_000_000 } as const;
/** Records read and deleted between two looks at the budget. */
const PERSONAL_PRUNE_BATCH = 50;
/** Token or status rows read at a time while looking for the next person. */
const PERSONAL_PRUNE_PAGE = 50;

const pruneBudget = v.object({ people: v.number(), docs: v.number(), bytes: v.number() });
/**
 * Where a sweep has got to: which of the two tables it is walking, and the
 * creation time of the last row it finished with. Numbers only: it is stored
 * with the scheduled run, where an address must never be.
 */
const pruneCursor = v.object({
  table: v.union(v.literal("tokens"), v.literal("status")),
  after: v.number(),
});

/**
 * Retention for teammates' own records, within a budget. Runs daily, and
 * again at once (`ctx.scheduler.runAfter(0, …)`) for as long as a run stops
 * with more to do.
 *
 * It walks the token rows and then the status rows, oldest first. Everyone
 * who holds anything has a status row (the write that stores a record makes
 * one in the same transaction). For each row:
 *   - a person who may no longer hold anything loses all of it: someone off
 *     the team or without the Today area (`team.remove` and `team.update`
 *     already delete on the spot; this is the same delete for a way out that
 *     went round them, such as an address moved into OWNER_EMAILS or a row
 *     edited by hand), and an address that is no longer the `users` row the
 *     rows are about. This is asked only while there is an owner: with
 *     OWNER_EMAILS unset or empty nobody is let in and every push is refused,
 *     but that is a lock-out the owner undoes by setting it again. It says
 *     nothing about who is on the team, so it deletes nobody's;
 *   - otherwise the two rules the owner's records age by, judged on the
 *     person's own last good push: a tool with none for 30 days loses what it
 *     held, and meeting notes go 90 days after the meeting.
 *
 * A row is only left behind once everything it stands for is done: a person's
 * records go before their token and status rows, and a tool's "last
 * received" is cleared with the last of its records. So a run that stops in
 * the middle is taken up from the same row by the next, and nothing is lost
 * track of.
 */
export const prunePersonal = internalMutation({
  args: { cursor: v.optional(pruneCursor), budget: v.optional(pruneBudget) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const given = args.budget ?? PERSONAL_PRUNE_BUDGET;
    // At least one of each, so every run that stops has moved on or deleted.
    const budget = {
      people: Math.max(1, Math.floor(given.people)),
      docs: Math.max(1, Math.floor(given.docs)),
      bytes: Math.max(1, given.bytes),
    };
    const judged = hasOwner();
    const encoder = new TextEncoder();
    const seen = new Set<string>();
    let docs = 0;
    let bytes = 0;
    let removed = 0;
    const spent = () => docs >= budget.docs || bytes >= budget.bytes;

    type Row = Doc<"mirrorRecords">;
    /** Delete what `next` keeps returning, a batch at a time. False if the budget ran out first. */
    const drain = async (next: (limit: number) => Promise<Row[]>): Promise<boolean> => {
      for (;;) {
        if (spent()) return false;
        const limit = Math.min(PERSONAL_PRUNE_BATCH, budget.docs - docs);
        const rows = await next(limit);
        for (const row of rows) {
          bytes += encoder.encode(JSON.stringify(row)).length;
          await ctx.db.delete(row._id);
        }
        docs += rows.length;
        removed += rows.length;
        if (rows.length < limit) return true;
      }
    };
    const heldOf = (owner: string, source: MirrorSource) => (limit: number) =>
      ctx.db
        .query("mirrorRecords")
        .withIndex("by_owner_and_source_and_externalId", (q) =>
          q.eq("owner", owner).eq("source", source),
        )
        .take(limit);
    const oldNotesOf = (owner: string) => (limit: number) =>
      ctx.db
        .query("mirrorRecords")
        .withIndex("by_owner_and_source_and_sortAt", (q) =>
          q
            .eq("owner", owner)
            .eq("source", "fireflies")
            .lt("sortAt", now - MEETING_NOTE_DAYS * DAY_MS),
        )
        .take(limit);

    /** Everything under an address: the records first, and the rows that led here only after. */
    const forget = async (owner: string): Promise<boolean> => {
      for (const source of MIRROR_SOURCES) {
        if (!(await drain(heldOf(owner, source)))) return false;
      }
      // Nothing is left to read: the token and the status rows, a handful.
      await forgetPerson(ctx, owner);
      docs += 1 + MIRROR_SOURCES.length;
      return true;
    };
    const forgotten = new Set<string>();

    /** One token or status row dealt with. False if the budget ran out before it was. */
    const deal = async (
      row: Doc<"personalTokens"> | Doc<"personalSourceStatus">,
    ): Promise<boolean> => {
      if (forgotten.has(row.owner)) return true;
      if (judged && !(await mayHold(ctx.db, row.owner, row.userId))) {
        if (!(await forget(row.owner))) return false;
        forgotten.add(row.owner);
        return true;
      }
      if (!("source" in row)) return true;
      if ((row.lastOkAt ?? 0) < now - DEAD_SOURCE_DAYS * DAY_MS) {
        if (!(await drain(heldOf(row.owner, row.source)))) return false;
        // Nothing is stored any more, so there is no "last received" to show.
        if (row.lastOkAt !== undefined) await ctx.db.patch(row._id, { lastOkAt: undefined });
        return true;
      }
      if (row.source === "fireflies") return await drain(oldNotesOf(row.owner));
      return true;
    };

    let cursor = args.cursor ?? { table: "tokens" as const, after: 0 };
    const again = async () => {
      await ctx.scheduler.runAfter(0, internal.mirror.prunePersonal, {
        cursor,
        budget: args.budget,
      });
      return { removed, more: true };
    };
    for (;;) {
      const after = cursor.after;
      const page =
        cursor.table === "tokens"
          ? await ctx.db
              .query("personalTokens")
              .withIndex("by_creation_time", (q) => q.gt("_creationTime", after))
              .take(PERSONAL_PRUNE_PAGE)
          : await ctx.db
              .query("personalSourceStatus")
              .withIndex("by_creation_time", (q) => q.gt("_creationTime", after))
              .take(PERSONAL_PRUNE_PAGE);
      if (page.length === 0) {
        if (cursor.table === "status") return { removed, more: false };
        cursor = { table: "status", after: 0 };
        continue;
      }
      for (const row of page) {
        if (!seen.has(row.owner)) {
          if (seen.size >= budget.people) return await again();
          seen.add(row.owner);
        }
        if (!(await deal(row))) return await again();
        cursor = { table: cursor.table, after: row._creationTime };
        if (spent()) return await again();
      }
    }
  },
});
