// The owner's bots: the external bots (Grok and others) that reach POST
// /mcp/v1 through a connected client and name themselves with the
// `X-Startup-Agent` header or an `agent` argument (docs/assistant.md, "Bots").
// A bot is a profile the owner keeps on /agents › Bots: an id, a name, a role
// label, which clients it may come through, a level for each area (none /
// read / write) and its own limits. Startup OS's own four agents are not bots:
// a name that is one of the four keeps their rules exactly (osAgents.ts).
//
// - **Which tools**: a tool's area is `STARTUP_OS_TOOL_AREAS`; a read tool needs
//   read or write on it, an act tool write. A tool with no area there is no
//   bot's. The client's scope still holds: a read-only client never acts.
// - **Never a locked area** (`LOCKED_BOT_AREAS`: payroll, costs, the sensitive two, the
//   owner's own `personal` and `admin`, and `today`, the owner's own day):
//   no bot may hold one at any level. The schema's validator does not hold
//   them and `cleanPermissions` refuses them, so a crafted mutation cannot.
// - **Limits** are counted per (client, bot) (`botUsage`), so one bot never
//   uses another's; the bots of one client together are held to a ceiling.
//
// Pure: the UI imports it. Every sentence is fixed words: none quotes a name.

import { BOT_ID, PROPOSAL_WORDS, isAgentId } from "./agents";
import { STARTUP_OS_TOOL_AREAS, toolAreasOf } from "./agentStartupOs";
import { devLimitWords } from "./devRequests";
import { HANDOFF_WORDS, PERSON_HANDOFFS_PER_DAY, utcDayStart } from "./handoffs";
import { COMPANIES, type CompanyId } from "./company";
import { HEADERS, PRODUCT } from "./identity";
import { AREAS, CUSTOM_ROLE, PAY_AND_COSTS, SENSITIVE_AREAS, effectiveAreas, type Area, type Role } from "./roles";

/**
 * Areas no bot may hold, at any level: payroll and costs, the sensitive two,
 * the owner's own, and the owner's own day.
 */
export const LOCKED_BOT_AREAS = [
  ...PAY_AND_COSTS,
  ...SENSITIVE_AREAS,
  "personal",
  "admin",
  "today",
] as const satisfies readonly Area[];

/** Whether an area is locked for every bot. */
export const isLockedBotArea = (area: string): boolean => (LOCKED_BOT_AREAS as readonly string[]).includes(area);

/**
 * Someone as a bot with these permissions is told about them: a teammate (not
 * the owner) holding exactly the areas the bot holds at read or write, never
 * a locked one, with `marketing` following `gtm` as it does for a teammate.
 * A read tool that filters what it sends by area (a figure by its section, a
 * goal's target) is handed this for a bot's call, so the owner behind the
 * client lends the bot nothing its own permissions do not open. The companies
 * are kept: a bot's company is enforced only where a tool says so (investors).
 */
export function memberAsBot<T extends { role: Role; areas: readonly Area[] }>(
  who: T,
  permissions: readonly { area: string; level: string }[],
): T {
  const held = permissions.filter((p) => p.level === "read" || p.level === "write").map((p) => p.area);
  return {
    ...who,
    role: CUSTOM_ROLE,
    areas: effectiveAreas(CUSTOM_ROLE, held).filter((area) => !isLockedBotArea(area)),
  };
}

/**
 * Whether a bot that works for a company (`BOT_COMPANIES`; none set: any)
 * may be sent what is that company's alone. Only the investors tools ask it
 * (`investors`, `investor_update`, `investor_create`): fundraising is Startup's alone.
 */
export const botServes = (company: BotCompany | undefined, which: CompanyId): boolean =>
  company === undefined || company === "both" || company === which;

/**
 * The areas a bot may be given, in the table's order. `marketing` is left
 * out: it follows `gtm`, as it does for a teammate.
 */
export const BOT_AREAS = AREAS.filter((area) => !isLockedBotArea(area) && area !== "marketing") as readonly BotArea[];
export type BotArea = Exclude<Area, (typeof LOCKED_BOT_AREAS)[number] | "marketing">;

export const isBotArea = (value: unknown): value is BotArea => (BOT_AREAS as readonly unknown[]).includes(value);

/**
 * The areas a bot reads when nobody chose: every bot area but Contacts (real
 * people's email addresses, phone numbers and LinkedIn), which the owner ticks
 * for a bot by name, as he does for a teammate (`isPersonAlone` in roles.ts).
 * A new bot, an external profile and a suggested bot with no `read` list start
 * from these.
 */
