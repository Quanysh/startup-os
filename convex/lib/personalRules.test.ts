import { describe, expect, test } from "vitest";
import {
  MAX_PUSHES_PER_WINDOW,
  PERSONAL_TOKEN_PREFIX,
  PUSH_WINDOW_MS,
  base64Url,
  hashToken,
  isPersonalToken,
  nextPushWindow,
  tokenFrom,
} from "./personalRules";

describe("a personal token's shape", () => {
  test("URL-safe base64 with no padding, for every length of input", () => {
    expect(base64Url(new Uint8Array([]))).toBe("");
    expect(base64Url(new Uint8Array([0xfb]))).toBe("-w");
    expect(base64Url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
    expect(base64Url(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe("-_-_");
    expect(base64Url(new TextEncoder().encode("Made-up!"))).toBe("TWFkZS11cCE");
  });

  test("32 bytes make the prefix and 43 characters a shell and a header take as they are", () => {
    const token = tokenFrom(new Uint8Array(32).fill(0xff));
    expect(token).toMatch(/^sos_[A-Za-z0-9_-]{43}$/);
    expect(isPersonalToken(token)).toBe(true);
    expect(isPersonalToken("fake-source-token-0123456789")).toBe(false);
    expect(isPersonalToken("")).toBe(false);
    expect(PERSONAL_TOKEN_PREFIX).toBe("sos_");
  });

  test("the stored form is the SHA-256 in hex", async () => {
    // The published test vector for "abc".
    expect(await hashToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("the push window", () => {
  const T = 1_800_000_000_000;

  test("the first push opens a window", () => {
    expect(nextPushWindow({}, T)).toEqual({ allowed: true, windowStart: T, pushes: 1 });
  });

  test("pushes inside it count up to the limit, and the next is refused without counting", () => {
    let row: { windowStart?: number; pushes?: number } = {};
    for (let n = 1; n <= MAX_PUSHES_PER_WINDOW; n += 1) {
      const next = nextPushWindow(row, T + n);
      expect(next).toEqual({ allowed: true, windowStart: T + 1, pushes: n });
      row = next;
    }
    expect(nextPushWindow(row, T + 500)).toEqual({
      allowed: false,
      windowStart: T + 1,
      pushes: MAX_PUSHES_PER_WINDOW,
    });
  });

  test("an hour after it opened, a new window opens", () => {
    const full = { windowStart: T, pushes: MAX_PUSHES_PER_WINDOW };
    expect(nextPushWindow(full, T + PUSH_WINDOW_MS - 1).allowed).toBe(false);
    expect(nextPushWindow(full, T + PUSH_WINDOW_MS)).toEqual({
      allowed: true,
      windowStart: T + PUSH_WINDOW_MS,
      pushes: 1,
    });
  });

  test("a window that starts in the future (a clock set back) is replaced, not trusted", () => {
    expect(nextPushWindow({ windowStart: T + 5000, pushes: 99 }, T)).toEqual({
      allowed: true,
      windowStart: T,
      pushes: 1,
    });
  });

  test("the limit leaves room for a daily task, a manual run and retries", () => {
    expect(MAX_PUSHES_PER_WINDOW).toBeGreaterThanOrEqual(6);
  });
});
