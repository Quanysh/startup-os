import { describe, expect, test } from "vitest";
import { SIGN_IN, safeNext, signInPathFor } from "./sign-in-next";

// The one page sign-in returns to: OAuth's consent page, whose address holds
// the client's request (claude.ai, the Grok app). Anything else goes to "/"
// after signing in, as before, so the redirect cannot be pointed elsewhere.

const REQUEST = "?response_type=code&client_id=sosc_x&redirect_uri=https%3A%2F%2Fclaude.example.test%2Fcb&state=a%20b";

describe("where a signed-out visitor is sent", () => {
  test("from the consent page: sign-in, with the page and its request to come back to", () => {
    const to = signInPathFor("/oauth/authorize", REQUEST);
    expect(to).toBe(`${SIGN_IN}?next=${encodeURIComponent(`/oauth/authorize${REQUEST}`)}`);
    expect(safeNext(new URLSearchParams(to.split("?")[1]).get("next"))).toBe(`/oauth/authorize${REQUEST}`);
  });

  test("from anywhere else: sign-in, with nothing to come back to", () => {
    for (const path of ["/", "/finance", "/oauth", "/oauth/authorize/", "/oauth/token"]) {
      expect(signInPathFor(path, "?x=1"), path).toBe(SIGN_IN);
    }
  });
});

describe("what sign-in returns to", () => {
  test("only the consent page on this site", () => {
    expect(safeNext("/oauth/authorize")).toBe("/oauth/authorize");
    expect(safeNext(`/oauth/authorize${REQUEST}`)).toBe(`/oauth/authorize${REQUEST}`);
  });

  test("never another page, another site, or anything a browser could read as one", () => {
    for (const bad of [
      null,
      "",
      "/",
      "/finance",
      "https://evil.example.test/oauth/authorize",
      "//evil.example.test/oauth/authorize",
      "/oauth/authorize/../../finance",
      "/oauth/authorizeX",
      "/oauth/authorize#x",
      "/\\evil.example.test",
      "/oauth/authorize?x=1\n",
      `/oauth/authorize?${"x".repeat(5000)}`,
    ]) {
      expect(safeNext(bad), String(bad)).toBeNull();
    }
  });
});
