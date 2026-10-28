import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { NOW_S, HOUR_S, conversation, searchPage, startedOn, statistics } from "../connectors/intercom.fixtures";
import { parseSearch, toRecord, type IntercomConversation } from "./supportParse";

const one = (over: Record<string, unknown> = {}): IntercomConversation =>
  parseSearch(searchPage([conversation(over)])).conversations[0]!;
const row = (over: Record<string, unknown> = {}) => toRecord(one(over));
const at = (seconds: number) => new Date(seconds * 1000).toISOString();

describe("toRecord: one pushed record per conversation, and only what the OS keeps", () => {
  test("the fields kept, from a conversation that holds everything", () => {
    expect(
      row({
        admin_assignee_id: 41,
        admin_assignee: { id: 41, name: "Made-up Teammate", email: "SECRET@example.test" },
        priority: "priority",
        conversation_rating: { rating: 4, remark: "SECRET", contact: { id: "c1" } },
      }),
    ).toEqual({
      id: "900000001",
      createdAt: at(NOW_S - 5 * HOUR_S),
      updatedAt: at(NOW_S - 4 * HOUR_S),
      state: "open",
      open: true,
      priority: true,
      waitingSince: at(NOW_S - 4 * HOUR_S),
      origin: "customer",
      pageArea: "studies/report",
      finParticipated: true,
      finOutcome: "escalated",
      humanRepliedAt: null,
      timeToHumanReply: null,
      lastCustomerReplyAt: at(NOW_S - 4 * HOUR_S),
      lastHumanReplyAt: null,
      assignee: { id: "41", name: "Made-up Teammate" },
      parts: 6,
      reopens: 0,
      rating: 4,
      articles: ["How to upload a study"],
    });
  });

  test("no body, subject, contact, author, email, phone, company or title reaches a row", () => {
    const stored = JSON.stringify([row(), row({ admin_assignee_id: "42" })]).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "");
    expect(stored).not.toContain("SECRET");
    expect(stored).not.toContain("@");
    expect(stored).not.toContain("patient");
    expect(stored).not.toContain("?");
  });

  test("the parsed conversation itself holds none of those fields: they are dropped at the door", () => {
    const parsed = JSON.stringify(one());
    // (The page it began on is read, to be reduced to a class and an area: it is in no row.)
    for (const secret of ["SECRET BODY", "SECRET SUBJECT", "SECRET AUTHOR", "SECRET@", "SECRET CLINIC", "SECRET TITLE", "SECRET PART", "SECRET REMARK", "SECRET-EXTERNAL", "SECRET-ADMIN", "+7"]) {
      expect(parsed).not.toContain(secret);
    }
    for (const field of ["body", "subject", "contacts", "author", "email", "phone", "source", "custom_attributes"]) {
      expect(parsed).not.toContain(`"${field}"`);
    }
  });

  test("a chat Fin did not answer has no outcome; an outcome Intercom adds later is not guessed", () => {
    expect(row({ ai_agent_participated: false, ai_agent: null })).toMatchObject({
      finParticipated: false,
      finOutcome: null,
      articles: [],
    });
    expect(
      row({ ai_agent: { ...(conversation().ai_agent as object), resolution_state: "something_new" } }),
    ).toMatchObject({ finParticipated: true, finOutcome: null });
    for (const state of ["assumed_resolution", "confirmed_resolution", "negative_feedback"]) {
      expect(row({ ai_agent: { resolution_state: state } }).finOutcome).toBe(state);
    }
  });

  test("a human's reply: the first reply's time and how long it took", () => {
    const replied = row({
      statistics: statistics({
        first_admin_reply_at: NOW_S - 3 * HOUR_S,
        time_to_admin_reply: 7200,
        last_admin_reply_at: NOW_S - HOUR_S,
      }),
    });
    expect(replied).toMatchObject({
      humanRepliedAt: at(NOW_S - 3 * HOUR_S),
      timeToHumanReply: 7200,
      lastHumanReplyAt: at(NOW_S - HOUR_S),
    });
  });

  test("where it started decides its origin; only a customer's has a page area", () => {
    expect(row(startedOn("http://localhost:3000/dashboard/studies"))).toMatchObject({ origin: "test", pageArea: null });
    expect(row(startedOn("https://atlas.example.com/x"))).toMatchObject({ origin: "other", pageArea: null });
    expect(row(startedOn(null))).toMatchObject({ origin: "unknown", pageArea: null });
  });

  test("an assignee's name only where the conversation carries one; else the id alone; none is unassigned", () => {
    expect(row({ admin_assignee_id: 77 }).assignee).toEqual({ id: "77", name: null });
    expect(
      row({ admin_assignee_id: 77, teammates: { type: "admin.list", admins: [{ type: "admin", id: 77, name: "Named Here" }] } }).assignee,
    ).toEqual({ id: "77", name: "Named Here" });
    expect(row({ admin_assignee_id: null }).assignee).toBeNull();
    expect(row({ admin_assignee_id: 0 }).assignee).toBeNull();
  });

  test("a conversation's tags are never read: they often hold a customer's or a clinic's name", () => {
    expect(row()).not.toHaveProperty("tags");
    expect(JSON.stringify(one())).not.toContain("billing");
  });

  test("text from Intercom is cleaned and cut, and lists are capped", () => {
    const sources = Array.from({ length: 30 }, (_, i) => ({ content_type: "article", title: `Article​ ${i}\n${"x".repeat(300)}` }));
    const r = row({
      ai_agent: { resolution_state: "escalated", content_sources: { content_sources: sources } },
    });
    expect(r.articles).toHaveLength(10);
    expect(r.articles[0]!.startsWith("Article 0 x")).toBe(true);
    expect(r.articles[0]!.length).toBeLessThanOrEqual(120);
    expect(r.articles[0]).not.toContain("​");
  });

  test("a rating is a whole number from 1 to 5, or nothing", () => {
    expect(row({ conversation_rating: { rating: 9 } }).rating).toBeNull();
    expect(row({ conversation_rating: { rating: 2 } }).rating).toBe(2);
    expect(row({ conversation_rating: null }).rating).toBeNull();
  });
});

