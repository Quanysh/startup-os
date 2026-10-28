import { describe, expect, test } from "vitest";
import { secretsEqual } from "./constantTime";

describe("secretsEqual", () => {
  test("true for identical secrets", async () => {
    expect(await secretsEqual("s3cret-token", "s3cret-token")).toBe(true);
  });

  test("false when one character differs", async () => {
    expect(await secretsEqual("s3cret-token", "s3cret-tokem")).toBe(false);
  });

  test("false when one is a prefix of the other", async () => {
    expect(await secretsEqual("s3cret", "s3cret-token")).toBe(false);
  });

  test("false when the expected secret is empty, even against an empty guess", async () => {
    // An unset env var must never authenticate an empty bearer token.
    expect(await secretsEqual("", "")).toBe(false);
  });

  test("false when the expected secret is undefined", async () => {
    expect(await secretsEqual("anything", undefined)).toBe(false);
  });
});
