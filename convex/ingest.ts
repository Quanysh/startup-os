import { internal } from "./_generated/api";
import { httpAction, type ActionCtx } from "./_generated/server";
import { SOURCES, feedOf, ingestToken } from "./connectors/manifest";
import { secretsEqual } from "./lib/constantTime";
import { customerRowProblems } from "./lib/customerRules";
import { sourceOn } from "./lib/featureGates";
import { agentPushProblems } from "./lib/agentShape";
import {
  CONTACT_PUSH_SCOPES,
  CONTACT_PUSH_WORDS,
  isContactPushSource,
  parseContactPush,
  type ContactPushSource,
} from "./lib/contactPush";
import {
  MAX_INGEST_BYTES,
  isAgentsEnvelope,
  isContactsEnvelope,
  isCustomersEnvelope,
  isPlanEnvelope,
  isRecordsEnvelope,
  parseIngestEnvelope,
  type ContactsEnvelope,
} from "./lib/ingestSchema";
import { MIRROR_SOURCES, isSharedSource, type MirrorSource } from "./lib/mirrorRules";
import {
  NOT_A_PERSONAL_TOOL_WORDS,
  RECORDS_ONLY_WORDS,
  TOO_MANY_PUSHES,
  TOO_MANY_PUSHES_WORDS,
  TOO_MANY_RECORDS,
  TOO_MUCH_DATA,
  hashToken,
  isPersonalToken,
  tooManyRecordsWords,
  tooMuchDataWords,
} from "./lib/personalRules";
import { checkPipelineRows, ownsAPipeline } from "./lib/pipelineRules";
import { planProblems } from "./lib/planRules";
import { pushedSnapshotProblems } from "./lib/pushRules";
import { parsePushedRecords } from "./lib/recordRows";
import { parseSharedRecords } from "./lib/sharedRecords";
import { parseSupportPush } from "./lib/supportRecords";
import { validateSnapshots } from "./lib/snapshotRules";

type Issue = { path: string; message: string };

const SNAPSHOT_REFUSED = "Is refused. Send the snapshots on their own to read why.";

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * A push on a teammate's personal token ("Connect your Claude"): their own
 * mail, calendar, meeting notes or assigned issues, and nothing else.
 *
 * The token names a person, not a source, so the envelope's `source` says
 * which of the four tools this is. The person must be a teammate with the
 * Today area at this moment: that is asked when the request arrives and
 * again inside each write, so a token revoked, or a teammate removed, while
 * a push is in flight stores nothing.
 *
 * What is different from a source's own token, on purpose:
 *   - nothing is written to the run log or to `sourceStatus`. Those are the
 *     deployment's and the owner reads them; that a teammate pushed, and how
 *     it went, is said on that teammate's own status row and nowhere else;
 *   - the owner's switches and the "pulled or pushed" rule do not apply:
 *     they are about the owner's own tools;
 *   - rows are stored with `owner` set to the person, and the write reads
 *     and replaces that person's rows only.
 * What is the same: the rows pass the same cleaners and the same `refusal`
 * (`parsePushedRecords`), and every reply is an error name, paths and fixed
 * words. No reply holds the token, an address or anything a record says.
 */
