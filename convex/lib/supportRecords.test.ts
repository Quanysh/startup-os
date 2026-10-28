import { describe, expect, test } from "vitest";
import { APP_ID, NOW_MS, conversation } from "../connectors/intercom.fixtures";
import { MAX_SUPPORT_CONVERSATIONS } from "./support";
import { toRecord } from "./supportParse";
import { parseSearch } from "./supportParse";
import { SUPPORT_WORDS, parseSupportPush, type SupportRecord } from "./supportRecords";
import { searchPage } from "../connectors/intercom.fixtures";

const record = (over: Record<string, unknown> = {}): SupportRecord =>
  ({ ...toRecord(parseSearch(searchPage([conversation()])).conversations[0]!), ...over }) as SupportRecord;
const push = (records: unknown[], app: unknown = APP_ID) => parseSupportPush(records, app, NOW_MS);
const issuesOf = (records: unknown[], app: unknown = APP_ID) => {
  const read = push(records, app);
  return read.ok ? [] : read.issues;
};

describe("parseSupportPush", () => {
  test("a record the mapper made is taken as it is, its times in ms", () => {
    const read = push([record()]);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.appId).toBe(APP_ID);
    expect(read.rows[0]).toMatchObject({
      intercomId: "900000001",
      origin: "customer",
      pageArea: "studies/report",
      createdAt: NOW_MS - 5 * 3600 * 1000,
      assigneeId: null,
      assigneeName: null,
    });
  });

  test("an unknown field refuses the push, and the issue names no value", () => {
    const issues = issuesOf([{ ...record(), body: "SECRET BODY" }]);
    expect(issues).toEqual([{ path: "records.0", message: "has a field the OS does not accept" }]);
    // Tags are not kept either: they often hold a customer's or a clinic's name.
    for (const field of ["subject", "contacts", "author", "email", "phone", "url", "title", "company", "tags"]) {
      expect(issuesOf([{ ...record(), [field]: "SECRET" }])).toHaveLength(1);
    }
    expect(issuesOf([record({ assignee: { id: "41", name: "Made-up", email: "SECRET@x.kz" } })])[0]!.path).toBe(
      "records.0.assignee",
    );
  });

  test("the workspace's id code is needed, and only plainly one", () => {
    expect(issuesOf([record()], null)).toEqual([{ path: "appIdCode", message: SUPPORT_WORDS.appIdCode }]);
    expect(issuesOf([record()], "../evil")).toHaveLength(1);
  });

  test("a page area is held to the plain-word pattern, and only on a customer's chat", () => {
    for (const area of ["studies/123456", "https://app.second.example.test/dashboard", "studies?x=1", "a/b/c"]) {
      expect(issuesOf([record({ pageArea: area })])).toEqual([
        { path: "records.0.pageArea", message: SUPPORT_WORDS.pageArea },
      ]);
    }
    expect(issuesOf([record({ origin: "test" })])).toEqual([
      { path: "records.0.pageArea", message: SUPPORT_WORDS.pageArea },
    ]);
    expect(issuesOf([record({ origin: "test", pageArea: null })])).toEqual([]);
  });

  test("text is bounded: over its cap is refused, and what is invisible is cleaned", () => {
    expect(issuesOf([record({ articles: ["x".repeat(121)] })])[0]!.path).toBe("records.0.articles.0");
    expect(issuesOf([record({ assignee: { id: "41", name: "x".repeat(61) } })])[0]!.path).toBe("records.0.assignee.name");
    const read = push([record({ assignee: { id: "41", name: "\u200b" } })]);
    expect(read.ok).toBe(false);
    const clean = push([record({ assignee: { id: "41", name: "Made\u200b-up" } })]);
    expect(clean.ok && clean.rows[0]!.assigneeName).toBe("Made-up");
  });

  test("Fin's outcome only for a chat Fin answered; no time in the future; no chat twice", () => {
    expect(issuesOf([record({ finParticipated: false })])).toEqual([
      { path: "records.0.finOutcome", message: SUPPORT_WORDS.finOutcome },
    ]);
    expect(issuesOf([record({ updatedAt: new Date(NOW_MS + 3600_000).toISOString() })])).toEqual([
      { path: "records.0.updatedAt", message: SUPPORT_WORDS.future },
    ]);
    expect(issuesOf([record(), record()])).toEqual([{ path: "records.1.id", message: SUPPORT_WORDS.twice }]);
  });

  test("too many conversations in one push is refused whole", () => {
    const many = Array.from({ length: MAX_SUPPORT_CONVERSATIONS + 1 }, (_, i) => record({ id: String(i + 1) }));
    expect(issuesOf(many)).toEqual([{ path: "records", message: SUPPORT_WORDS.tooMany }]);
  });
});