export const BOT_DEFAULT_AREAS: readonly BotArea[] = BOT_AREAS.filter((area) => area !== "contacts");

export const BOT_LEVELS = ["none", "read", "write"] as const;
export type BotLevel = (typeof BOT_LEVELS)[number];

/** A bot's permissions as stored: the areas it holds above `none`. */
export type BotPermission = { area: BotArea; level: "read" | "write" };

/** The level a bot holds on an area: `none` when it is not listed. */
export function levelOf(permissions: readonly BotPermission[], area: string): BotLevel {
  return permissions.find((p) => p.area === area)?.level ?? "none";
}

// ── Limits ──────────────────────────────────────────────────────────────────

export type BotLimits = { proposalsPerDay: number; changesPer10Min: number; callsPer10Min: number };

/** A new bot's limits. */
export const DEFAULT_BOT_LIMITS: BotLimits = { proposalsPerDay: 200, changesPer10Min: 120, callsPer10Min: 600 };
/** The most the owner may set each to. */
export const MAX_BOT_LIMITS: BotLimits = { proposalsPerDay: 1_000, changesPer10Min: 600, callsPer10Min: 2_000 };

// ── Company and budget (Bot Loop v3, J) ─────────────────────────────────────

/** Which company a bot works for, as the owner sets it on the Bots tab: none set until then. */
export const BOT_COMPANIES = ["us", "kz", "both"] as const;
export type BotCompany = (typeof BOT_COMPANIES)[number];

/** The most a bot's monthly budget may be, in USD. */
export const MAX_BOT_BUDGET_USD = 10_000;

/** The most one call may say it cost, in USD (`costUsd` on any call). */
export const MAX_CALL_COST_USD = 100;

/**
 * A cost a call reported (`costUsd`): a finite number from 0 to
 * `MAX_CALL_COST_USD`, else nothing. The endpoint takes it off every call; the
 * call still runs, and the audit keeps it only for a matched bot.
 */
export function cleanCostUsd(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_CALL_COST_USD) return null;
  return value;
}

/** A monthly budget the owner typed: a dollar amount from 0 to `MAX_BOT_BUDGET_USD`, cents kept; else thrown in fixed words. */
export function cleanBudget(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > MAX_BOT_BUDGET_USD) throw new Error(BOT_WORDS.badBudget);
  return Math.round(value * 100) / 100;
}

/**
 * What the bots of one client may do together in a window, whatever their own
 * limits: the client-wide ceiling. A call that names no bot keeps the client's
 * own limits (agentRules.ts), unchanged.
 */
export const CLIENT_BOT_CEILING = { callsPer10Min: 2_000, changesPer10Min: 600 } as const;

/** The tools that put a proposal in front of the owner: counted against a bot's proposals a day. */
export const PROPOSING_TOOLS: readonly string[] = ["propose", "goal_create", "goal_update"];

/**
 * The tools about the caller itself (`whoami`, `bot_rules`): every caller's,
 * on no area, and counted against no limit, so a bot can always learn who
 * Startup OS takes it for, what it may do and the rules, before it is refused.
 */
export const CALLER_TOOLS: readonly string[] = ["whoami", "bot_rules"];
export const isCallerTool = (tool: string): boolean => CALLER_TOOLS.includes(tool);
/**
 * Calls of `CALLER_TOOLS` a (client, bot) may make in 10 minutes (a client
 * naming no bot, or a name no profile it may use has, is one bucket): apart
 * from the bot's own calls, generous, and refused past it (`caller_calls`).
 */
export const CALLER_TOOL_CALLS = 300;

// ── A bot's own connector address ───────────────────────────────────────────

/** Where a bot's own address begins: `/mcp/v1/bot/<bot id>`. Every call there is that bot's. */
export const BOT_ADDRESS_PREFIX = "/mcp/v1/bot/";

/**
 * The bot id a path names, when the path is exactly `/mcp/v1/bot/<id>` and the
 * id could be a bot's profile (a bot's, or the external chief of staff's);
 * else null. The other three of the four have no address.
 */
export function botOfPath(pathname: string): string | null {
  if (!pathname.startsWith(BOT_ADDRESS_PREFIX)) return null;
  const id = pathname.slice(BOT_ADDRESS_PREFIX.length);
  return isProfileId(id) ? id : null;
}

/** A bot's connector address at an origin: what the owner gives its connector. */
export const botAddressOf = (origin: string, botId: string) => `${origin}${BOT_ADDRESS_PREFIX}${botId}`;

// ── The rules the owner gives the bots ──────────────────────────────────────