async function personalPush(ctx: ActionCtx, request: Request, given: string): Promise<Response> {
  const unauthorized = () => json(401, { ok: false, error: "unauthorized" });
  // Only the hash goes any further. Hashed and looked up whatever was given,
  // so a malformed token costs what a well-formed unknown one does.
  const tokenHash = await hashToken(given);
  const known = await ctx.runQuery(internal.connect.knows, { tokenHash });
  if (!known) return unauthorized();

  const refused = (status: number, error: string, issues: Issue[] = []) =>
    json(status, { ok: false, error, issues });

  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_INGEST_BYTES) {
    return refused(413, "payload_too_large");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_INGEST_BYTES) {
    return refused(413, "payload_too_large");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return refused(400, "invalid_json");
  }

  // A personal token carries names by its nature: fixed words for every issue.
  const parsed = parseIngestEnvelope(raw, { carriesNames: true });
  if (!parsed.ok) return refused(422, "invalid_envelope", parsed.issues);
  const { envelope } = parsed;

  // Records and nothing else: no number, no pipeline, no register, no plan.
  if (!isRecordsEnvelope(envelope)) {
    return refused(422, "records_only", [{ path: "envelope", message: RECORDS_ONLY_WORDS }]);
  }
  // One of the four work tools. The sender's own `source` is never quoted back.
  const source = (MIRROR_SOURCES as readonly string[]).includes(envelope.source)
    ? (envelope.source as MirrorSource)
    : null;
  if (source === null) {
    return refused(422, "records_not_accepted", [
      { path: "source", message: NOT_A_PERSONAL_TOOL_WORDS },
    ]);
  }

  const admitted = await ctx.runMutation(internal.connect.admit, { tokenHash, source });
  if (admitted === "unauthorized") return unauthorized();
  if (admitted === "limited") {
    return refused(429, TOO_MANY_PUSHES, [{ path: "records", message: TOO_MANY_PUSHES_WORDS }]);
  }

  // From here the tool is known, so a refusal is noted for the person to see.
  const reject = async (status: number, error: string, issues: Issue[] = []) => {
    const first = issues[0];
    const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
    await ctx.runMutation(internal.connect.noteRefused, {
      tokenHash,
      source,
      message: first ? `${error}: ${first.path} — ${first.message}${more}` : error,
    });
    return refused(status, error, issues);
  };

  const read = parsePushedRecords(source, envelope.records, {
    empty: envelope.empty === true,
    now: Date.now(),
  });
  if (!read.ok) return reject(422, "invalid_records", read.issues);

  let written;
  try {
    written = await ctx.runMutation(internal.mirror.applyPersonal, {
      tokenHash,
      source,
      rows: read.rows,
    });
  } catch {
    // Not the error's own words: nothing thrown while records are in hand is repeated.
    return reject(500, "write_failed");
  }
  if (!written.ok) {
    if (written.reason === "unauthorized") return unauthorized();
    // More bytes than one person may hold of this tool (also the write's to keep).
    if (written.reason === "too_much") {
      return reject(422, TOO_MUCH_DATA, [{ path: "records", message: tooMuchDataWords(source) }]);
    }
    // More than one person may hold of this tool (the cap is the write's to keep).
    return reject(422, TOO_MANY_RECORDS, [
      { path: "records", message: tooManyRecordsWords(source) },
    ]);
  }
  const { ok: _ok, ...counts } = written;
  return json(200, { ok: true, ...counts });
}

/**
 * A `contacts` push on a source's own token (convex/lib/contactPush.ts):
 * checked whole first, so one bad row writes nothing, then written in slices
 * (`CONTACT_PUSH_SLICE` rows a transaction) through `contacts.applyPush`, the
 * one writer of pushed people. Upserted only, so a slice that fails leaves
 * nothing a resend will not set right. Its run and status are the push's own
 * status source (`visible_contacts` and the rest), never the carrier's, and
 * hold counts and fixed words only: no name, address, phone or id, and not
 * the sender's `batchId`.
 */
async function contactsPush(
  ctx: ActionCtx,
  source: ContactPushSource,
  envelope: ContactsEnvelope,
  startedAt: number,
): Promise<Response> {
  const status = CONTACT_PUSH_SCOPES[source].status;
  const reject = async (code: number, error: string, issues: Issue[] = []) => {
    const first = issues[0];
    const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
    await ctx.runMutation(internal.snapshots.recordFailure, {
      source: status,
      startedAt,
      status: "error",
      message: first ? `${error}: ${first.path} — ${first.message}${more}` : error,
    });
    return json(code, { ok: false, error, issues });
  };
  const read = parseContactPush(source, envelope.contacts, startedAt);
  if (!read.ok) return reject(422, "invalid_contacts", read.issues);

  const totals = { inserted: 0, updated: 0, unchanged: 0, linked: 0, skipped: 0, excluded: read.excluded, dropped: read.dropped };
  try {
    for (let at = 0; at < read.rows.length; at += CONTACT_PUSH_SLICE) {
      const counts = await ctx.runMutation(internal.contacts.applyPush, {
        source,
        now: startedAt,
        rows: read.rows.slice(at, at + CONTACT_PUSH_SLICE),
      });
      // Switched off under Settings › Work tools: nothing is stored or logged.
      if (counts === null) return json(409, { ok: false, error: "source_turned_off" });
      for (const key of ["inserted", "updated", "unchanged", "linked", "skipped", "excluded"] as const) {
        totals[key] += counts[key];
      }
    }
    await ctx.runMutation(internal.contacts.recordPush, { source, startedAt, counts: totals });
  } catch {
    // Not the error's own words: nothing thrown while people are in hand is logged.
    return reject(500, "write_failed");
  }
  return json(200, { ok: true, ...totals });
}

