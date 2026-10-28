import { describe, expect, test } from "vitest";
import { durationWords, failureSentence, pageAreaWords, shareWords } from "./words";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("durationWords", () => {
  test.each([
    [0, "under a minute"],
    [59 * 1000, "under a minute"],
    [MIN, "1 min"],
    [59 * MIN, "59 min"],
    [HOUR, "1 h"],
    [4 * HOUR + 12 * MIN, "4 h 12 min"],
    [DAY, "1 d"],
    [2 * DAY + 5 * HOUR + 30 * MIN, "2 d 5 h"],
    [40 * DAY, "40 d"],
  ])("%d ms is %s", (ms, words) => {
    expect(durationWords(ms)).toBe(words);
  });
});

describe("shareWords", () => {
  test.each([
    [null, "Not known"],
    [0, "0%"],
    [0.4, "40%"],
    [2 / 3, "67%"],
    [1, "100%"],
  ])("%s is %s", (share, words) => {
    expect(shareWords(share)).toBe(words);
  });
});

describe("pageAreaWords", () => {
  test("a page area as a path, or a word for none", () => {
    expect(pageAreaWords("studies/report")).toBe("/studies/report");
    expect(pageAreaWords("dashboard")).toBe("/dashboard");
    expect(pageAreaWords(null)).toBe("Not known");
  });
});

describe("failureSentence", () => {
  test("a refused push in the page's words; no stored message is ever shown", () => {
    expect(failureSentence("refused")).toMatch(/last push from the daily Intercom task was refused/);
    expect(failureSentence("not_configured")).toBeNull();
    expect(failureSentence(null)).toBeNull();
  });
});
