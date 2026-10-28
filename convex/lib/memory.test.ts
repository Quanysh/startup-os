// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  MAX_DECISION_CONTEXT,
  MAX_OUTSIDE_ATTENDEES,
  MEMORY_WORDS,
  agentCut,
  cleanMemoryLines,
  cleanOutsideNames,
  cleanTags,
  isRevisitDue,
} from "./memory";

describe("text kept in company memory", () => {
  test("is cleaned of what the eye cannot see, and kept in lines", () => {
    expect(cleanMemoryLines("  one\u200b line \n\n\n two\u0007 ", MAX_DECISION_CONTEXT, "That context")).toBe(
      "one line\n\ntwo",
    );
  });

  test("over its limit is refused, never cut", () => {
    expect(() => cleanMemoryLines("x".repeat(MAX_DECISION_CONTEXT + 1), MAX_DECISION_CONTEXT, "That context")).toThrow(
      `That context is too long (${MAX_DECISION_CONTEXT} characters at most).`,
    );
  });
});

describe("outside attendees", () => {
  test("are names, cleaned, blanks and repeats dropped", () => {
    expect(cleanOutsideNames([" Ada  Example ", "", "Ada Example", "Sam\u200b Sample"])).toEqual([
      "Ada Example",
      "Sam Sample",
    ]);
  });

  test("an address among them is refused in a fixed sentence that does not quote it", () => {
    let message = "";
    try {
      cleanOutsideNames(["Ada", "ada@example.test"]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(MEMORY_WORDS.noAddresses);
    expect(message).not.toContain("example.test");
  });

  test("more than the limit is refused", () => {
    const many = Array.from({ length: MAX_OUTSIDE_ATTENDEES + 1 }, (_, i) => `Person ${i}`);
    expect(() => cleanOutsideNames(many)).toThrow(MEMORY_WORDS.tooManyAttendees);
  });
});

describe("tags", () => {
  test("are lower-cased words, each once", () => {
    expect(cleanTags([" Hiring ", "hiring", "Q4 plan", ""])).toEqual(["hiring", "q4 plan"]);
  });
});

describe("a revisit", () => {
  test("is due on its day and after, and not before", () => {
    expect(isRevisitDue({ revisitOn: "2026-10-14", status: "decided" }, "2026-10-13")).toBe(false);
    expect(isRevisitDue({ revisitOn: "2026-10-14", status: "decided" }, "2026-10-14")).toBe(true);
    expect(isRevisitDue({ revisitOn: "2026-10-14", status: "revisit" }, "2026-11-01")).toBe(true);
  });

  test("is never due without a date, or for a decision reversed", () => {
    expect(isRevisitDue({ revisitOn: undefined, status: "decided" }, "2026-10-14")).toBe(false);
    expect(isRevisitDue({ revisitOn: "2026-10-01", status: "reversed" }, "2026-10-14")).toBe(false);
  });
});

describe("what an agent is sent", () => {
  test("is cut to 500 characters with an ellipsis", () => {
    expect(agentCut("x".repeat(600))).toHaveLength(500);
    expect(agentCut("x".repeat(600))?.endsWith("…")).toBe(true);
    expect(agentCut("short")).toBe("short");
    expect(agentCut(undefined)).toBeNull();
  });
});