/** The most characters of the rules every bot is given, and of one bot's own note. */
export const MAX_RULES_TEXT = 20_000;
export const MAX_BOT_NOTE = 4_000;
/** Versions of the rules kept: the newest. */
export const KEPT_RULE_VERSIONS = 50;

/** Bots one owner may keep. */
export const MAX_BOTS = 50;
export const MAX_BOT_NAME = 60;
export const MAX_BOT_ROLE = 40;

/** A bot's id: lower case letters, digits, `_` and `-`, 2 to 40, starting with a letter (agents.ts, one shape for both). */
export { BOT_ID };

/** Whether a name a call sends could be a bot's id at all (and is not one of the four). */
export const isBotId = (value: unknown): value is string =>
  typeof value === "string" && BOT_ID.test(value) && !isAgentId(value);

// ── External owner-agent profiles (Bot Loop v3, A; spec §13) ────────────────
// `chief_of_staff` and `engineering` are two of the four: on the Mac runner's
// token they keep their rules exactly (allowlists, runs). Named through any
// other client (Grok bots use these ids too), or at `/mcp/v1/bot/<id>`, each
// is a profile of its own, kept in `bots` under that id like a bot's:
// owner-edited on the Bots tab, never a locked area, its own limits and audit
// per (client, id), its own approval stats and trust (`externalProposerOf`),
// and never auto-approved. `finance` too (the owner's Grok finance bot, Oct
// 19): the Mac finance agent switched off does not switch it off. `sales` has
// none: Mac only.

/** The ones of the four that have an external profile. */
export const EXTERNAL_OWNER_AGENTS = ["chief_of_staff", "engineering", "finance"] as const;
export type ExternalOwnerAgent = (typeof EXTERNAL_OWNER_AGENTS)[number];
export const isExternalOwnerAgent = (value: unknown): value is ExternalOwnerAgent =>
  (EXTERNAL_OWNER_AGENTS as readonly unknown[]).includes(value);
/** The chief of staff's, by name, where only it is meant. */
export const EXTERNAL_CHIEF = "chief_of_staff" as const;
/** How an external profile's proposals are counted for trust: apart from the Mac's agent of that id. */
export const externalProposerOf = (id: ExternalOwnerAgent) => `bot:${id}`;
export const isExternalProposer = (proposer: string): boolean =>
  proposer.startsWith("bot:") && isExternalOwnerAgent(proposer.slice(4));
export const EXTERNAL_PROFILES: Record<ExternalOwnerAgent, { name: string; role: string }> = {
  chief_of_staff: { name: "Chief of staff (external)", role: "Coordinator" },
  engineering: { name: "Engineering (external)", role: "Engineering" },
  finance: { name: "Finance (external)", role: "Finance" },
};
/** Their default: read on every default bot area (`BOT_DEFAULT_AREAS`: not Contacts), write on the board (tasks, handoffs) and memory. */
export const EXTERNAL_WRITES: readonly BotArea[] = ["board", "memory"];

/** Whether an id names a profile in `bots`: a bot's, or an external owner-agent's. */
export const isProfileId = (value: unknown): value is string => isBotId(value) || isExternalOwnerAgent(value);

/** An external profile's default permissions. */
export const externalPermissions = (): BotPermission[] =>
  BOT_DEFAULT_AREAS.map((area) => ({ area, level: EXTERNAL_WRITES.includes(area) ? ("write" as const) : ("read" as const) }));

/**
 * Tools every known, switched-on bot may call whatever its permissions: asking
 * the owner for a permission (it only stores a proposal he decides), its own
 * inbox, and what the owner decided of its own proposals (`proposals_feedback`
 * hands a bot its own rows only). Each needs no area a bot holds.
 */
export const EVERY_BOT_TOOLS: readonly string[] = ["permission_request", "my_inbox", "proposals_feedback", "dev_request"];

/**
 * The tools that are a bot's alone: they refuse a call naming no bot. No
 * prompt of the four names them, no agent may be given them, and the chat is
 * denied them.
 */
export const BOT_OWN_TOOLS = ["permission_request", "my_inbox", "outcome_log", "dev_request"] as const;

/**
 * Whether a bot with these permissions may call a tool of this kind. A tool
 * with no area (a runner's, or one not yet given an area) is no bot's.
 */
