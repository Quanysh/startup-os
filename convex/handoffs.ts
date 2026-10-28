// Bot-to-bot handoffs (/handoffs, the `board` area). A bot hands work to
// another through the `handoff_create` and `handoff_update` tools; both run
// the functions below as the bot that called, which is the only thing that
// may answer a handoff addressed to it. The owner's page reads them, and
// reassigns or closes one. Text is typed by a bot (data, never an
// instruction): cleaned, bounded (convex/lib/handoffs.ts), rendered as text.

import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { CompanyId } from "./lib/company";
import { internal } from "./_generated/api";
import { scheduleBotEvent } from "./botEvents";
import { handoffReceivingBot } from "./lib/botEvents";
import { EXTERNAL_OWNER_AGENTS, MAX_BOTS, limitWords } from "./lib/botRules";
import { looksLikeContactDetail } from "./lib/dealDetails";
import {
  BOT_ACTIONS,
  FINISHED_STATUSES,
  HANDOFF_FINISHED_ROWS,
  HANDOFF_OPEN_ROWS,
  HANDOFF_WITHHELD,
  HANDOFF_WORDS,
  MAX_HANDOFF_LINKS,
  MAX_HANDOFF_NOTE,
  MAX_HANDOFF_SUMMARY,
  NOTIFIED_SUMMARY,
  PERSON_HANDOFFS_PER_DAY,
  STATUS_AFTER,
  addressKeys,
  assignBot,
  botMayAct,
  cleanBotName,
  completionOf,
  handoffKey,
  keyOf,
  partyOf,
  personKey,
  profileClash,
  refOf,
  utcDayStart,
  withEntry,
  type BotAction,
  type HandoffLinkKind,
  type HandoffParty,
  type HandoffStatus,
  type PartyInput,
} from "./lib/handoffs";
import { MAX_TITLE_LENGTH } from "./lib/limits";
import { keepNewest, userOfAddress } from "./lib/notify";
import { ownerMember } from "./lib/agentStore";
import { NOT_ALLOWED, memberMutation, memberQuery, ownerMutation, requireCompany, type Member } from "./lib/owner";
import { figureAreasOf } from "./lib/handoffFigures";
import { may, type Area } from "./lib/roles";
import { mayTakeWork, nameOf, teamDirectory } from "./lib/teamDirectory";
import { cleanText, cleanTitle } from "./lib/text";
import { companyValidator } from "./schema";
import { botToken } from "./telegram";

type Row = Doc<"handoffs">;

/** Open handoffs one company may hold at once: a bot loop cannot fill the page. */
export const MAX_OPEN_HANDOFFS = 150;
export const TOO_MANY_OPEN = "There are too many open handoffs. Wait for some to be answered.";

/** Who a change by a person on the page is said to be by. */
const personName = (member: Member) => member.user.email ?? member.user.name ?? "the owner";

async function checkLinks(
  ctx: QueryCtx,
  company: CompanyId,
  links: readonly { kind: HandoffLinkKind; id: string }[],
) {
  if (links.length > MAX_HANDOFF_LINKS) throw new ConvexError(HANDOFF_WORDS.link);
  const kept: { kind: HandoffLinkKind; id: string }[] = [];
  for (const { kind, id } of links) {
    let ok = false;
    if (kind === "task") {
      const found = ctx.db.normalizeId("tasks", id);
      const row = found === null ? null : await ctx.db.get(found);
      ok = row !== null && (row.company === undefined || row.company === company);
    } else if (kind === "deal") {
      const found = ctx.db.normalizeId("deals", id);
      const row = found === null ? null : await ctx.db.get(found);
      ok = row !== null && row.market === company;
    } else {
      const found = ctx.db.normalizeId("decisions", id);
      const row = found === null ? null : await ctx.db.get(found);
      ok = row !== null && row.company === company;
    }
    if (!ok) throw new ConvexError(HANDOFF_WORDS.link);
    kept.push({ kind, id });
  }
  return kept;
}

