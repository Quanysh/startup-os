import { describe, expect, test } from "vitest";
import {
  changedParts,
  changes,
  lineDiff,
  placeWords,
  problemsByVariant,
  templateSegments,
  paramsFromText,
  paramsText,
  partsWords,
  prettyJson,
  runCountWords,
  versionStatusWords,
} from "./harness";

describe("lineDiff", () => {
  test("keeps, adds and removes lines in order", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "x" },
      { kind: "same", text: "c" },
    ]);
    expect(changes(lineDiff("a", "a"))).toBe(false);
    expect(lineDiff("", "new")).toEqual([{ kind: "added", text: "new" }]);
    expect(lineDiff("old", "")).toEqual([{ kind: "removed", text: "old" }]);
  });
});

describe("words", () => {
  test("what a version changes", () => {
    expect(partsWords([])).toBe("The project's built-in harness, unchanged");
    expect(partsWords(["prompt"])).toBe("Changes the prompt");
    expect(partsWords(["prompt", "tools"])).toBe("Changes the prompt and tools");
    expect(partsWords(["params", "tools", "outputSchema"])).toBe("Changes the parameters, tools and output schema");
    const prompt = { variants: { default: { system: "", user: "" } } };
    expect(changedParts({ prompt, tools: [] })).toEqual(["prompt", "tools"]);
    expect(changedParts({})).toEqual([]);
  });

  test("a version's state", () => {
    expect(versionStatusWords("draft", false)).toBe("Draft");
    expect(versionStatusWords("published", true)).toBe("Published");
    expect(versionStatusWords("archived", true)).toBe("Archived");
    expect(versionStatusWords("archived", false)).toBe("Discarded draft");
  });

  test("a run's count: a missing answer is said, never counted as a pass", () => {
    expect(runCountWords({ status: "done", expected: 4, received: 4, passed: 3 })).toBe("3 of 4 passed");
    expect(runCountWords({ status: "done", expected: 4, received: 3, passed: 3 })).toBe("3 of 4 passed, 1 not answered");
    expect(runCountWords({ status: "queued", expected: 4, received: 0, passed: 0 })).toBe("Waiting for the project");
    expect(runCountWords({ status: "expired", expected: 4, received: 0, passed: 0 })).toBe(
      "Given up: the project did not answer",
    );
  });
});

describe("the params form", () => {
  test("every parameter is a field; a blank one is left out; a non-number is kept for the rules to name", () => {
    expect(paramsText({ temperature: 0.2 })).toEqual({
      temperature: "0.2",
      maxOutputTokens: "",
      thinkingBudget: "",
      timeoutMs: "",
      retries: "",
    });
    expect(paramsFromText({ temperature: "0.5", retries: " 2 " })).toEqual({ temperature: 0.5, retries: 2 });
    expect(paramsFromText({ temperature: "" })).toBeNull();
    expect(Number.isNaN(paramsFromText({ temperature: "hot" })!.temperature)).toBe(true);
  });
});

test("prettyJson lays JSON out, and leaves what is not JSON as typed", () => {
  expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
  expect(prettyJson("{")).toBe("{");
  expect(prettyJson(null)).toBe("");
});

describe("v1.2 in the editor", () => {
  test("a template in pieces, each section marked, every character kept", () => {
    const text = "Base.\n{{#denial}}Denied: {{denial}}.{{/denial}} then {{^denial}}none{{/denial}}";
    const pieces = templateSegments(text);
    expect(pieces.map((piece) => piece.text).join("")).toBe(text);
    expect(pieces).toEqual([
      { text: "Base.\n", section: null },
      { text: "{{#denial}}Denied: {{denial}}.{{/denial}}", section: { name: "denial", inverted: false } },
      { text: " then ", section: null },
      { text: "{{^denial}}none{{/denial}}", section: { name: "denial", inverted: true } },
    ]);
    expect(templateSegments("")).toEqual([]);
    expect(templateSegments("{{#open}} never closed")).toEqual([{ text: "{{#open}} never closed", section: null }]);
  });

  test("where a problem is, in words", () => {
    expect(placeWords({ path: "prompt.retry.system", message: "x", at: { line: 2, column: 13 } })).toBe("line 2, column 13");
    expect(placeWords({ path: "prompt", message: "x" })).toBe("");
  });

  test("problems counted by the variant they are in", () => {
    const counts = problemsByVariant([
      { path: "prompt.retry.system", message: "a" },
      { path: "prompt.retry.user", message: "b" },
      { path: "prompt.default.system", message: "c" },
      { path: "prompt", message: "d" },
      { path: "params.temperature", message: "e" },
    ]);
    expect(Object.fromEntries(counts)).toEqual({ retry: 2, default: 1 });
  });
});