export function botMayCall(permissions: readonly BotPermission[], tool: string, kind: "read" | "act"): boolean {
  // `whoami` and `bot_rules` are about the caller itself: every bot's, on no area.
  if (isCallerTool(tool)) return true;
  if (EVERY_BOT_TOOLS.includes(tool)) return true;
  // `propose` only stores a proposal the owner approves or rejects on
  // /approvals: a bot that may change anything may propose a change.
  // `proposal_withdraw` takes back its own proposals only: held to what `propose` asks.
  // `proposal_sweep` clears the caller's own duplicates, or every proposer's for the chief of staff.
  // `proposal_decide` carries a proposal out. Any bot that may write somewhere
  // reaches the tool; the tool then refuses every caller the endpoint did not
  // match as the chief of staff (`mayDecideProposals`).
  if (tool === "propose" || tool === "proposal_withdraw" || tool === "proposal_sweep" || tool === "proposal_decide") {
    return permissions.some((p) => p.level === "write");
  }
  // A comment on a task or a handoff needs the board, and one on a deal needs sales:
  // write on either lets the call through, and the handler checks the subject.
  if (tool === "comment_create") {
    return levelOf(permissions, "board") === "write" || levelOf(permissions, "sales") === "write";
  }
  // What became of its own proposals (the tool gives a bot its own rows only):
  // every known bot may read it, whatever its areas.
  if (tool === "proposals_feedback") return true;
  // A read its page opens with any of several areas (`STARTUP_OS_READ_ALSO`: goals
  // with the scorecard or the board) needs read on any one of them.
  return toolAreasOf(tool, kind).some((area) => {
    if (isLockedBotArea(area)) return false;
    const level = levelOf(permissions, area === "marketing" ? "gtm" : area);
    return kind === "read" ? level !== "none" : level === "write";
  });
}

/**
 * What a bot would need to call a tool it may not: the tool's area (as the
 * owner grants it: `marketing` is `gtm`) and the level, and whether that area
 * is locked (no permission opens it). Null for a tool with no area.
 */
export function botNeed(
  tool: string,
  kind: "read" | "act",
): { area: Area; or?: Area[]; need: "read" | "write"; locked: boolean } | null {
  const area = STARTUP_OS_TOOL_AREAS[tool];
  if (area === undefined) return null;
  // `propose` asks for write on any area: there is no one area to name.
  // `proposal_decide` and `proposal_sweep` name no one area: the tool checks the caller.
  if (tool === "propose" || tool === "proposal_withdraw" || tool === "proposal_sweep" || tool === "proposal_decide") return null;
  if (tool === "comment_create") return { area: "board", or: ["sales"], need: "write", locked: false };
  const asGranted = (one: Area): Area => (one === "marketing" ? "gtm" : one);
  const granted = asGranted(area);
  // The other areas that open a read (`STARTUP_OS_READ_ALSO`), any one of which would do.
  const or = toolAreasOf(tool, kind).slice(1).map(asGranted);
  return {
    area: granted,
    ...(or.length > 0 ? { or } : null),
    need: kind === "read" ? "read" : "write",
    locked: isLockedBotArea(granted),
  };
}

/** The level a permission change would give, applied: one area set, the rest kept, in the table's order. */
export function withLevel(permissions: readonly BotPermission[], area: BotArea, level: BotLevel): BotPermission[] {
  const rest = permissions.filter((p) => p.area !== area);
  const next = level === "none" ? rest : [...rest, { area, level }];
  return BOT_AREAS.flatMap((a) => next.filter((p) => p.area === a));
}

/** Whether a level is at least another: write holds read. */
export const holdsLevel = (held: BotLevel, wanted: "read" | "write") =>
  wanted === "read" ? held !== "none" : held === "write";

/**
 * The one rule for an area a bot is to be given: `locked` (never any bot's,
 * whoever asks), `notBotArea` (no bot holds it), or null. Every place that
 * gives a bot an area asks this, and words the answer as it must.
 */
export function botAreaRefusal(area: unknown): "locked" | "notBotArea" | null {
  if (typeof area === "string" && isLockedBotArea(area)) return "locked";
  return isBotArea(area) ? null : "notBotArea";
}

/**
 * Why a bot may not be given a level on an area now, in fixed words, or null:
 * a locked area, one no bot holds, a bot switched off, or a level it already
 * holds. What the Bots tab's Grant and an approved `permission_request` both
 * ask (`setBotLevel`), and what a request is checked against when proposed.
 */
export function botLevelRefusal(
  bot: { enabled: boolean; permissions: readonly BotPermission[] },
  area: string,
  level: "read" | "write",
): string | null {
  const problem = botAreaRefusal(area);
  if (problem === "locked") return BOT_WORDS.locked;
  if (problem === "notBotArea") return BOT_PERMISSION_WORDS.badArea;
  if (!bot.enabled) return BOT_WORDS.off;
  if (holdsLevel(levelOf(bot.permissions, area), level)) return BOT_PERMISSION_WORDS.held;
  return null;
}