export type NewHandoff = {
  company: CompanyId;
  /** A bot's name, a person's address, or the union (convex/lib/handoffs.ts `partyOf`). */
  to: PartyInput;
  title: string;
  summary: string;
  links?: readonly { kind: HandoffLinkKind; id: string }[] | undefined;
};

/** Said when a bot has made its handoffs to people for the day: the limit's words, as every bot limit's. */
export const personLimitWords = (now: number) =>
  limitWords("person_handoffs", PERSON_HANDOFFS_PER_DAY, utcDayStart(now) + 24 * 60 * 60 * 1000);

/**
 * Whether an address is one of this company's people who can answer on
 * /handoffs: an owner, or a teammate on that company who holds the board. The
 * rule a task's assignee is held to as well (`mayTakeWork`).
 */
async function personMayTake(ctx: QueryCtx, company: CompanyId, email: string): Promise<boolean> {
  const person = (await teamDirectory(ctx.db)).get(email);
  return person !== undefined && mayTakeWork(person, company);
}

/**
 * Tell a person a bot handed them work: a row in their notifications (once
 * they have signed in) and, when the bot is on, a message in the company's
 * group (convex/telegram.ts `notifyHandoff`). Title, summary and the bot;
 * nothing else. Never throws: the handoff is saved whatever becomes of it.
 */
async function announceHandoff(
  ctx: MutationCtx,
  id: Id<"handoffs">,
  now: number,
  by?: { userId: Id<"users"> },
) {
  try {
    const row = await ctx.db.get(id);
    if (row === null || row.toKind !== "person") return;
    const recipient = await userOfAddress(ctx.db, row.to);
    if (recipient !== null) {
      await ctx.db.insert("notifications", {
        recipient,
        kind: "handoff",
        // The bot that wrote it, or the person who tagged them on /handoffs.
        actor: by === undefined ? { type: "bot", name: row.from } : { type: "user", userId: by.userId },
        handoffId: id,
        company: row.company,
        title: row.title.slice(0, MAX_TITLE_LENGTH),
        summary: row.summary.slice(0, NOTIFIED_SUMMARY),
        createdAt: now,
      });
      await keepNewest(ctx, recipient);
    }
    // A bot's text tagged on by a person is not checked for contact details at
    // creation (only handoffs to people are): then the app alone tells them.
    const clean = !looksLikeContactDetail(row.title) && !looksLikeContactDetail(row.summary);
    if (botToken() !== null && clean) await ctx.scheduler.runAfter(0, internal.telegram.notifyHandoff, { handoffId: id });
  } catch {
    // Never the handoff's problem, and what was thrown is not ours to repeat.
  }
}

/**
 * A handoff from the bot `caller` to another bot or a person. Returns its id.
 * `toPeople` says whether the caller may hand to a person at all: a bot whose
 * profile writes the board (the tool decides; convex/lib/mcpTools.ts).
 */