describe("parseSearch", () => {
  test("the next page's cursor, or none, and the total Intercom says matched", () => {
    expect(parseSearch(searchPage([conversation()], "cursor-2")).next).toBe("cursor-2");
    expect(parseSearch(searchPage([conversation()])).next).toBeNull();
    expect(parseSearch(searchPage([conversation()])).total).toBe(1);
  });

  test("a conversation that is not in the expected shape fails the read, naming where only", () => {
    expect(() => parseSearch(searchPage([conversation({ created_at: "SECRET" })]))).toThrow(
      // Intercom's own key is not a plain word, so even it is not repeated.
      "Intercom's conversations response is not in the expected shape (conversations.0.?).",
    );
    expect(() => parseSearch({ nope: true })).toThrow("Intercom's conversations response is not in the expected shape");
  });
});

describe("the code that reads Intercom's objects", () => {
  // A source test: whatever a fixture holds, the reading code names none of
  // these fields, so none can be copied into a row.
  const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const NEVER = ["body", "subject", "contacts", "author", "email", "phone", "company", "companies", "custom_attributes", "conversation_parts", "source", "tags"];

  test.each(["supportParse.ts", "support.ts", "supportRecords.ts"])("convex/lib/%s reads none of the private fields", (file) => {
    const code = strip(readFileSync(join(__dirname, file), "utf8"));
    for (const field of NEVER) {
      expect([file, field, new RegExp(`\\.${field}\\b|\\b${field}\\s*:|\\["${field}"\\]`).test(code)]).toEqual([
        file,
        field,
        false,
      ]);
    }
  });
});
