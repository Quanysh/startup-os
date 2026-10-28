import { describe, expect, test } from "vitest";
import { CHAT_PAGES, HOW_IT_WORKS, STEP_LABELS, runnerLine, stepChips, textParts } from "./chat";

const NOW = new Date(2026, 9, 14, 14, 30, 0).getTime();

describe("an answer's text", () => {
  test("is one piece of text when it names no page", () => {
    expect(textParts("Made-up answer.\nSecond line.")).toEqual([{ text: "Made-up answer.\nSecond line." }]);
    expect(textParts("")).toEqual([]);
  });

  test("a path of the app's own, standing as a word, becomes a link to that page", () => {
    expect(textParts("They are on /sales. See also (/board), and /finance")).toEqual([
      { text: "They are on " },
      { page: "/sales" },
      { text: ". See also (" },
      { page: "/board" },
      { text: "), and " },
      { page: "/finance" },
    ]);
  });

  test.each([
    "https://evil.test/sales",
    "evil.test/sales",
    "//evil.test",
    "/sales/../payroll",
    "/payroll",
    "/settings/team",
    "/salesforce",
    "and/or /unknown",
    "a / b",
    "/Sales",
    "javascript:/sales",
    "/sales?next=https://evil.test",
    "/sales#x",
    "[x](/sales)x/board",
  ])("nothing else is ever a link: %s", (text) => {
    expect(textParts(text).filter((part) => "page" in part)).toEqual([]);
    expect(textParts(text).map((part) => ("page" in part ? part.page : part.text)).join("")).toBe(text);
  });

  test("markup stays the characters it is, around a link too", () => {
    const parts = textParts('<a href="https://evil.test">x</a> **bold** [t](https://evil.test) /sales');
    expect(parts).toEqual([
      { text: '<a href="https://evil.test">x</a> **bold** [t](https://evil.test) ' },
      { page: "/sales" },
    ]);
    // Joined back, it is the answer exactly.
    const whole = "On /board and /sales, not /payroll.";
    expect(textParts(whole).map((part) => ("page" in part ? part.page : part.text)).join("")).toBe(whole);
  });

  test("every page it links is one of the closed list", () => {
    const pages: readonly string[] = CHAT_PAGES;
    for (const page of CHAT_PAGES.filter((path) => path !== "/")) {
      expect(textParts(`on ${page}.`)).toContainEqual({ page });
      expect(pages).toContain(page);
    }
  });
});

describe("the steps under an answer", () => {
  test("are short labels, and a tool used again is said once with how often", () => {
    expect(stepChips(["tasks", "deals", "tasks", "tasks", "propose"])).toEqual([
      { label: STEP_LABELS.tasks, times: 3 },
      { label: STEP_LABELS.deals, times: 1 },
      { label: STEP_LABELS.propose, times: 1 },
    ]);
    expect(stepChips([])).toEqual([]);
    expect(stepChips(["not_a_tool"])).toEqual([]);
  });
});

describe("whether the Mac is answering", () => {
  test("says so when it checked in lately", () => {
    expect(runnerLine({ checkedInAt: NOW - 10_000, everyMs: 3_000 }, NOW)).toEqual({
      there: true,
      text: "Answered by Claude on your Mac.",
    });
    expect(runnerLine({ checkedInAt: NOW - 50_000, everyMs: 60_000 }, NOW)).toEqual({
      there: true,
      text: "Answered by Claude on your Mac. It is idle and checks every 60 seconds, so an answer may take that long to start.",
    });
  });

  test("says since when it has not, and how to start it", () => {
    const at = new Date(2026, 9, 14, 14, 2, 0).getTime();
    expect(runnerLine({ checkedInAt: at, everyMs: 3_000 }, NOW)).toEqual({
      there: false,
      text: "Your Mac has not checked in since 14:02. Questions wait until it does.",
    });
    const yesterday = new Date(2026, 9, 13, 9, 5, 0).getTime();
    expect(runnerLine({ checkedInAt: yesterday, everyMs: 3_000 }, NOW).text).toBe(
      "Your Mac has not checked in since Oct 13 at 09:05. Questions wait until it does.",
    );
    expect(runnerLine({ checkedInAt: null, everyMs: null }, NOW)).toEqual({
      there: false,
      text: "Your Mac has never checked in. Questions wait until it does.",
    });
  });

  test("how it works names what runs where, what passes through Claude and what never does, and the two commands", () => {
    const text = HOW_IT_WORKS.join(" ");
    expect(text).toMatch(/Claude subscription/);
    expect(text).toMatch(/no model key/i);
    expect(text).toMatch(/task titles, deal and clinic names, pull-request titles, metric values, and the decisions and meeting notes kept in Memory/);
    expect(text).toMatch(/Never payroll, tokens, mail or calendar/);
    expect(text).toContain("pnpm assistant:runner");
    expect(text).toContain("pnpm assistant:runner:install");
  });
});