export async function createHandoff(
  ctx: MutationCtx,
  member: Member,
  caller: string,
  args: NewHandoff,
  now: number,
  toPeople = false,
): Promise<{ id: Id<"handoffs">; warning: string | null }> {
  requireCompany(member, args.company);
  const from = cleanBotName(caller);
  const target: HandoffParty = partyOf(args.to);
  const assigned = target.type === "bot" ? await resolvedBot(ctx, target.id) : null;
  if (assigned !== null && handoffKey(from) === assigned.toKey) throw new ConvexError(HANDOFF_WORDS.toSelf);
  if (target.type === "person") {
    if (!toPeople) throw new ConvexError(HANDOFF_WORDS.botsToPeople);
    // Its title and summary go to the company's Telegram group and the person's notifications: no contact details.
    if (looksLikeContactDetail(args.title) || looksLikeContactDetail(args.summary)) throw new ConvexError(HANDOFF_WORDS.contact);
    if (!(await personMayTake(ctx, args.company, target.email))) throw new ConvexError(HANDOFF_WORDS.unknownPerson);
    const today = await ctx.db
      .query("handoffs")
      .withIndex("by_fromKey_and_toKind_and_createdAt", (q) =>
        q.eq("fromKey", handoffKey(from)).eq("toKind", "person").gte("createdAt", utcDayStart(now)),
      )
      .take(PERSON_HANDOFFS_PER_DAY);
    if (today.length >= PERSON_HANDOFFS_PER_DAY) throw new ConvexError(personLimitWords(now));
  }
  const open = await ctx.db
    .query("handoffs")
    .withIndex("by_company_and_status", (q) => q.eq("company", args.company).eq("status", "open"))
    .take(MAX_OPEN_HANDOFFS);
  if (open.length >= MAX_OPEN_HANDOFFS) throw new ConvexError(TOO_MANY_OPEN);
  const links = await checkLinks(ctx, args.company, args.links ?? []);
  const to = assigned !== null ? assigned.to : target.type === "person" ? target.email : target.id;
  const toKey = assigned !== null ? assigned.toKey : personKey(to);
  const title = cleanTitle(args.title, "handoff");
  const id = await ctx.db.insert("handoffs", {
    company: args.company,
    from,
    fromKey: handoffKey(from),
    to,
    toKey,
    ...(target.type === "person" ? { toKind: "person" as const } : null),
    title,
    summary: cleanText(args.summary, MAX_HANDOFF_SUMMARY, "That summary"),
    links,
    status: "open",
    openSince: now,
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, by: from, action: "create" }],
  });
  if (target.type === "person") await announceHandoff(ctx, id, now);
  await scheduleBotEvent(ctx, {
    event: "handoff.assigned",
    company: args.company,
    agent: handoffReceivingBot(toKey, target.type === "person" ? "person" : undefined),
    id,
    title,
    at: now,
  });
  return { id, warning: assigned?.warning ?? null };
}

/** The bot a handoff is stored as, or a refusal when that id is two profiles. */
async function resolvedBot(ctx: QueryCtx, id: string) {
  const assigned = assignBot(id);
  const profiles = await ctx.db.query("bots").take(MAX_BOTS);
  if (profileClash(assigned, profiles)) throw new ConvexError(HANDOFF_WORDS.ambiguous);
  return assigned;
}

/** The bot `caller` accepting, declining or completing a handoff addressed to it. */
export async function answerHandoff(
  ctx: MutationCtx,
  member: Member,
  caller: string,
  args: { id: string; action: BotAction; note?: string | undefined },
  now: number,
): Promise<{ id: Id<"handoffs">; status: HandoffStatus }> {
  const id = ctx.db.normalizeId("handoffs", args.id);
  const row = id === null ? null : await ctx.db.get(id);
  if (id === null || row === null) throw new ConvexError(HANDOFF_WORDS.gone);
  requireCompany(member, row.company);
  const note = cleanText(args.note ?? "", MAX_HANDOFF_NOTE, "That note");
  const refusal = botMayAct(row, handoffKey(caller), args.action, note);
  if (refusal !== null) throw new ConvexError(refusal);
  const status = STATUS_AFTER[args.action];
  await ctx.db.patch(id, {
    status,
    updatedAt: now,
    ...(args.action === "decline" ? { reason: note } : null),
    history: withEntry(row.history, {
      at: now,
      by: cleanBotName(caller),
      action: args.action,
      ...(note === "" ? null : { note }),
    }),
  });
  return { id, status };
}

export type HandoffFilter = { to?: string | undefined; from?: string | undefined; status?: HandoffStatus | undefined };