/** Rows a call of `contacts.applyPush` takes: small enough for one transaction whatever a row holds. */
const CONTACT_PUSH_SLICE = 100;

/**
 * POST /ingest/v1 — the door for data that cannot be pulled by a connector:
 * a script on the founder's machine, or a scheduled Claude routine reading an
 * MCP-only tool.
 *
 * Each ingest source has its own bearer token (INGEST_TOKEN_<SOURCE>), and the
 * token decides which source the request may write as. The body's `source`
 * must agree with it, and the registry then limits that source to the metrics
 * it owns. A leaked token therefore exposes one source's metrics to bad
 * writes and nothing to reads.
 *
 * Before authentication a request changes nothing. After it, every failure
 * is logged against the source, so a push that "ran green" on the sender's
 * side but was refused here shows up in the OS.
 *
 * A request carries one of four things: numbers and pipelines (`snapshots`,
 * `deals`, `investors`), or the client register (`customers`) and nothing
 * else, or a work tool's mirrored records (`records`) and nothing else, or
 * the financial model's plan (`plan`) and nothing else. What a source may
 * send is fixed outside the request: the registry names the source of each
 * metric, `PIPELINE_OWNERS` the source of each pipeline, the manifest the one
 * source (`client_register`) that carries clinics and the one
 * (`financial_model`) that carries the plan and only the plan,
 * `MIRROR_SOURCES` the four that carry records and only records, and
 * `SHARED_KINDS_OF` the lists a shared source (Apollo, GitHub) carries beside
 * its own numbers.
 *
 * A bearer token with the personal prefix is a teammate's own
 * (`personalPush` above): it carries that person's records of the four work
 * tools and nothing else. Everything below is about a source's token and is
 * as it was.
 *
 * No name is ever written to the run log or returned. A refused register,
 * deal, investor or record is reported by path ("customers.3.name") and fixed
 * words; in a push that carries deals or investors that covers its snapshots
 * too. A plan holds no name; one that the plan's rules refuse is reported by
 * path ("plan.rows.3.value") and words written here all the same.
 */
