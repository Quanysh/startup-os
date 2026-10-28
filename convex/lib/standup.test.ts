import { describe, expect, test } from "vitest";
import { MAX_TITLE_LENGTH } from "./limits";
import {
  MAX_CONTEXT_LENGTH,
  MAX_STANDUP_TASKS,
  normalTitle,
  parseStandupPush,
  sameScope,
  standupDayLabel,
  standupNotes,
  utcDay,
} from "./standup";

// Noon UTC on the day of the standup these tests send.
const NOW = Date.UTC(2026, 9, 13, 12);

const task = (over: Record<string, unknown> = {}) => ({
  key: "a1",
  title: "Send the pilot contract",
  company: "us",
  ...over,
});
const push = (over: Record<string, unknown> = {}) => ({
  version: 1,
  meetingId: "01KFIREFLIES0001",
  meetingDate: "2026-10-13",
  tasks: [task()],
  ...over,
});
const parse = (raw: unknown) => parseStandupPush(raw, { now: NOW });
const issuesOf = (raw: unknown) => {
  const parsed = parse(raw);
  if (parsed.ok) throw new Error("expected a refusal");
  return parsed.issues;
};

describe("parseStandupPush", () => {
  test("a whole push comes back cleaned, with kind defaulted to task", () => {
    const parsed = parse(
      push({
        tasks: [
          task({
            title: "  Send   the pilot\ncontract ",
            assignee: "Sam@Example.com",
            due: "2026-10-20",
            context: " Agreed with the clinic. ",
          }),
          task({ key: "a2", title: "Fix the export", company: null, kind: "issue" }),
        ],
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      push: {
        version: 1,
        meetingId: "01KFIREFLIES0001",
        meetingDate: "2026-10-13",
        tasks: [
          {
            key: "a1",
            title: "Send the pilot contract",
            company: "us",
            kind: "task",
            assignee: "Sam@Example.com",
            due: "2026-10-20",
            context: "Agreed with the clinic.",
          },
          { key: "a2", title: "Fix the export", company: null, kind: "issue" },
        ],
      },
    });
  });

  test("an empty list of tasks is a push: the standup was read and nothing was missing", () => {
    expect(parse(push({ tasks: [] }))).toMatchObject({ ok: true, push: { tasks: [] } });
  });

  test("direction overrides and hidden characters are taken out of a title and a context", () => {
    const parsed = parse(
      push({
        tasks: [task({ title: "Pay‮ the​ invoice\u0007", context: "Said⁦ so﻿." })],
      }),
    );
    expect(parsed.ok && parsed.push.tasks[0]).toMatchObject({
      title: "Pay the invoice",
      context: "Said so.",
    });
  });

  test("a blank context is left out", () => {
    const parsed = parse(push({ tasks: [task({ context: "  \n " })] }));
    expect(parsed.ok && "context" in parsed.push.tasks[0]!).toBe(false);
  });

  test.each([
    ["not an object", "nope", "push"],
    ["an unknown field on the push", push({ summary: "SECRET summary" }), "push"],
    ["an unknown field on a task", push({ tasks: [task({ notes: "SECRET" })] }), "tasks.0"],
    ["a version the OS does not speak", push({ version: 2 }), "version"],
    ["no meeting id", push({ meetingId: undefined }), "meetingId"],
    ["a meeting id that is not an id", push({ meetingId: "SECRET meeting title" }), "meetingId"],
    ["no tasks field", push({ tasks: undefined }), "tasks"],
    ["a task with no key", push({ tasks: [task({ key: undefined })] }), "tasks.0.key"],
    ["a key that is not an id", push({ tasks: [task({ key: "SECRET key" })] }), "tasks.0.key"],
    ["a company the OS does not have", push({ tasks: [task({ company: "SECRET" })] }), "tasks.0.company"],
    ["a company left out", push({ tasks: [{ key: "a1", title: "x" }] }), "tasks.0.company"],
    ["a kind the board does not have", push({ tasks: [task({ kind: "SECRET" })] }), "tasks.0.kind"],
    ["a title that is not text", push({ tasks: [task({ title: 7 })] }), "tasks.0.title"],
    ["an assignee that is not text", push({ tasks: [task({ assignee: 7 })] }), "tasks.0.assignee"],
  ])("%s is refused at its path, in fixed words", (_what, raw, path) => {
    const issues = issuesOf(raw);
    expect(issues.map((issue) => issue.path)).toContain(path);
    expect(JSON.stringify(issues)).not.toContain("SECRET");
  });

  test.each([
    ["an empty title", task({ title: " ​ " }), "tasks.0.title", "is empty"],
    [
      "a title over the board's own cap",
      task({ title: "x".repeat(MAX_TITLE_LENGTH + 1) }),
      "tasks.0.title",
      `is too long (${MAX_TITLE_LENGTH} characters at most)`,
    ],
    [
      "a context over its cap",
      task({ context: "x".repeat(MAX_CONTEXT_LENGTH + 1) }),
      "tasks.0.context",
      `is too long (${MAX_CONTEXT_LENGTH} characters at most)`,
    ],
    ["a due date that is not a day", task({ due: "2026-02-30" }), "tasks.0.due", "is not a date (YYYY-MM-DD)"],
    ["a due date in another form", task({ due: "13 Oct" }), "tasks.0.due", "is not a date (YYYY-MM-DD)"],
  ])("%s", (_what, row, path, message) => {
    expect(issuesOf(push({ tasks: [row] }))).toEqual([{ path, message }]);
  });

  test("a title at the cap is taken", () => {
    expect(parse(push({ tasks: [task({ title: "x".repeat(MAX_TITLE_LENGTH) })] })).ok).toBe(true);
    expect(parse(push({ tasks: [task({ context: "x".repeat(MAX_CONTEXT_LENGTH) })] })).ok).toBe(true);
  });

  test("a key used twice in one meeting is refused on the second", () => {
    expect(issuesOf(push({ tasks: [task(), task({ title: "Another" })] }))).toEqual([
      { path: "tasks.1.key", message: "repeats an earlier key" },
    ]);
  });

  test(`more than ${MAX_STANDUP_TASKS} tasks is refused`, () => {
    const rows = (count: number) =>
      Array.from({ length: count }, (_, index) => task({ key: `a${index}`, title: `Task ${index}` }));
    expect(parse(push({ tasks: rows(MAX_STANDUP_TASKS) })).ok).toBe(true);
    expect(issuesOf(push({ tasks: rows(MAX_STANDUP_TASKS + 1) }))).toEqual([
      { path: "tasks", message: "is too long or too large" },
    ]);
  });

  test("a meeting date must be a real day", () => {
    expect(issuesOf(push({ meetingDate: "2026-13-01" }))).toEqual([
      { path: "meetingDate", message: "is not a date (YYYY-MM-DD)" },
    ]);
  });

  test("a meeting cannot be later than tomorrow: time zones allow a day, no more", () => {
    expect(parse(push({ meetingDate: "2026-10-14" })).ok).toBe(true);
    expect(issuesOf(push({ meetingDate: "2026-10-15" }))).toEqual([
      { path: "meetingDate", message: "is in the future" },
    ]);
  });

  test("one bad row refuses the push and every bad row is named", () => {
    const issues = issuesOf(
      push({ tasks: [task(), task({ key: "a2", title: "" }), task({ key: "a3", due: "soon" })] }),
    );
    expect(issues.map((issue) => issue.path)).toEqual(["tasks.1.title", "tasks.2.due"]);
  });
});

describe("normalTitle", () => {
  test.each([
    ["Send the Contract", "send the contract"],
    ["  send   the\tcontract ", "send the contract"],
    ["Send the contract.", "send the contract"],
    ["Send the contract!!", "send the contract"],
    ["Send, the: contract…", "send the contract"],
    ["Follow-up with the payer", "follow up with the payer"],
    ["Don’t forget the BAA", "dont forget the baa"],
    ["Don't forget the BAA", "dont forget the baa"],
    ["Подписать Договор.", "подписать договор"],
    ["Ｓｅｎｄ the contract", "send the contract"],
  ])("%j → %j", (title, key) => {
    expect(normalTitle(title)).toBe(key);
  });

  test("different words stay different", () => {
    expect(normalTitle("Send the contract")).not.toBe(normalTitle("Sign the contract"));
  });

  test("a title of punctuation alone has no key", () => {
    expect(normalTitle("?!…")).toBe("");
  });
});

describe("sameScope", () => {
  test("the same company, or either one shared", () => {
    expect(sameScope("us", "us")).toBe(true);
    expect(sameScope("us", null)).toBe(true);
    expect(sameScope(undefined, "kz")).toBe(true);
    expect(sameScope(null, undefined)).toBe(true);
  });
  test("not one company's against the other's", () => {
    expect(sameScope("us", "kz")).toBe(false);
  });
});

describe("words about the day", () => {
  test("a day is named by month and day", () => {
    expect(standupDayLabel("2026-10-13")).toBe("Oct 13");
    expect(standupDayLabel("2026-01-05")).toBe("Jan 5");
  });
  test("the note says where a card came from, and what was said", () => {
    expect(standupNotes("2026-10-13")).toBe("From the standup of Oct 13.");
    expect(standupNotes("2026-10-13", "Agreed with the clinic.")).toBe(
      "From the standup of Oct 13: Agreed with the clinic.",
    );
  });
  test("the UTC day of a moment", () => {
    expect(utcDay(Date.UTC(2026, 9, 13, 23, 59))).toBe("2026-10-13");
    expect(utcDay(Date.UTC(2026, 9, 14, 0, 0))).toBe("2026-10-14");
  });
});

describe("names and a deliberate shared card", () => {
  test("`named` and `speaker` come back cleaned, and \"shared\" is a company of its own", () => {
    const parsed = parse(
      push({
        tasks: [
          task({ company: null, named: "  Lena​ S. ", speaker: "Константин" }),
          task({ key: "a2", company: "shared" }),
        ],
      }),
    );
    if (!parsed.ok) throw new Error("expected a push");
    expect(parsed.push.tasks[0]).toMatchObject({ company: null, named: "Lena S.", speaker: "Константин" });
    expect(parsed.push.tasks[1]).toMatchObject({ company: "shared" });
    expect(parsed.push.tasks[1]).not.toHaveProperty("named");
  });

  test("an address or an over-long name in a name field is refused, without quoting it", () => {
    const issues = issuesOf(
      push({
        tasks: [task({ named: "SECRET@example.com" }), task({ key: "a2", speaker: "x".repeat(81) })],
      }),
    );
    expect(issues).toEqual([
      { path: "tasks.0.named", message: "is a name, not an address" },
      { path: "tasks.1.speaker", message: "is too long (80 characters at most)" },
    ]);
    expect(JSON.stringify(issues)).not.toContain("SECRET");
  });
});
