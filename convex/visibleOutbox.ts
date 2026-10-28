// Visible write-back: the two routes the daily connector run uses to write
// the OS's queued investor changes to Visible (docs/ingest.md "Visible
// write-back", docs/setup.md "Visible").
//
//   GET  /ingest/v1/visible/outbox      the pending changes, oldest first, at
//                                       most 100: THIS IS A READ OF COMPANY DATA
//                                       BY A BEARER TOKEN (investor names, a
//                                       stage, an amount, a note's text), so it
//                                       is held to Visible's own token and
//                                       sends nothing but what Visible is to be
//                                       told.
//   POST /ingest/v1/visible/outbox/ack  what the run did with each item.
//
// Both take INGEST_TOKEN_VISIBLE and nothing else: any other source's token,
// a personal token or an agent token is the same 401. Nothing a request or a
// row holds is ever logged, thrown or sent back: a reply is counts, an error
// name, and paths with fixed words.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { httpAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { SOURCES, ingestToken } from "./connectors/manifest";
import { secretsEqual } from "./lib/constantTime";
import {
  MAX_ACK_BYTES,
  MAX_OUTBOX_ITEMS,
  OS_ERROR_CODES,
  VISIBLE_SOURCE,
  noteText,
  parseAck,
  type AckIssue,
  type SyncFields,
} from "./lib/investorSync";
import { NATIVE_SOURCE } from "./lib/pipelineRules";

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Null when the request carries Visible's token; the refusal otherwise. As
 * POST /ingest/v1 does it: 503 while the token is unset (or too short to be a
 * secret), then every configured source's token is compared in constant time
 * with no early exit, and one that two sources share authenticates neither.
 * Decided before anything of the request but its Authorization header is read.
 */
async function refusal(request: Request): Promise<Response | null> {
  if (ingestToken(VISIBLE_SOURCE) === undefined) {
    return json(503, { ok: false, error: "ingest_not_configured" });
  }
  const header = request.headers.get("Authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const matches: string[] = [];
  for (const source of SOURCES) {
    const token =
      source.kind === "ingest" || source.pushable === true ? ingestToken(source.id) : undefined;
    if (token !== undefined && (await secretsEqual(given, token))) matches.push(source.id);
  }
  return matches.length === 1 && matches[0] === VISIBLE_SOURCE
    ? null
    : json(401, { ok: false, error: "unauthorized" });
}

export type OutboxItem = {
  id: Id<"investorSync">;
  revision: number;
  kind: "create" | "update";
  /** Visible's id for an investor linked to it; absent for one to create. */
  investor: { externalId?: string; name: string };
  fields: SyncFields;
  /** The investor's stage here now, an OS stage key. */
  osStage: string;
  /** The note to write to Visible, when the next step or notes changed. */
  note?: string;
};

/** GET /ingest/v1/visible/outbox — what is waiting to be written to Visible. */
export const outboxV1 = httpAction(async (ctx, request) => {
  const refused = await refusal(request);
  if (refused !== null) return refused;
  try {
    const listed = await ctx.runQuery(internal.visibleOutbox.outbox, {});
    return json(200, { ok: true, ...listed });
  } catch {
    return json(500, { ok: false, error: "read_failed" });
  }
});

/**
 * The pending items, oldest first. An item for an investor that is gone, a
 * create for an archived investor (archiving is local: it is not created in
 * Visible while archived), and an update for an investor that is not linked
 * to Visible are skipped and stay pending.
 */
export const outbox = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("investorSync")
      .withIndex("by_status_and_queuedAt", (q) => q.eq("status", "pending"))
      .take(MAX_OUTBOX_ITEMS + 1);
    const items: OutboxItem[] = [];
    for (const row of rows.slice(0, MAX_OUTBOX_ITEMS)) {
      const investor = await ctx.db.get(row.investorId);
      if (investor === null) continue;
      if (row.kind === "create" && (investor.source !== NATIVE_SOURCE || investor.archivedAt !== undefined)) continue;
      if (row.kind === "update" && investor.source !== VISIBLE_SOURCE) continue;
      const note = noteText(row.note);
      items.push({
        id: row._id,
        revision: row.revision,
        kind: row.kind,
        investor: {
          ...(row.kind === "update" ? { externalId: investor.externalId } : null),
          name: investor.name,
        },
        fields: row.fields,
        osStage: investor.stage,
        ...(note === undefined ? null : { note }),
      });
    }
    return { items, truncated: rows.length > MAX_OUTBOX_ITEMS };
  },
});

/**
 * POST /ingest/v1/visible/outbox/ack — `{results: [{id, revision, ok,
 * visibleId?, errorCode?}]}`. After the token is accepted, a refusal is
 * logged against Visible in an error name, a path and fixed words.
 */
