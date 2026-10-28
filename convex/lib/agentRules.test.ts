import { describe, expect, test } from "vitest";
import {
  AGENT_TOKEN_PREFIX,
  AGENT_WORDS,
  CALL_WINDOW_MS,
  agentTokenFrom,
  isAgentToken,
  nextWindow,
} from "./agentRules";
import { PERSONAL_TOKEN_PREFIX, isPersonalToken, tokenFrom } from "./personalRules";

describe("the agent token's shape", () => {
  const bytes = new Uint8Array(32).fill(7);

  test("it is told from a personal token by its prefix, both ways", () => {
    const agent = agentTokenFrom(bytes);
    const personal = tokenFrom(bytes);
    expect(agent.startsWith(AGENT_TOKEN_PREFIX)).toBe(true);
    expect(isAgentToken(agent)).toBe(true);
    // The ingest endpoint takes a personal token by its prefix: never this one.
    expect(isPersonalToken(agent)).toBe(false);
    expect(isAgentToken(personal)).toBe(false);
    expect(AGENT_TOKEN_PREFIX.startsWith(PERSONAL_TOKEN_PREFIX)).toBe(false);
    expect(PERSONAL_TOKEN_PREFIX.startsWith(AGENT_TOKEN_PREFIX)).toBe(false);
  });

  test("it is 256 bits as URL-safe text", () => {
    expect(agentTokenFrom(bytes)).toMatch(/^sosa_[A-Za-z0-9_-]{43}$/);
  });
});

describe("nextWindow", () => {
  test("the first call opens a window", () => {
    expect(nextWindow({}, 1_000, 3)).toEqual({ allowed: true, windowStart: 1_000, count: 1 });
  });

  test("calls are counted to the limit and then refused, the count left as it was", () => {
    let window = { windowStart: 1_000, count: 1 };
    for (const count of [2, 3]) {
      const next = nextWindow(window, 2_000, 3);
      expect(next).toEqual({ allowed: true, windowStart: 1_000, count });
      window = next;
    }
    expect(nextWindow(window, 2_000, 3)).toEqual({ allowed: false, windowStart: 1_000, count: 3 });
  });

  test("a window is replaced once it is its full length old, and not a millisecond before", () => {
    const full = { windowStart: 1_000, count: 3 };
    expect(nextWindow(full, 1_000 + CALL_WINDOW_MS - 1, 3).allowed).toBe(false);
    expect(nextWindow(full, 1_000 + CALL_WINDOW_MS, 3)).toEqual({
      allowed: true,
      windowStart: 1_000 + CALL_WINDOW_MS,
      count: 1,
    });
  });

  test("a clock that went backwards opens a new window rather than a negative one", () => {
    expect(nextWindow({ windowStart: 5_000, count: 3 }, 1_000, 3)).toEqual({
      allowed: true,
      windowStart: 1_000,
      count: 1,
    });
  });
});

describe("the words", () => {
  test("every refusal is a sentence of its own", () => {
    const words = Object.values(AGENT_WORDS);
    expect(new Set(words).size).toBe(words.length);
    for (const sentence of words) expect(sentence).toMatch(/[.]$/);
  });
});