/** The handoffs of these companies: open ones first (oldest first), then the latest finished. */
export async function handoffRows(
  ctx: QueryCtx,
  companies: readonly CompanyId[],
  filter: HandoffFilter = {},
) {
  const rows: Row[] = [];
  const statuses: readonly HandoffStatus[] = filter.status === undefined ? ["open", "accepted", ...FINISHED_STATUSES] : [filter.status];
  for (const company of companies) {
    for (const status of statuses) {
      const finished = FINISHED_STATUSES.includes(status);
      rows.push(
        ...(await ctx.db
          .query("handoffs")
          .withIndex("by_company_and_status", (q) => q.eq("company", company).eq("status", status))
          .order("desc")
          .take(finished ? HANDOFF_FINISHED_ROWS : HANDOFF_OPEN_ROWS)),
      );
    }
  }
  const toKeys = filter.to === undefined ? null : addressKeys(filter.to);
  const from = filter.from === undefined ? null : keyOf(filter.from);
  return rows
    .filter((row) => (toKeys === null || toKeys.includes(row.toKey)) && (from === null || row.fromKey === from))
    .sort((a, b) => {
      const aDone = FINISHED_STATUSES.includes(a.status) ? 1 : 0;
      const bDone = FINISHED_STATUSES.includes(b.status) ? 1 : 0;
      return aDone - bDone || (aDone === 1 ? b.updatedAt - a.updatedAt : a.openSince - b.openSince);
    });
}

/** Rows `my_inbox` reads of a bot's finished handoffs since its cursor. */
const COMPLETED_ROWS = 100;

/**
 * A bot's handoffs to people that a person marked done since `since`, in
 * these companies: `{id, note, by}` each, oldest first. For `my_inbox`.
 * `bot` is its handoff name (`callerName`: `bot:chief_of_staff` for an external profile).
 */
export async function completedForBot(
  ctx: QueryCtx,
  bot: string,
  since: number,
  companies: readonly CompanyId[],
) {
  const rows = await ctx.db
    .query("handoffs")
    .withIndex("by_fromKey_and_status_and_updatedAt", (q) =>
      q.eq("fromKey", handoffKey(bot)).eq("status", "done").gte("updatedAt", since),
    )
    .take(COMPLETED_ROWS);
  return rows
    .filter((row) => row.toKind === "person" && companies.includes(row.company))
    .map((row) => completionOf(row));
}

/** A row as a person or a bot is sent it. */
export const shape = (row: Row) => ({
  id: row._id,
  company: row.company,
  from: row.from,
  to: row.to,
  /** The union: `{type: "bot", id}` or `{type: "person", email}`. */
  fromRef: refOf(row.from, row.fromKind),
  toRef: refOf(row.to, row.toKind),
  title: row.title,
  summary: row.summary,
  links: row.links,
  status: row.status,
  reason: row.reason ?? null,
  openSince: row.openSince,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  history: row.history,
});

const companiesFor = (member: Member, company: CompanyId | undefined): readonly CompanyId[] => {
  if (company === undefined) return member.companies;
  requireCompany(member, company);
  return [company];
};

/** The caller's own key as an addressee: "@" and their address. */
const ownKey = (member: Member) => {
  const email = member.user.email?.trim().toLowerCase();
  return email === undefined || email === "" ? null : personKey(email);
};

/** Both sides' figure areas, read once per side for a whole list. */
function figureReader(ctx: QueryCtx) {
  const known = new Map<string, Promise<readonly Area[]>>();
  const side = (name: string, kind: "person" | undefined) => {
    const key = `${kind ?? "bot"}:${name}`;
    if (!known.has(key)) known.set(key, figureAreasOf(ctx, name, kind));
    return known.get(key)!;
  };
  return async (row: Row): Promise<readonly Area[]> => [
    ...new Set([...(await side(row.from, row.fromKind)), ...(await side(row.to, row.toKind))]),
  ];
}

/**
 * A row's words withheld: its title a fixed phrase, no summary, no reason and
 * no notes in its history. Who, when, where it stands and its links stay.
 */
const withheld = (row: Row): Row => ({
  ...row,
  title: HANDOFF_WITHHELD,
  summary: "",
  reason: undefined,
  history: row.history.map(({ note: _note, ...entry }) => entry),
});