// ── Refusal codes ───────────────────────────────────────────────────────────
// Every refusal a bot meets carries one of these, with its details, in the
// tool error's `structuredContent`, beside the same words (docs/assistant.md,
// "Bots"). A code and its details are the server's: never a word the call sent.

export const BOT_REFUSAL_CODES = [
  "not_permitted",
  "rate_limited",
  "unknown_bot",
  "bot_off",
  "wrong_client",
  "bots_only",
  "read_only",
  "wrong_agent",
  "not_this_address",
  // A proposal refused for what it says (Approvals v2): a repeat of a key,
  // no `why`, a goal, source or urgency that does not hold, or too many open.
  "repeat",
  "missing_why",
  "bad_context",
  "too_many_open",
  // Bot Loop v3: a dedupeKey naming another proposer (A), and a near-duplicate
  // of something open (B), a proposed new deal's name included (C).
  "attribution_mismatch",
  "possible_duplicate",
  // A handoff to an address that is not one of that company's people who can answer it (D).
  "unknown_person",
  // A handoff whose bot id matches more than one profile, so it was not stored.
  "ambiguous_addressee",
  // A handoff to a person whose title or summary holds an email address or a phone number:
  // both are posted in the company's Telegram group (security review, 2026-10-19).
  "contact_detail",
  // Withdrawing a proposal (spec §14): one the caller did not file (or no
  // proposal at all: the same code, so nothing can be probed), and one no longer open.
  "not_owner",
  "not_open",
  // Approving or dismissing (`proposal_decide`): the caller is not the chief of staff.
  "not_chief_of_staff",
] as const;
export type BotRefusalCode = (typeof BOT_REFUSAL_CODES)[number];

export type BotRefusal =
  /** `or`: other areas any one of which would also do (a read its page opens with several: goals). */
  | { code: "not_permitted"; tool: string; area: Area | null; or?: Area[]; need: "read" | "write" | null; locked?: true }
  | { code: "rate_limited"; limit: BotLimitKind; max: number; resetsAt: string }
  /** The dedupeKey's prefix names a known bot or agent other than the caller: `expected` the caller, `got` the prefix's. */
  | { code: "attribution_mismatch"; expected: string; got: string }
  /** Something open is near it: the top three, best first. Retry with `force` and `forceReason` if it differs. */
  | {
      code: "possible_duplicate";
      /** `id` and `title` only where the caller may read that type (convex/lib/duplicates.ts, `shownMatches`). */
      matches: { type: "task" | "proposal" | "handoff" | "deal"; id?: string; title?: string; sim: number }[];
      /**
       * On a proposal (`propose`, `goal_*`): the ids of the matched open
       * proposals the caller itself filed, which it may withdraw and refile
       * (`proposal_withdraw`); left out when there is none. Never another proposer's.
       */
      withdrawHint?: string[];
    }
  | { code: Exclude<BotRefusalCode, "not_permitted" | "rate_limited" | "attribution_mismatch" | "possible_duplicate"> };

/** A refusal for a tool the bot may not call. */
export function notPermitted(tool: string, kind: "read" | "act"): BotRefusal {
  const need = botNeed(tool, kind);
  if (need === null) return { code: "not_permitted", tool, area: null, need: kind === "read" ? "read" : "write" };
  return {
    code: "not_permitted",
    tool,
    area: need.area,
    ...(need.or === undefined ? null : { or: need.or }),
    need: need.need,
    ...(need.locked ? { locked: true as const } : null),
  };
}

/** A limit refusal's code and details: which limit, its size, when it resets (ISO, UTC). */
export const rateLimited = (limit: BotLimitKind, max: number, resetsAt: number): BotRefusal => ({
  code: "rate_limited",
  limit,
  max,
  resetsAt: new Date(resetsAt).toISOString(),
});

/** What the audit keeps of a refusal: the code, and a not-permitted call's area and level. No text. */
export function auditOfRefusal(refusal: BotRefusal): { code: BotRefusalCode; area?: Area; need?: "read" | "write" } {
  if (refusal.code === "not_permitted") {
    return {
      code: refusal.code,
      ...(refusal.area === null ? null : { area: refusal.area }),
      ...(refusal.need === null ? null : { need: refusal.need }),
    };
  }
  return { code: refusal.code };
}