export const ackV1 = httpAction(async (ctx, request) => {
  const refused = await refusal(request);
  if (refused !== null) return refused;
  const startedAt = Date.now();

  const reject = async (status: number, error: string, issues: AckIssue[] = []) => {
    const first = issues[0];
    const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
    await ctx.runMutation(internal.snapshots.recordFailure, {
      source: VISIBLE_SOURCE,
      startedAt,
      status: "error",
      message: first ? `${error}: ${first.path} — ${first.message}${more}` : error,
    });
    return json(status, { ok: false, error, issues });
  };

  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_ACK_BYTES) {
    return reject(413, "payload_too_large");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_ACK_BYTES) return reject(413, "payload_too_large");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return reject(400, "invalid_json");
  }
  const parsed = parseAck(raw);
  if (!parsed.ok) return reject(422, "invalid_ack", parsed.issues);

  try {
    const counts = await ctx.runMutation(internal.visibleOutbox.ack, {
      results: parsed.results,
      now: startedAt,
    });
    return json(200, { ok: true, ...counts });
  } catch {
    // Not the error's own words.
    return reject(500, "write_failed");
  }
});

/**
 * The one writer of an ack. For each result, of a row that is still pending
 * (any other id is `unknown`, and nothing changes):
 *
 *   ok, create   the investor is linked: source "visible", externalId the
 *                Visible id, so the next replace pull matches it rather than
 *                adding it twice. No Visible id, or one another investor here
 *                already has, fails the row (`missing_visible_id`,
 *                `already_in_os`).
 *   ok, update   sent (confirmed at once when it carried only a note: a pull
 *                cannot see notes).
 *   not ok       failed, with the run's code.
 *
 * A result for an older revision than the row holds (it changed after the
 * outbox was read) is `stale`: a create still links, and the row stays
 * pending, so the newer values go with the next run.
 */
export const ack = internalMutation({
  args: {
    results: v.array(
      v.object({
        id: v.string(),
        revision: v.number(),
        ok: v.boolean(),
        visibleId: v.optional(v.string()),
        errorCode: v.optional(v.string()),
      }),
    ),
    now: v.number(),
  },
  handler: async (ctx, { results, now }) => {
    const counts = { sent: 0, confirmed: 0, failed: 0, stale: 0, unknown: 0 };
    for (const result of results) {
      const id = ctx.db.normalizeId("investorSync", result.id);
      const row = id === null ? null : await ctx.db.get(id);
      const investor = row === null ? null : await ctx.db.get(row.investorId);
      if (row === null || row.status !== "pending" || investor === null) {
        counts.unknown++;
        continue;
      }
      const stale = result.revision !== row.revision;
      const attempts = row.attempts + 1;
      const fail = async (errorCode: string) => {
        await ctx.db.patch(row._id, { status: "failed", errorCode, attempts });
        counts.failed++;
      };

      if (!result.ok) {
        if (stale) {
          await ctx.db.patch(row._id, { attempts });
          counts.stale++;
        } else {
          await fail(result.errorCode!);
        }
        continue;
      }

      if (row.kind === "create") {
        if (result.visibleId === undefined) {
          await fail(OS_ERROR_CODES.missingVisibleId);
          continue;
        }
        const visibleId = result.visibleId;
        const clash = await ctx.db
          .query("investors")
          .withIndex("by_source_and_externalId", (q) => q.eq("source", VISIBLE_SOURCE).eq("externalId", visibleId))
          .unique();
        if (clash !== null && clash._id !== investor._id) {
          await fail(OS_ERROR_CODES.alreadyInOs);
          continue;
        }
        await ctx.db.patch(investor._id, { source: VISIBLE_SOURCE, externalId: visibleId });
        if (stale) {
          // Visible has the investor now; what changed since goes as an update.
          await ctx.db.patch(row._id, { kind: "update", attempts });
          counts.stale++;
          continue;
        }
        await sent(ctx, row, attempts, now);
        counts.sent++;
        continue;
      }

      if (stale) {
        await ctx.db.patch(row._id, { attempts });
        counts.stale++;
        continue;
      }
      const onlyNote = Object.values(row.fields).every((value) => value === undefined);
      if (onlyNote) {
        await ctx.db.patch(row._id, { status: "confirmed", sentAt: now, confirmedAt: now, attempts, errorCode: undefined });
        counts.confirmed++;
      } else {
        await sent(ctx, row, attempts, now);
        counts.sent++;
      }
    }
    return counts;
  },
});

async function sent(
  ctx: MutationCtx,
  row: Doc<"investorSync">,
  attempts: number,
  now: number,
) {
  await ctx.db.patch(row._id, { status: "sent", sentAt: now, attempts, errorCode: undefined });
}