export const list = memberQuery("board")({
  args: { company: v.optional(companyValidator) },
  handler: async (ctx, args) => {
    const me = ownKey(ctx.member);
    const owner = may(ctx.member, "personal");
    const figuresOf = figureReader(ctx);
    const rows = await handoffRows(ctx, companiesFor(ctx.member, args.company));
    return Promise.all(
      rows.map(async (row) => {
        /** Addressed to the caller, a person: theirs to accept, decline or mark done. */
        const mine = row.toKind === "person" && row.toKey === me;
        const party = mine || (row.fromKind === "person" && row.fromKey === me);
        // A bot that reads the company's figures may have written them here:
        // its words go to the owner, to the person it is to or from, and to a
        // teammate who holds every figure area it reads; anyone else is told
        // that it exists, who it is between and where it stands.
        const hidden = !owner && !party && !(await figuresOf(row)).every((area) => may(ctx.member, area));
        return { ...shape(hidden ? withheld(row) : row), withheld: hidden, mine };
      }),
    );
  },
});

/**
 * Who a handoff on that company can be handed to: its people who hold the
 * board (the owner included), by address and name, and the owner's bots by id
 * and name. An external profile is listed as `bot:<id>`, the address that
 * reaches it: the bare id is also the Mac agent's.
 */
export const recipients = memberQuery("board")({
  args: { company: companyValidator },
  handler: async (ctx, args) => {
    requireCompany(ctx.member, args.company);
    const people: { email: string; name: string | null }[] = [];
    for (const person of (await teamDirectory(ctx.db)).values()) {
      if (!(await personMayTake(ctx, args.company, person.email))) continue;
      people.push({ email: person.email, name: await nameOf(ctx.db, person.email) });
    }
    people.sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email));
    // At most MAX_BOTS rows: `bots.add` refuses more.
    const bots = (await ctx.db.query("bots").take(MAX_BOTS))
      .filter((bot) => bot.enabled)
      .map((bot) => ({
        id: (EXTERNAL_OWNER_AGENTS as readonly string[]).includes(bot.botId) ? `bot:${bot.botId}` : bot.botId,
        name: bot.name,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { people, bots };
  },
});

/**
 * The person a handoff is addressed to accepting, declining (with a reason)
 * or marking it done (a note optional). Nobody else: not the owner, not
 * another teammate, not a bot. Done reaches the sending bot's `my_inbox`.
 */
export const answer = memberMutation("board")({
  args: {
    id: v.id("handoffs"),
    action: v.union(...BOT_ACTIONS.map((a) => v.literal(a))),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null) throw new ConvexError(HANDOFF_WORDS.gone);
    if (!ctx.member.companies.includes(row.company)) throw new ConvexError(NOT_ALLOWED);
    const me = ownKey(ctx.member);
    if (row.toKind !== "person" || me === null) throw new ConvexError(HANDOFF_WORDS.notYours);
    const note = cleanText(args.note ?? "", MAX_HANDOFF_NOTE, "That note");
    const refusal = botMayAct(row, me, args.action, note);
    if (refusal !== null) throw new ConvexError(refusal);
    const now = Date.now();
    await ctx.db.patch(row._id, {
      status: STATUS_AFTER[args.action],
      updatedAt: now,
      ...(args.action === "decline" ? { reason: note } : null),
      history: withEntry(row.history, {
        at: now,
        by: row.to,
        action: args.action,
        ...(note === "" ? null : { note }),
      }),
    });
    return null;
  },
});

async function ownedBy(ctx: QueryCtx, member: Member, rawId: Id<"handoffs">) {
  const row = await ctx.db.get(rawId);
  if (row === null) throw new ConvexError(HANDOFF_WORDS.gone);
  if (!member.companies.includes(row.company)) throw new ConvexError(NOT_ALLOWED);
  if (FINISHED_STATUSES.includes(row.status)) throw new ConvexError(HANDOFF_WORDS.finished);
  return row;
}

/**
 * Hand it to another bot, or tag a person: an address of that company's
 * people who hold the board, told as a bot's handoff to a person is. It is
 * open again, for them to accept. The history names the person, never their
 * address: bots read it.
 */
export type ReassignArgs = { id: Id<"handoffs">; to: string; note?: string | undefined };

