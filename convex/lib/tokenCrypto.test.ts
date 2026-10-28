import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConnectorError } from "../connectors/errors";
import { keyProblem, open, seal } from "./tokenCrypto";

// Obviously fake: 32 printable bytes, and a token that is not one.
const KEY = btoa("0123456789abcdef0123456789abcdef");
const OTHER_KEY = btoa("fedcba9876543210fedcba9876543210");
const TOKEN = "fake-refresh-token-not-real-0001";
const PURPOSE = "google-refresh-token";
const UNREADABLE = "The stored Google grant could not be read. Connect Google again.";
const BAD_KEY = "TOKEN_ENCRYPTION_KEY must be 32 random bytes, base64-encoded.";

/** The rejection, so its class and its message can both be checked. */
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected a rejection.");
}

beforeEach(() => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", KEY);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("seal / open", () => {
  test("round trip: what is stored is not the token, and opens back into it", async () => {
    const sealed = await seal(TOKEN, PURPOSE);
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain(TOKEN);
    expect(sealed).not.toContain(btoa(TOKEN));
    expect(sealed).not.toContain(btoa(TOKEN).replace(/=+$/, ""));
    expect(await open(sealed, PURPOSE)).toBe(TOKEN);
  });

  test("the ciphertext really is AES-GCM: the token's bytes plus a 16-byte tag", async () => {
    const sealed = await seal(TOKEN, PURPOSE);
    const data = sealed.split(".")[2] ?? "";
    const bytes = atob(data.replace(/-/g, "+").replace(/_/g, "/")).length;
    expect(bytes).toBe(TOKEN.length + 16);
  });

  test("a fresh IV each time", async () => {
    const first = await seal(TOKEN, PURPOSE);
    const second = await seal(TOKEN, PURPOSE);
    expect(first).not.toBe(second);
    expect(first.split(".")[1]).not.toBe(second.split(".")[1]);
  });

  test("bound to its purpose", async () => {
    const sealed = await seal(TOKEN, PURPOSE);
    const error = await failure(open(sealed, "something-else"));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toBe(UNREADABLE);
  });

  test("tampering is detected", async () => {
    const sealed = await seal(TOKEN, PURPOSE);
    const last = sealed.slice(-1);
    const flipped = sealed.slice(0, -1) + (last === "A" ? "B" : "A");
    expect((await failure(open(flipped, PURPOSE))).message).toBe(UNREADABLE);

    // And in the middle of the ciphertext, not only in the tag.
    const [version, iv, data = ""] = sealed.split(".");
    const middle = data[4] === "A" ? "B" : "A";
    const altered = `${version}.${iv}.${data.slice(0, 4)}${middle}${data.slice(5)}`;
    expect((await failure(open(altered, PURPOSE))).message).toBe(UNREADABLE);
  });

  test("another key cannot open it", async () => {
    const sealed = await seal(TOKEN, PURPOSE);
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", OTHER_KEY);
    expect((await failure(open(sealed, PURPOSE))).message).toBe(UNREADABLE);
  });

  // Sixteen bytes would import as AES-128; only a 256-bit key is accepted.
  test.each([[""], ["not-a-key"], [btoa("too short")], [btoa("0123456789abcdef")], [btoa("x".repeat(33))]])(
    "a bad key (%j) is refused by seal and open, by name",
    async (key) => {
      const sealed = await seal(TOKEN, PURPOSE);
      vi.stubEnv("TOKEN_ENCRYPTION_KEY", key);
      const sealing = await failure(seal(TOKEN, PURPOSE));
      expect(sealing).toBeInstanceOf(ConnectorError);
      expect(sealing.message).toBe(BAD_KEY);
      expect((await failure(open(sealed, PURPOSE))).message).toBe(BAD_KEY);
      expect(keyProblem()).toBe(BAD_KEY);
    },
  );

  // 32 bytes, and a key in name only: anyone can guess it.
  test("an all-zero key is refused, by seal, by open and before connecting", async () => {
    const sealed = await seal(TOKEN, PURPOSE);
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", btoa("\0".repeat(32)));
    expect(keyProblem()).toBe(BAD_KEY);
    expect((await failure(seal(TOKEN, PURPOSE))).message).toBe(BAD_KEY);
    expect((await failure(open(sealed, PURPOSE))).message).toBe(BAD_KEY);
    // One byte set is a (weak, but real) key: only the empty one is refused here.
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", btoa(`${"\0".repeat(31)}\u0001`));
    expect(keyProblem()).toBeNull();
  });

  test("only version v1 is opened, though the rest of the value is good", async () => {
    const sealed = await seal(TOKEN, PURPOSE);
    expect(sealed.startsWith("v1.")).toBe(true);
    for (const version of ["v2", "v0", "V1", "", "v1 "]) {
      const error = await failure(open(sealed.replace(/^v1/, version), PURPOSE));
      expect(error, version).toBeInstanceOf(ConnectorError);
      expect(error.message, version).toBe(UNREADABLE);
    }
  });

  test("a good value with anything after it is not opened", async () => {
    const sealed = await seal(TOKEN, PURPOSE);
    for (const extra of [".", ".x", ".v1.aaaa.bbbb"]) {
      const error = await failure(open(`${sealed}${extra}`, PURPOSE));
      expect(error, extra).toBeInstanceOf(ConnectorError);
      expect(error.message, extra).toBe(UNREADABLE);
    }
    expect(await open(sealed, PURPOSE)).toBe(TOKEN);
  });

  test("a good key has no problem", () => {
    expect(keyProblem()).toBeNull();
  });

  test.each([[""], ["v1"], ["v2.aaaa.bbbb"], ["v1.."], ["garbage"], ["v1.a.b.c"], ["v1.%%%.%%%"]])(
    "a malformed value (%j) is unreadable",
    async (value) => {
      const error = await failure(open(value, PURPOSE));
      expect(error).toBeInstanceOf(ConnectorError);
      expect(error.message).toBe(UNREADABLE);
    },
  );

  test("no message quotes the secret or the key", async () => {
    const sealed = await seal(TOKEN, PURPOSE);
    const messages = [
      (await failure(open(sealed, "something-else"))).message,
      (await failure(open(`${sealed}x`, PURPOSE))).message,
    ];
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", "not-a-key");
    messages.push((await failure(seal(TOKEN, PURPOSE))).message);
    messages.push((await failure(open(sealed, PURPOSE))).message);
    for (const message of messages) {
      expect(message).not.toContain(TOKEN);
      expect(message).not.toContain(KEY);
      expect(message).not.toContain("not-a-key");
      expect(message).not.toContain(sealed);
    }
  });
});
