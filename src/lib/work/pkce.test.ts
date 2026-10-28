import { describe, expect, test } from "vitest";
import { challengeOf, randomNonce } from "./pkce";

describe("randomNonce", () => {
  test("is 43 base64url characters", () => {
    expect(randomNonce()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("is different every time", () => {
    const made = new Set(Array.from({ length: 50 }, () => randomNonce()));
    expect(made.size).toBe(50);
  });
});

describe("challengeOf", () => {
  test("matches the vector in RFC 7636, appendix B", async () => {
    expect(await challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  test("a challenge is itself 43 base64url characters, and is not the verifier", async () => {
    const verifier = randomNonce();
    const challenge = await challengeOf(verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).not.toBe(verifier);
  });
});