/** Whether this handoff can be handed on, and to whom. Throws the page's own sentences. */
export async function prepareReassign(ctx: QueryCtx, member: Member, args: ReassignArgs) {
  const row = await ownedBy(ctx, member, args.id);
  const target = partyOf(args.to);
  const note = cleanText(args.note ?? "", MAX_HANDOFF_NOTE, "That note");
  let to: string;
  let toKey: string;
  let said: string;
  if (target.type === "person") {
    if (!(await personMayTake(ctx, row.company, target.email))) throw new ConvexError(HANDOFF_WORDS.unknownPerson);
    if (personKey(target.email) === row.toKey) throw new ConvexError(HANDOFF_WORDS.toSelf);
    to = target.email;
    toKey = personKey(to);
    said = (await nameOf(ctx.db, target.email)) ?? "a teammate";
  } else {
    // A bare engineering slug is the bot profile, the same resolver create uses.
    const assigned = await resolvedBot(ctx, target.id);
    if (assigned.toKey === row.fromKey) throw new ConvexError(HANDOFF_WORDS.toSelf);
    to = assigned.to;
    toKey = assigned.toKey;
    said = to;
  }
  return { row, target, note, to, toKey, said };
}

/**
 * Hand an open handoff to another bot or a person. `by` is who the history
 * names: the page passes the person's address, a bot or agent passes its slug.
 */
export async function reassignHandoff(
  ctx: MutationCtx,
  member: Member,
  args: ReassignArgs,
  now: number,
  by: string,
): Promise<null> {
  const { row, target, note, to, toKey, said } = await prepareReassign(ctx, member, args);
  await ctx.db.patch(row._id, {
    to,
    toKey,
    // Whoever had it before, a person or a bot.
    toKind: target.type === "person" ? "person" : undefined,
    status: "open",
    openSince: now,
    updatedAt: now,
    history: withEntry(row.history, {
      at: now,
      by,
      action: "reassign",
      note: note === "" ? `To ${said}` : `To ${said}: ${note}`,
    }),
  });
  if (target.type === "person") await announceHandoff(ctx, row._id, now, { userId: member.user._id });
  if (toKey !== row.toKey) {
    await scheduleBotEvent(ctx, {
      event: "handoff.assigned",
      company: row.company,
      agent: handoffReceivingBot(toKey, target.type === "person" ? "person" : undefined),
      id: row._id,
      title: row.title,
      at: now,
    });
  }
  return null;
}

export const reassign = memberMutation("board")({
  args: { id: v.id("handoffs"), to: v.string(), note: v.optional(v.string()) },
  handler: (ctx, args) => reassignHandoff(ctx, ctx.member, args, Date.now(), personName(ctx.member)),
});

/**
 * The owner closing a handoff that will not be answered, with why: the
 * owner's alone (a teammate with the board reassigns, and does not close).
 */
export const close = ownerMutation({
  args: { id: v.id("handoffs"), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const member = ownerMember(ctx.owner);
    const row = await ownedBy(ctx, member, args.id);
    const note = cleanText(args.note ?? "", MAX_HANDOFF_NOTE, "That note");
    const now = Date.now();
    await ctx.db.patch(row._id, {
      status: "closed",
      updatedAt: now,
      ...(note === "" ? null : { reason: note }),
      history: withEntry(row.history, {
        at: now,
        by: personName(member),
        action: "close",
        ...(note === "" ? null : { note }),
      }),
    });
  },
});

/** Open handoffs, for Today's "Needs you": only when and how long, whether to a person and to the caller; never a title. */
export const waiting = memberQuery("board")({
  args: {},
  handler: async (ctx) => {
    const rows = await handoffRows(ctx, ctx.member.companies, { status: "open" });
    const me = ownKey(ctx.member);
    return rows.map((row) => ({
      company: row.company,
      status: row.status,
      openSince: row.openSince,
      /** To a person, and to the caller. Never who else. */
      person: row.toKind === "person",
      mine: row.toKind === "person" && row.toKey === me,
    }));
  },
});