/** Each code in words, for the Bots tab: "Not permitted", "Rate limited". */
export const REFUSAL_LABELS: Record<BotRefusalCode, string> = {
  not_permitted: "Not permitted",
  rate_limited: "Over a limit",
  unknown_bot: "Unknown bot",
  bot_off: "Switched off",
  wrong_client: "Wrong client",
  bots_only: "Bots only",
  read_only: "Read-only client",
  wrong_agent: "Two names",
  not_this_address: "Another bot's address",
  repeat: "Repeat proposal",
  missing_why: "No why",
  bad_context: "Bad goal, source, urgency or replacement",
  too_many_open: "Too many open",
  attribution_mismatch: "Another proposer's key",
  possible_duplicate: "Possible duplicate",
  unknown_person: "Unknown person",
  ambiguous_addressee: "Ambiguous bot",
  contact_detail: "Contact details in a handoff or note",
  not_owner: "Not its proposal",
  not_open: "Proposal not open",
  not_chief_of_staff: "Not the chief of staff",
};

/**
 * A proposal's refusal (`PROPOSAL_WORDS`, convex/lib/agents.ts) as a code,
 * where one fits: what the endpoint puts beside the words when a bot's
 * `propose`, `goal_*` or `permission_request` is refused. Null for any other
 * words (they stay words alone).
 */
export function proposalRefusalOf(words: string): BotRefusal | null {
  switch (words) {
    case PROPOSAL_WORDS.repeatOpen:
    case PROPOSAL_WORDS.repeatDismissed:
    case PROPOSAL_WORDS.repeatApproved:
    case PROPOSAL_WORDS.repeatExpired:
    case PROPOSAL_WORDS.repeatWithdrawnWrong:
      return { code: "repeat" };
    case PROPOSAL_WORDS.why:
      return { code: "missing_why" };
    case PROPOSAL_WORDS.urgency:
    case PROPOSAL_WORDS.goalLink:
    case PROPOSAL_WORDS.sourceKind:
    case PROPOSAL_WORDS.sourceGone:
      return { code: "bad_context" };
    case PROPOSAL_WORDS.tooManyOpenBot:
      return { code: "too_many_open" };
    default:
      return null;
  }
}

/**
 * A handoff's refusal as a code, where one fits: an address that is no
 * person's (`unknown_person`), a caller that may not hand to people
 * (`not_permitted` on the board), or the day's handoffs to people used up
 * (`rate_limited`). Null for any other words.
 */
export function handoffRefusalOf(words: string, now: number): BotRefusal | null {
  if (words === HANDOFF_WORDS.unknownPerson) return { code: "unknown_person" };
  if (words === HANDOFF_WORDS.ambiguous) return { code: "ambiguous_addressee" };
  if (words === HANDOFF_WORDS.contact) return { code: "contact_detail" };
  if (words === HANDOFF_WORDS.botsToPeople) return { code: "not_permitted", tool: "handoff_create", area: "board", need: "write" };
  const resetsAt = utcDayStart(now) + 24 * 60 * 60 * 1000;
  if (words === limitWords("person_handoffs", PERSON_HANDOFFS_PER_DAY, resetsAt)) {
    return rateLimited("person_handoffs", PERSON_HANDOFFS_PER_DAY, resetsAt);
  }
  return null;
}

/** A bot refused more than this many times in an hour is a row of the owner's "Needs you". */
export const REFUSALS_ALERT = 5;
/** Calls the Bots tab lists for each bot. */
export const RECENT_BOT_CALLS = 10;

/** A new bot's permissions: read on every area a bot is given by default (`BOT_DEFAULT_AREAS`), write on none. */
export const defaultPermissions = (): BotPermission[] => BOT_DEFAULT_AREAS.map((area) => ({ area, level: "read" as const }));

// ── The suggested bots ──────────────────────────────────────────────────────