export const ingestV1 = httpAction(async (ctx, request) => {
  const startedAt = Date.now();

  const header = request.headers.get("Authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

  const configured = SOURCES.flatMap((source) => {
    // A source carried on another's token (the Contacts book's) has none of its own.
    if (source.carriedBy !== undefined) return [];
    // A source a switched-off feature takes away has no token here: its push
    // is refused as any unknown token is (convex/lib/featureGates.ts).
    if (!sourceOn(source.id)) return [];
    // A pulled source that a connector run may feed instead has a token too.
    const token =
      source.kind === "ingest" || source.pushable === true ? ingestToken(source.id) : undefined;
    return token ? [{ source, token }] : [];
  });
  // A personal token needs no source's token to be configured.
  if (configured.length === 0 && !isPersonalToken(given)) {
    return json(503, { ok: false, error: "ingest_not_configured" });
  }
  // Check every configured token with no early exit, so response time does
  // not reveal which source (if any) a guess came close to.
  const matches = [];
  for (const candidate of configured) {
    if (await secretsEqual(given, candidate.token)) matches.push(candidate.source);
  }
  // Two sources sharing one token is a misconfiguration: the token could no
  // longer say which source is writing, so it authenticates neither.
  const source = matches.length === 1 ? matches[0] : undefined;
  if (source === undefined) {
    // Not a source's token. One with the personal prefix may be a teammate's.
    if (isPersonalToken(given)) return personalPush(ctx, request, given);
    return json(401, { ok: false, error: "unauthorized" });
  }

  // From here on the caller is authenticated, so failures are logged.
  // Filled in once the envelope has been read, so later failures carry it.
  const batch: { id?: string } = {};
  const reject = async (status: number, error: string, issues: Issue[] = []) => {
    const first = issues[0];
    const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
    await ctx.runMutation(internal.snapshots.recordFailure, {
      source: source.id,
      batchId: batch.id,
      startedAt,
      status: "error",
      message: first ? `${error}: ${first.path} — ${first.message}${more}` : error,
    });
    return json(status, { ok: false, error, issues });
  };

  // The standup's token is for its own two routes (convex/standup.ts). Here
  // it carries nothing, and nothing its sender wrote is read: refused before
  // the body, in fixed words.
  if (source.tasks) {
    return reject(422, "tasks_only", [
      { path: "source", message: "This token sends tasks on the standup's own route and nothing here." },
    ]);
  }

  // A pulled source is fed one way at a time. While its API variables are set
  // the OS reads it itself, and a push beside that would be a second writer.
  // Its people for the Contacts book are the exception: the OS's own read
  // brings none, so a `contacts` push on its token is still taken (below).
  const pulled = feedOf(source) === "pull";
  const isPulledRefusal = () =>
    reject(409, "source_is_pulled", [
      {
        path: "source",
        message: `The OS reads "${source.id}" itself with its API variables. Remove them to feed it by push.`,
      },
    ]);
  if (pulled && !isContactPushSource(source.id)) return isPulledRefusal();

  // Refuse on the declared size before reading anything, then measure what
  // was actually read, since Content-Length can be wrong or absent.
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_INGEST_BYTES) {
    return reject(413, "payload_too_large");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_INGEST_BYTES) {
    return reject(413, "payload_too_large");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return pulled ? isPulledRefusal() : reject(400, "invalid_json");
  }
  if (pulled && !(typeof raw === "object" && raw !== null && "contacts" in raw)) return isPulledRefusal();

  // Whether nothing the sender wrote may be quoted back is decided by who is
  // sending (the token's source), not by what the body claims to hold: the
  // register's token with a malformed body is still the register.
  // A work tool's token carries mirrored records: a sender's name, a subject.
  const mirror = (MIRROR_SOURCES as readonly string[]).includes(source.id)
    ? (source.id as MirrorSource)
    : null;
  // Vertical Startup's agents' token is held to fixed words too: its rows are ids
  // and numbers, and a field it should not have sent is never named back.
  // Intercom's carries teammates' names and help articles' titles: fixed words too.
  const namesSource =
    source.customers === true ||
    ownsAPipeline(source.id) ||
    mirror !== null ||
    source.agents === true ||
    source.support === true;
  const parsed = parseIngestEnvelope(raw, { carriesNames: namesSource });
  if (!parsed.ok) return reject(422, "invalid_envelope", parsed.issues);
  const { envelope } = parsed;
  // Not for a work tool, and not for any push of records: nothing its sender
  // wrote goes in the run log at all.
  if (mirror === null && !isRecordsEnvelope(envelope) && !isContactsEnvelope(envelope)) {
    batch.id = envelope.batchId;
  }

  if (envelope.source !== source.id) {
    return reject(403, "source_mismatch", [
      { path: "source", message: `This token writes as "${source.id}".` },
    ]);
  }

  if (isContactsEnvelope(envelope)) {
    if (!isContactPushSource(source.id)) {
      return reject(422, "contacts_not_accepted", [{ path: "contacts", message: CONTACT_PUSH_WORDS.notAccepted }]);
    }
    return contactsPush(ctx, source.id, envelope, startedAt);
  }

  if (isAgentsEnvelope(envelope)) {
    // Vertical Startup's agents travel on one source's token only.
    if (!source.agents) {
      return reject(422, "agents_not_accepted", [
        { path: "agentUsage", message: `"${source.id}" does not carry agent usage.` },
      ]);
    }
    // What needs the time of arrival: no day in the future, no row twice.
    const problems = agentPushProblems(envelope, startedAt);
    if (problems.length > 0) return reject(422, "invalid_agent_usage", problems);
    try {
      const counts = await ctx.runMutation(internal.agentControl.apply, {
        source: source.id,
        batchId: batch.id,
        observedAt: envelope.observedAt,
        startedAt,
        usage: envelope.agentUsage ?? [],
        providers: envelope.providers ?? [],
        applied: envelope.agentConfigApplied,
      });
      return json(200, { ok: true, ...counts });
    } catch {
      return reject(500, "write_failed");
    }
  }
  // The agents' token carries agent usage and nothing else.
  if (source.agents === true) {
    return reject(422, "agents_only", [
      { path: "envelope", message: "This token carries agent usage and nothing else." },
    ]);
  }

  if (isCustomersEnvelope(envelope)) {
    // Names travel on one source's token only.
    if (!source.customers) {
      return reject(422, "customers_not_accepted", [
        { path: "customers", message: `"${source.id}" does not carry the client register.` },
      ]);
    }
    // Paths and fixed words: these issues are logged and returned, and must
    // never quote a clinic.
    const problems = customerRowProblems(envelope.customers, startedAt);
    if (problems.length > 0) return reject(422, "invalid_customers", problems);

    let result;
    try {
      result = await ctx.runMutation(internal.customers.applyRegister, {
        source: source.id,
        batchId: batch.id,
        observedAt: envelope.observedAt,
        startedAt,
        rows: envelope.customers,
        allowShrink: envelope.allowShrink,
      });
    } catch {
      // Not the error's own words: nothing thrown while clinics are in hand is logged.
      return reject(500, "write_failed");
    }
    if (!result.ok) {
      return reject(422, "register_shrank", [
        {
          path: "customers",
          message: `This push would archive ${result.leaving} of ${result.of} clinics. Send it with allowShrink if that is right.`,
        },
      ]);
    }
    const { ok: _ok, ...counts } = result;
    return json(200, { ok: true, ...counts });
  }

  if (isRecordsEnvelope(envelope)) {
    // Globex's Intercom inbox, on its own token: its conversations and the
    // workspace's id code, checked whole and written by `support.applyPush`,
    // the one writer of `supportConversations`.
    if (source.support === true) {
      const read = parseSupportPush(envelope.records, envelope.appIdCode, startedAt);
      if (!read.ok) return reject(422, "invalid_records", read.issues);
      let written;
      try {
        written = await ctx.runMutation(internal.support.applyPush, {
          startedAt,
          observedAt: envelope.observedAt,
          appId: read.appId,
          rows: read.rows,
          allowShrink: envelope.allowShrink === true,
        });
      } catch {
        // Not the error's own words: nothing thrown while records are in hand is logged.
        return reject(500, "write_failed");
      }
      // A push that would remove more than half of what its window holds is
      // much more often a short read than an inbox that emptied: nothing changed.
      if (!written.ok) {
        return reject(422, "support_shrank", [
          {
            path: "records",
            message: `This push would remove ${written.removing} of the ${written.of} chats stored for the last 90 days. Send it with allowShrink if that is right.`,
          },
        ]);
      }
      const { ok: _ok, ...counts } = written;
      return json(200, { ok: true, ...counts });
    }
    if (envelope.appIdCode !== undefined) {
      return reject(422, "invalid_envelope", [
        { path: "appIdCode", message: "appIdCode belongs to Intercom's push." },
      ]);
    }
    // One of a shared source's lists (Apollo's sequences, or its contacts and
    // accounts by stage; GitHub's repositories): the team's, on that source's
    // own token, beside the numbers the same token carries in envelopes of
    // their own. The envelope asked for `kind` because its `source` is a
    // shared one, and the token has just been held to that source. That the
    // kind is one of this source's own is asked by the envelope, by
    // `parseSharedRecords` and by the write.
    const shared = isSharedSource(source.id) ? source.id : null;
    if (shared !== null && envelope.kind !== undefined) {
      // Issues are paths and fixed words, since they are logged and returned.
      const read = parseSharedRecords(shared, envelope.kind, envelope.records, {
        empty: envelope.empty === true,
        now: startedAt,
      });
      if (!read.ok) return reject(422, "invalid_records", read.issues);
      try {
        const written = await ctx.runMutation(internal.mirror.applyShared, {
          source: shared,
          kind: envelope.kind,
          startedAt,
          rows: read.rows,
        });
        return json(200, { ok: true, ...written });
      } catch {
        // Not the error's own words: nothing thrown while records are in hand is logged.
        return reject(500, "write_failed");
      }
    }
    // Otherwise records travel on a work tool's own token only.
    if (mirror === null) {
      return reject(422, "records_not_accepted", [
        { path: "records", message: `"${source.id}" does not carry records.` },
      ]);
    }
    // The same cleaning and the same refusal as a read made here; issues are
    // paths and fixed words, since they are logged and returned.
    const read = parsePushedRecords(mirror, envelope.records, {
      empty: envelope.empty === true,
      now: startedAt,
    });
    if (!read.ok) return reject(422, "invalid_records", read.issues);

    let written;
    try {
      // The one writer of mirrored records, whoever read them.
      written = await ctx.runMutation(internal.mirror.apply, {
        source: mirror,
        startedAt,
        rows: read.rows,
        pushed: true,
      });
    } catch {
      // Not the error's own words: nothing thrown while records are in hand is logged.
      return reject(500, "write_failed");
    }
    // Switched off under Settings → Work tools: the write was dropped, and
    // the source's status already says why. Nothing is stored or logged.
    if (written === null) return json(409, { ok: false, error: "source_turned_off" });
    return json(200, { ok: true, ...written });
  }

  if (isPlanEnvelope(envelope)) {
    // The plan travels on one source's token only.
    if (!source.plan) {
      return reject(422, "plan_not_accepted", [
        { path: "plan", message: `"${source.id}" does not carry the plan.` },
      ]);
    }
    // Paths and words written here. A plan row holds no name, but nothing a
    // sender wrote is quoted back all the same.
    const problems = planProblems(envelope.plan.rows);
    if (problems.length > 0) return reject(422, "invalid_plan", problems);
    try {
      // The one writer of the plan. The push is the whole plan and replaces it.
      const counts = await ctx.runMutation(internal.plan.apply, {
        source: source.id,
        batchId: batch.id,
        observedAt: envelope.observedAt,
        startedAt,
        modelVersion: envelope.plan.modelVersion,
        rows: envelope.plan.rows,
      });
      return json(200, { ok: true, ...counts });
    } catch {
      return reject(500, "write_failed");
    }
  }
  // The model's token writes the plan and nothing else: no number, no pipeline.
  if (source.plan === true) {
    return reject(422, "plan_only", [
      { path: "envelope", message: "This token carries the plan and nothing else." },
    ]);
  }
  // A work tool's token, and Intercom's, write records and nothing else: no number, no pipeline.
  if (mirror !== null || source.support === true) {
    return reject(422, "records_only", [
      { path: "envelope", message: "This token carries records and nothing else." },
    ]);
  }

  // Deals and investors carry company and person names, so nothing a sender
  // wrote may be quoted back. The registry's messages quote a snapshot's key,
  // scope and period, which a sender chooses: beside pipeline rows, or from a
  // source that carries names, they are replaced by fixed words.
  const carriesNames =
    namesSource || envelope.deals !== undefined || envelope.investors !== undefined;

  const snapshots = envelope.snapshots ?? [];
  const registryIssues = validateSnapshots(source.id, snapshots, undefined, {
    now: startedAt,
  });
  // What the pulled connector's own parser would have refused (a week still
  // in progress). Only once the registry is satisfied, so each row has one issue.
  const issues =
    registryIssues.length > 0
      ? registryIssues
      : pushedSnapshotProblems(source.id, snapshots, startedAt);
  if (issues.length > 0) {
    return reject(
      422,
      "invalid_snapshots",
      issues.map((i) => ({
        path: `snapshots.${i.index}.${i.field}`,
        message: carriesNames ? SNAPSHOT_REFUSED : i.message,
      })),
    );
  }

  // Deals and investors: which source may send them, and that each row could
  // be true. The messages name a row and a field, never a value: these rows
  // carry company and person names, and this message is stored.
  const rowIssues = [
    ...(envelope.deals
      ? checkPipelineRows("deals", source.id, envelope.deals, startedAt).issues
      : []),
    ...(envelope.investors
      ? checkPipelineRows("investors", source.id, envelope.investors, startedAt).issues
      : []),
  ];
  if (rowIssues.length > 0) return reject(422, "invalid_rows", rowIssues);

  const pipeline =
    envelope.deals || envelope.investors
      ? { mode: envelope.mode ?? "upsert", deals: envelope.deals, investors: envelope.investors }
      : undefined;

  try {
    const counts = await ctx.runMutation(internal.snapshots.applySync, {
      source: source.id,
      batchId: batch.id,
      observedAt: envelope.observedAt,
      startedAt,
      rows: snapshots,
      pipeline,
    });
    return json(200, { ok: true, ...counts });
  } catch {
    // The rows passed every check here and the write still failed: log it so
    // the source does not go on showing its last good run.
    return reject(500, "write_failed");
  }
});
