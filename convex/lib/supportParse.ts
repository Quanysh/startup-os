// Intercom's conversations, as the Intercom connector on the owner's Mac
// returns them from `search_conversations` (the REST API's conversation
// objects), mapped to the records the hourly task pushes
// (./supportRecords.ts, `SupportRecord`). Run by `pnpm support:envelope`
// (scripts/supportEnvelope.ts) on the Mac: Startup OS never calls Intercom.
//
// **The schemas below name only the fields that are kept** (zod drops every
// other key), so a message's text, its subject, the contacts, an author, an
// address, a phone number, a company and every custom field are dropped at
// the door and never reach a variable here, let alone a row. A test reads
// this file and fails if it names one of them.
//
// A string Intercom sent becomes a row field in four places only, each
// cleaned and cut: a teammate's name, a help article's title, a tag's name,
// and (checked against a pattern) an id. Where a chat started is reduced to
// a class and a page area (`originOf`, `pageAreaOf`) and the URL is dropped.
// Pure.

import { z } from "zod";
import { expectShape } from "../connectors/shape";
import { cleanRemote } from "./mirrorRules";
import {
  FIN_OUTCOMES,
  MAX_ARTICLES,
  MAX_ARTICLE_TITLE,
  MAX_ASSIGNEE_NAME,
  SUPPORT_STATES,
  originOf,
  pageAreaOf,
  type FinOutcome,
} from "./support";
import type { SupportRecord } from "./supportRecords";

const WHO = "Intercom";

/** Intercom's times are whole seconds since the epoch. */
const seconds = z.number().int().nonnegative();
const maybeSeconds = seconds.nullish();
const count = z.number().int().nonnegative().nullish();
/** An id Intercom sends as a number or a string. */
const anyId = z.union([z.string(), z.number()]).nullish();

const conversationSchema = z.object({
  id: z.string().regex(/^\d{1,30}$/),
  created_at: seconds,
  updated_at: seconds,
  state: z.enum(SUPPORT_STATES),
  open: z.boolean(),
  priority: z.string().nullish(),
  waiting_since: maybeSeconds,
  admin_assignee_id: anyId,
  // A teammate's name, where the connector puts one on the conversation. It
  // has no list of teammates, so a chat whose assignee is named nowhere here
  // is kept by id alone.
  admin_assignee: z.object({ id: anyId, name: z.string().nullish() }).nullish(),
  teammates: z
    .object({ admins: z.array(z.object({ id: anyId, name: z.string().nullish() })).nullish() })
    .nullish(),
  first_contact_reply: z.object({ url: z.string().nullish() }).nullish(),
  statistics: z
    .object({
      time_to_admin_reply: count,
      first_admin_reply_at: maybeSeconds,
      last_contact_reply_at: maybeSeconds,
      last_admin_reply_at: maybeSeconds,
      count_conversation_parts: count,
      count_reopens: count,
    })
    .nullish(),
  ai_agent_participated: z.boolean().nullish(),
  ai_agent: z
    .object({
      resolution_state: z.string().nullish(),
      content_sources: z
        .object({ content_sources: z.array(z.object({ title: z.string().nullish() })).nullish() })
        .nullish(),
    })
    .nullish(),
  conversation_rating: z.object({ rating: z.number().nullish() }).nullish(),
});
export type IntercomConversation = z.infer<typeof conversationSchema>;

const searchSchema = z.object({
  conversations: z.array(conversationSchema),
  total_count: z.number().int().nonnegative().nullish(),
  pages: z
    .object({ next: z.object({ starting_after: z.string().min(1).max(500).nullish() }).nullish() })
    .nullish(),
});

export type SearchPage = { conversations: IntercomConversation[]; next: string | null; total: number | null };

/** One page of a conversation search: its conversations, the cursor of the next page if any, and the total Intercom says matched. */
export function parseSearch(raw: unknown): SearchPage {
  const page = expectShape(searchSchema, raw, WHO, "conversations");
  return {
    conversations: page.conversations,
    next: page.pages?.next?.starting_after ?? null,
    total: page.total_count ?? null,
  };
}

/** A positive id as digits, or null (Intercom sends 0 or null for "nobody"). */
function idOf(value: string | number | null | undefined): string | null {
  const text = typeof value === "number" ? String(value) : (value ?? "");
  return /^\d{1,30}$/.test(text) && !/^0+$/.test(text) ? text : null;
}

/** Intercom's seconds as an ISO time, the envelope's form. */
const iso = (value: number) => new Date(value * 1000).toISOString();
const isoOrNull = (value: number | null | undefined) => (value === null || value === undefined ? null : iso(value));

const isFinOutcome = (value: unknown): value is FinOutcome => FIN_OUTCOMES.includes(value as FinOutcome);

/** Each text cleaned and cut, the empty ones dropped, each once, at most `max`. */
function texts(values: readonly (string | null | undefined)[], cut: number, max: number): string[] {
  const kept: string[] = [];
  for (const value of values) {
    const text = cleanRemote(value ?? "", cut);
    if (text !== "" && !kept.includes(text)) kept.push(text);
    if (kept.length === max) break;
  }
  return kept;
}

/** The assignee's name, where the conversation itself carries one. */
function nameOf(chat: IntercomConversation, id: string): string | null {
  const named = [chat.admin_assignee, ...(chat.teammates?.admins ?? [])].find(
    (admin) => admin !== null && admin !== undefined && idOf(admin.id) === id,
  );
  const name = cleanRemote(named?.name ?? "", MAX_ASSIGNEE_NAME);
  return name === "" ? null : name;
}

/** One conversation as the hourly task pushes it, and nothing more. */
export function toRecord(chat: IntercomConversation): SupportRecord {
  const stats = chat.statistics ?? {};
  const url = chat.first_contact_reply?.url ?? null;
  const finParticipated = chat.ai_agent_participated === true;
  const outcome = chat.ai_agent?.resolution_state;
  const assigneeId = idOf(chat.admin_assignee_id ?? chat.admin_assignee?.id);
  const rating = chat.conversation_rating?.rating;
  return {
    id: chat.id,
    createdAt: iso(chat.created_at),
    updatedAt: iso(chat.updated_at),
    state: chat.state,
    open: chat.open,
    priority: chat.priority === "priority",
    waitingSince: isoOrNull(chat.waiting_since),
    origin: originOf(url),
    pageArea: pageAreaOf(url),
    finParticipated,
    finOutcome: finParticipated && isFinOutcome(outcome) ? outcome : null,
    humanRepliedAt: isoOrNull(stats.first_admin_reply_at),
    timeToHumanReply: stats.time_to_admin_reply ?? null,
    lastCustomerReplyAt: isoOrNull(stats.last_contact_reply_at),
    lastHumanReplyAt: isoOrNull(stats.last_admin_reply_at),
    assignee: assigneeId === null ? null : { id: assigneeId, name: nameOf(chat, assigneeId) },
    parts: stats.count_conversation_parts ?? null,
    reopens: stats.count_reopens ?? null,
    rating: typeof rating === "number" && Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null,
    articles: finParticipated
      ? texts(
          (chat.ai_agent?.content_sources?.content_sources ?? []).map((item) => item.title),
          MAX_ARTICLE_TITLE,
          MAX_ARTICLES,
        )
      : [],
  };
}