/** The owner's bots as of 2026-10-18, suggested once: read on everything a bot may read, and these writes. */
export const SUGGESTED_BOTS: readonly {
  id: string;
  name: string;
  role: string;
  write: readonly BotArea[];
  /** Areas held at read only (when given, the bot reads these and nothing else besides its writes). */
  read?: readonly BotArea[];
}[] = [
  { id: "research", name: "Research Bot", role: "Research", write: ["memory", "board"] },
  { id: "partnerships", name: "Partnerships Bot", role: "Partnerships", write: ["partnerships", "board", "outcomes"], read: ["sales"] },
  { id: "linkedin", name: "LinkedIn Bot", role: "LinkedIn", write: ["gtm", "board", "outcomes"] },
  { id: "compliance", name: "Compliance Bot", role: "Compliance", write: ["compliance", "board"] },
  {
    id: "customer_success",
    name: "Customer Success Bot",
    role: "Customer Success",
    write: ["board", "outcomes"],
    read: ["customers", "support"],
  },
  { id: "support", name: "Support Bot", role: "Support", write: ["board"], read: ["support", "outcomes"] },
  { id: "strategy_advisor", name: "Strategy Advisor", role: "Strategy Advisor", write: ["review", "memory", "board"] },
  { id: "fundraising", name: "Fundraising Bot", role: "Fundraising", write: ["fundraising", "board", "outcomes"] },
  { id: "globex_ai_sales", name: `${COMPANIES.kz.name} Sales Bot`, role: `${COMPANIES.kz.name} Sales`, write: ["sales", "board", "outcomes"] },
  { id: "growth", name: "Growth Bot", role: "Growth", write: ["gtm", "board", "outcomes"] },
];

/**
 * A suggested bot's permissions. With `read` given, it reads only those (and
 * its write areas); without, it reads every area a bot may read, as a new bot
 * does.
 */
export function suggestedPermissions(bot: (typeof SUGGESTED_BOTS)[number]): BotPermission[] {
  return BOT_AREAS.flatMap((area): BotPermission[] => {
    if (bot.write.includes(area)) return [{ area, level: "write" }];
    if (bot.read === undefined ? BOT_DEFAULT_AREAS.includes(area) : bot.read.includes(area)) return [{ area, level: "read" }];
    return [];
  });
}

/**
 * Check a set of permissions sent by a browser: each area one a bot may hold,
 * once, at read or write. Throws fixed words (the caller wraps them).
 */
export function cleanPermissions(given: readonly { area: string; level: string }[]): BotPermission[] {
  const seen = new Set<string>();
  const out: BotPermission[] = [];
  for (const { area, level } of given) {
    const problem = botAreaRefusal(area);
    if (problem === "locked") throw new Error(BOT_WORDS.locked);
    if (problem !== null || !isBotArea(area) || (level !== "read" && level !== "write" && level !== "none")) throw new Error(BOT_WORDS.badPermission);
    if (seen.has(area)) throw new Error(BOT_WORDS.badPermission);
    seen.add(area);
    if (level !== "none") out.push({ area, level });
  }
  return BOT_AREAS.flatMap((area) => out.filter((p) => p.area === area));
}

/** Check limits sent by a browser: whole numbers from 1 to the most allowed. */
export function cleanLimits(given: BotLimits): BotLimits {
  for (const key of Object.keys(MAX_BOT_LIMITS) as (keyof BotLimits)[]) {
    const value = given[key];
    if (!Number.isInteger(value) || value < 1 || value > MAX_BOT_LIMITS[key]) throw new Error(BOT_WORDS.badLimit);
  }
  return { proposalsPerDay: given.proposalsPerDay, changesPer10Min: given.changesPer10Min, callsPer10Min: given.callsPer10Min };
}

/** One line on what a bot may do, for its row: "Writes Board, Memory · reads 9 more". */
export function permissionSummary(permissions: readonly BotPermission[], names: Readonly<Record<string, string>>): string {
  const writes = permissions.filter((p) => p.level === "write").map((p) => names[p.area] ?? p.area);
  const reads = permissions.filter((p) => p.level === "read").length;
  if (writes.length === 0 && reads === 0) return "Nothing";
  const parts = [];
  if (writes.length > 0) parts.push(`Writes ${writes.join(", ")}`);
  if (reads > 0) parts.push(writes.length > 0 ? `reads ${reads} more` : `Reads ${reads} ${reads === 1 ? "area" : "areas"}`);
  return parts.join(" · ");
}

/** What a bot sends with every call, for the owner to give it. */
export const instructionLine = (id: string) => `Send \`agent: ${id}\` with every call (or the header ${HEADERS.agent}: ${id}).`;

/** A client as the usage counters key it. */
export const clientKey = (client: { kind: string; id: string }) => `${client.kind}:${client.id}`;

/** The UTC day of a moment. */
export const utcDayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

/** When a window opened at `start` closes, as the refusal says it: "14:32 UTC". */
export const resetWords = (at: number) => `${new Date(at).toISOString().slice(11, 16)} UTC`;

export type BotLimitKind =
  | "calls"
  | "changes"
  | "proposals"
  | "client_calls"
  | "client_changes"
  | "caller_calls"
  // Handoffs to people, a UTC day (convex/handoffs.ts).
  | "person_handoffs"
  // Requests for a fix, a UTC day (`dev_request`, convex/devRequests.ts).
  | "dev_requests";

