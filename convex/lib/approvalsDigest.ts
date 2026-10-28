// The daily approvals digest, as words: what is counted, how an item is
// described, and the two texts (the Telegram message and the in-app title).
// Pure: no clock, no table, no request.
//
// **No free text.** An item is described by its kind (a fixed phrase here),
// the bot's or agent's name (only if it is a plain slug, or a fixed agent
// name) and its age. Never a title, a reason, a payload, a tool's arguments,
// a person's or a clinic's name.

import type { Doc } from "../_generated/dataModel";
import { APP_URL } from "./identity";
import { AGENT_NAMES, DEFAULT_URGENCY, URGENCIES, isAgentId, type ProposalKind, type Urgency } from "./agents";

export { URGENCIES, type Urgency };

/** The page the digest points at. Fixed: it is never built from a row. */
export const APPROVALS_URL = `${APP_URL}/approvals`;

/** How many of the oldest items are described. */
export const OLDEST_SHOWN = 3;

/** A proposal's urgency (Approvals v2's field), or normal: rows from before it have none. */
export const urgencyOf = (row: Pick<Doc<"proposals">, "urgency">): Urgency => row.urgency ?? DEFAULT_URGENCY;

const KIND_WORDS: Record<ProposalKind | "tool_call", string> = {
  task_create: "new task",
  task_change: "task change",
  deal_next_step: "deal next step",
  draft: "outbound draft",
  decision_record: "decision to record",
  goal_create: "new goal",
  goal_update: "goal change",
  bot_permission: "bot permission request",
  deal_create: "new deal",
  memory_note: "note",
  comment: "comment",
  task_archive: "archive a task",
  handoff_reassign: "reassign a handoff",
  tool_call: "paused tool call",
};
export const kindWords = (kind: string) => KIND_WORDS[kind as ProposalKind | "tool_call"] ?? "proposal";

const SLUG = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** A bot's or agent's id if it is a plain slug, else nothing: anything else could be typed text. */
export const slugOf = (id: string | undefined) => (id !== undefined && SLUG.test(id) ? id : undefined);

/** Who made it: a bot's slug, else the agent's fixed name, else "a bot". */
export function whoWords(row: { bot?: string; agent?: string }): string {
  const bot = slugOf(row.bot);
  if (bot !== undefined) return bot;
  return row.agent !== undefined && isAgentId(row.agent) ? AGENT_NAMES[row.agent] : "a bot";
}

/** An age as "under 1h", "5h" or "3d". */
export function ageWords(ms: number): string {
  const hours = Math.floor(Math.max(0, ms) / 3_600_000);
  if (hours < 1) return "under 1h";
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export type DigestItem = { kind: string; who: string; createdAt: number };
export type Digest = {
  /** Of the open proposals, how many are pinned in "Cash and runway" (`cashReader`, convex/lib/cashGroup.ts: the page's rule). */
  cash: number;
  /** Handoffs to people open more than 24 hours with nothing done. */
  staleHandoffs: number;
  total: number;
  /** Of the total, tool calls waiting on a click. */
  paused: number;
  /** True when the read stopped at its cap: the total is "at least". */
  capped: boolean;
  byUrgency: Record<Urgency, number>;
  oldest: DigestItem[];
};

const plus = (digest: Digest) => (digest.capped ? "+" : "");

/** The Telegram message (HTML, but built only from the fixed words above). */
export function digestMessage(digest: Digest, now: number): string {
  const { byUrgency: u } = digest;
  const lines = [
    `Approvals waiting: ${digest.total}${plus(digest)}`,
    `Critical ${u.critical} · High ${u.high} · Normal ${u.normal} · Low ${u.low}`,
    ...(digest.cash > 0 ? [`Cash and runway: ${digest.cash}`] : []),
    ...(digest.staleHandoffs > 0 ? [`Handoffs to people open over 24h: ${digest.staleHandoffs}`] : []),
    ...(digest.oldest.length === 0
      ? []
      : [
          "",
          "Oldest:",
          ...digest.oldest.map(
            (item, i) => `${i + 1}. ${capital(kindWords(item.kind))}, ${item.who}, ${ageWords(now - item.createdAt)}`,
          ),
        ]),
    "",
    APPROVALS_URL,
  ];
  return lines.join("\n");
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Why nothing went to Telegram, in fixed words, for the in-app row. */
export const NOT_SENT = {
  off: "Telegram: not sent, the bot is switched off or has no token.",
  unlinked: "Telegram: not sent, your Telegram account is not linked yet.",
} as const;

/** The in-app notification's title: the counts, and where Telegram stands. */
export function digestTitle(digest: Digest, note?: string): string {
  const { byUrgency: u } = digest;
  const counts = URGENCIES.filter((name) => u[name] > 0)
    .map((name) => `${u[name]} ${name}`)
    .join(", ");
  const extra = [
    digest.cash > 0 ? `${digest.cash} in cash and runway` : undefined,
    digest.staleHandoffs > 0
      ? `${digest.staleHandoffs} ${digest.staleHandoffs === 1 ? "handoff" : "handoffs"} to people open over 24h`
      : undefined,
  ].filter((part) => part !== undefined);
  const head = [`${digest.total}${plus(digest)} waiting for approval${counts === "" ? "" : ` (${counts})`}`, ...extra].join("; ");
  return note === undefined ? head : `${head}. ${note}`;
}
