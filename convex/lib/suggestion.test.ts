import { describe, expect, test } from "vitest";
import { MAX_TITLE_LENGTH } from "./limits";
import {
  SUGGESTION_MAX_LENGTH,
  SUGGESTION_MIN_LENGTH,
  SUGGESTION_PAGE_MAX_LENGTH,
  cleanSuggestion,
  suggestionCard,
} from "./suggestion";

describe("the card a suggestion becomes", () => {
  test("one line is the title, with no notes", () => {
    expect(suggestionCard("Show which month is open")).toEqual({
      ok: true,
      title: "Show which month is open",
      notes: undefined,
    });
  });

  test("the first line is the title; the rest and the page are the notes", () => {
    expect(
      suggestionCard("Show which month is open\nIt took me a while.\n\nTwice.", "/finance"),
    ).toEqual({
      ok: true,
      title: "Show which month is open",
      notes: "It took me a while.\n\nTwice.\n\nPage: /finance",
    });
  });

  test("with one line and a page, the notes are the page alone", () => {
    expect(suggestionCard("Bigger numbers", " /board ")).toMatchObject({
      title: "Bigger numbers",
      notes: "Page: /board",
    });
  });

  test("a blank page is no page", () => {
    expect(suggestionCard("Bigger numbers", "   ")).toMatchObject({ notes: undefined });
    expect(suggestionCard("Bigger numbers", null)).toMatchObject({ notes: undefined });
  });

  test("a first line longer than a title is cut for the title and kept whole in the notes", () => {
    const line = "word ".repeat(60).trim();
    expect(line.length).toBeGreaterThan(MAX_TITLE_LENGTH);
    const card = suggestionCard(`${line}\nAnd a second line.`, "/gtm");
    if (!card.ok) throw new Error("refused");
    expect(card.title).toHaveLength(MAX_TITLE_LENGTH);
    expect(card.title.endsWith("…")).toBe(true);
    expect(card.notes).toBe(`${line}\nAnd a second line.\n\nPage: /gtm`);
  });

  test("blank lines at either end are dropped, and a run of them is one", () => {
    expect(cleanSuggestion("\n\n  First  \n\n\n\nSecond\n\n")).toBe("First\n\nSecond");
  });

  test("what cannot be seen is removed: control characters, direction marks, zero-width", () => {
    const hidden = "Fix\u0000 the​ page‮ now";
    expect(suggestionCard(hidden)).toMatchObject({ title: "Fix the page now" });
    expect(suggestionCard("Bigger numbers", "/fi​nance\u0007")).toMatchObject({
      notes: "Page: /finance",
    });
  });
});

describe("what is refused, and in which words", () => {
  test.each(["", "   ", "abcd", " a \n b ", "​​​​​​"])(
    "%j is too short",
    (text) => {
      expect(suggestionCard(text)).toEqual({ ok: false, error: "too_short" });
    },
  );

  test("the shortest and the longest that pass", () => {
    expect(suggestionCard("a".repeat(SUGGESTION_MIN_LENGTH)).ok).toBe(true);
    expect(suggestionCard("a".repeat(SUGGESTION_MAX_LENGTH)).ok).toBe(true);
  });

  test("one character more is too long", () => {
    expect(suggestionCard("a".repeat(SUGGESTION_MAX_LENGTH + 1))).toEqual({
      ok: false,
      error: "too_long",
    });
  });

  test("the length is the cleaned text's: spaces around it do not count", () => {
    expect(suggestionCard(`  ${"a".repeat(SUGGESTION_MAX_LENGTH)}  \n\n`).ok).toBe(true);
  });

  test("a page longer than its limit", () => {
    expect(suggestionCard("Bigger numbers", "p".repeat(SUGGESTION_PAGE_MAX_LENGTH + 1))).toEqual({
      ok: false,
      error: "page_too_long",
    });
    expect(suggestionCard("Bigger numbers", "p".repeat(SUGGESTION_PAGE_MAX_LENGTH)).ok).toBe(true);
  });
});