/** A limit refusal: which limit, and when it resets. Numbers and a time only. */
export function limitWords(kind: BotLimitKind, max: number, resetsAt: number): string {
  const n = max.toLocaleString("en-US");
  switch (kind) {
    case "calls":
      return `This bot has used its ${n} calls for this 10-minute window. It resets at ${resetWords(resetsAt)}.`;
    case "changes":
      return `This bot has used its ${n} changes for this 10-minute window. It resets at ${resetWords(resetsAt)}.`;
    case "proposals":
      return `This bot has made its ${n} proposals for today. It resets at 00:00 UTC.`;
    case "client_calls":
      return `The bots of this client have used their ${n} calls together for this 10-minute window. It resets at ${resetWords(resetsAt)}.`;
    case "client_changes":
      return `The bots of this client have used their ${n} changes together for this 10-minute window. It resets at ${resetWords(resetsAt)}.`;
    case "person_handoffs":
      return `This bot has made its ${n} handoffs to people for today. It resets at 00:00 UTC.`;
    case "dev_requests":
      return devLimitWords(max);
    case "caller_calls":
      return `This caller has asked \`whoami\` and \`bot_rules\` ${n} times in this 10-minute window. It resets at ${resetWords(resetsAt)}.`;
  }
}

export const BOT_WORDS = {
  unknown:
    `That agent is not one ${PRODUCT.name} knows. The owner adds it on Agents › Bots, then it sends its id with every call.`,
  off: "That bot is switched off. The owner switches it on on Agents › Bots.",
  externalOff:
    "This external profile is switched off: it starts off, and the owner must switch it on on Agents › Bots before it may call. Until then every call is refused.",
  wrongClient: "That bot may not call through this client. The owner chooses its clients on Agents › Bots.",
  notAllowed: "That tool is not one this bot may use. The owner sets its permissions on Agents › Bots.",
  wrongAgent: "That call names two different agents.",
  noRun: `A bot has no runs: send no ${HEADERS.run} header.`,
  locked: "Payroll, costs, settings, the team, Today and the owner's own pages can never be given to a bot.",
  badPermission: "Each area may be given once, as none, read or write.",
  badLimit: `Limits are whole numbers from 1 to ${MAX_BOT_LIMITS.callsPer10Min.toLocaleString("en-US")} calls, ${MAX_BOT_LIMITS.changesPer10Min} changes and ${MAX_BOT_LIMITS.proposalsPerDay.toLocaleString("en-US")} proposals.`,
  badId: "A bot's id is 2 to 40 lower-case letters, digits, _ or -, starting with a letter.",
  reserved: `That id is one of ${PRODUCT.name}'s own four agents.`,
  taken: "Another bot already has that id.",
  nameMissing: "Give the bot a name.",
  nameTooLong: `A bot's name may be at most ${MAX_BOT_NAME} characters.`,
  roleTooLong: `A role may be at most ${MAX_BOT_ROLE} characters.`,
  tooMany: `At most ${MAX_BOTS} bots.`,
  badClient: "Choose clients from Settings › Connections.",
  gone: "That bot is gone.",
  botsOnly: "This client is for bots: send `agent: <bot id>` with every call.",
  botsOnlyFour:
    "This client is for bots: " + PRODUCT.name + "'s own four agents call only through the Mac runner's token. Send `agent: <bot id>`.",
  tokenForBot: "That token is for another bot.",
  notThisAddress:
    "This connector address is one bot's, and the call names another. Leave the name out, or use the address of the bot you are (Agents › Bots).",
  noBotHere: "There is no bot at this address. The owner copies each bot's connector address from Agents › Bots.",
  rulesTooLong: `The rules may be at most ${MAX_RULES_TEXT.toLocaleString("en-US")} characters, and a bot's note at most ${MAX_BOT_NOTE.toLocaleString("en-US")}.`,
  keyTaken: "Another bot already goes by that name or id, written differently. Bots sharing a client could claim each other's names.",
  badBudget: `A monthly budget is a dollar amount from 0 to ${MAX_BOT_BUDGET_USD.toLocaleString("en-US")}, or none.`,
} as const;

/** `permission_request` and `my_inbox`, in fixed words. */
export const BOT_PERMISSION_WORDS = {
  botsOnly: "Only one of the owner's bots may call this: send `agent: <bot id>`.",
  held: "This bot already holds that level on that area.",
  badArea: "That is not an area a bot may hold.",
} as const;
