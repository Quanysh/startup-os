// Made-up Intercom conversations, in the shape Claude's Intercom connector
// returns them (the REST API's conversation objects), for the mapper's, the
// push's and the script's tests. Every value is invented. The fields
// the OS must never keep (a message's body and subject, the contacts, an
// author, an email address, a phone number, a company) are filled with
// `SECRET…` words, so a test can prove none of them reaches a stored row.

/** 2026-10-17T09:00:00Z, in Intercom's seconds. */
export const NOW_S = 1_792_227_600;
export const NOW_MS = NOW_S * 1000;
export const HOUR_S = 3600;
export const DAY_S = 24 * HOUR_S;

/** A made-up workspace id code. */
export const APP_ID = "made0up1";

/** One conversation as Intercom sends it; `over` replaces fields at the top. */
export function conversation(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "conversation",
    id: "900000001",
    title: "SECRET TITLE about a patient",
    created_at: NOW_S - 5 * HOUR_S,
    updated_at: NOW_S - 4 * HOUR_S,
    waiting_since: NOW_S - 4 * HOUR_S,
    snoozed_until: null,
    open: true,
    state: "open",
    read: false,
    priority: "not_priority",
    admin_assignee_id: null,
    team_assignee_id: "7",
    tags: {
      type: "tag.list",
      tags: [
        { type: "tag", id: "1", name: "billing", applied_at: NOW_S, applied_by: { type: "admin", id: "1" } },
      ],
    },
    conversation_rating: null,
    source: {
      type: "conversation",
      id: "1",
      delivered_as: "customer_initiated",
      subject: "SECRET SUBJECT",
      body: "<p>SECRET BODY: patient Ivanov, IIN 900101300123</p>",
      author: { type: "user", id: "c1", name: "SECRET AUTHOR", email: "SECRET@example.test" },
      attachments: [],
      url: "https://app.second.example.test/dashboard/studies/123456/report?patient=SECRET",
      redacted: false,
    },
    contacts: {
      type: "contact.list",
      contacts: [{ type: "contact", id: "c1", external_id: "SECRET-EXTERNAL" }],
    },
    teammates: { type: "admin.list", admins: [] },
    custom_attributes: { "Company name": "SECRET CLINIC", phone: "+7 700 SECRET" },
    first_contact_reply: {
      created_at: NOW_S - 5 * HOUR_S,
      type: "conversation",
      url: "https://app.second.example.test/dashboard/studies/123456/report?patient=SECRET",
    },
    sla_applied: null,
    statistics: {
      type: "conversation_statistics",
      time_to_assignment: null,
      time_to_admin_reply: null,
      time_to_first_close: null,
      time_to_last_close: null,
      median_time_to_reply: null,
      first_contact_reply_at: NOW_S - 5 * HOUR_S,
      first_assignment_at: null,
      first_admin_reply_at: null,
      first_close_at: null,
      last_assignment_at: null,
      last_assignment_admin_reply_at: null,
      last_contact_reply_at: NOW_S - 4 * HOUR_S,
      last_admin_reply_at: null,
      last_close_at: null,
      last_closed_by_id: null,
      count_reopens: 0,
      count_assignments: 0,
      count_conversation_parts: 6,
    },
    conversation_parts: {
      type: "conversation_part.list",
      conversation_parts: [{ type: "conversation_part", body: "SECRET PART BODY", author: { email: "SECRET@example.test" } }],
      total_count: 1,
    },
    linked_objects: { type: "list", data: [], total_count: 0, has_more: false },
    ai_agent_participated: true,
    ai_agent: {
      source_type: "essentials_plan_setup",
      source_title: null,
      last_answer_type: "ai_answer",
      resolution_state: "escalated",
      rating: null,
      rating_remark: "SECRET REMARK",
      content_sources: {
        type: "content_source.list",
        total_count: 1,
        content_sources: [
          { content_type: "article", url: "https://help.example.test/articles/1", title: "How to upload a study", locale: "ru" },
        ],
      },
    },
    ...over,
  };
}

/** A conversation's `statistics` with `over` laid on the base fixture's. */
export function statistics(over: Record<string, unknown>): Record<string, unknown> {
  return { ...(conversation().statistics as Record<string, unknown>), ...over };
}

/** `first_contact_reply` on another page, or none. */
export const startedOn = (url: string | null) =>
  url === null ? { first_contact_reply: null } : { first_contact_reply: { created_at: NOW_S, type: "conversation", url } };

/** One page of a search's answer. */
export function searchPage(conversations: unknown[], next: string | null = null) {
  return {
    type: "conversation.list",
    conversations,
    total_count: conversations.length,
    pages: {
      type: "pages",
      page: 1,
      per_page: 150,
      total_pages: next === null ? 1 : 2,
      ...(next === null ? {} : { next: { page: 2, starting_after: next } }),
    },
  };
}
