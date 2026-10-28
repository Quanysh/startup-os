import { describe, expect, test } from "vitest";
import { ingestTokenProblem, ingestUrlProblem } from "./ingestUrl";

const TOKEN_PROBLEM =
  'INGEST_TOKEN_CFO_WORKBOOK must be 32 or more letters, digits, "-" or "_".';

describe("ingestTokenProblem", () => {
  test("32 or more letters, digits, hyphens and underscores are fine", () => {
    expect(ingestTokenProblem("fake-token_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ")).toBeNull();
    expect(ingestTokenProblem("a".repeat(32))).toBeNull();
  });

  test("a token shorter than the endpoint's 32-character minimum is refused", () => {
    expect(ingestTokenProblem("a".repeat(31))).toBe(TOKEN_PROBLEM);
  });

  // fetch rejects an unsendable header with an error that quotes the whole
  // header, and a shell or .env parser treats several characters specially, so
  // anything outside the plain set is refused, without quoting the token.
  test.each([
    ["a newline", "fake-token-0123456789\nabcdefghijklmnop"],
    ["a NUL", "fake-token-0123456789\u0000abcdefghijklmnop"],
    ["a space", "fake-token-0123456789 abcdefghijklmnop"],
    ["a non-ASCII character", "fake-token-0123456789-’-abcdefghijklmnop"],
    ["a dollar sign", "fake-token-0123456789$abcdefghijklmnop"],
    ["a hash", "fake-token-0123456789#abcdefghijklmnop"],
    ["a quote", "fake-token-0123456789'abcdefghijklmnop"],
    ["a double quote", 'fake-token-0123456789"abcdefghijklmnop'],
    ["a semicolon", "fake-token-0123456789;abcdefghijklmnop"],
    ["a parenthesis", "fake-token-0123456789(abcdefghijklmnop"],
  ])("a token with %s is refused, without quoting it", (_label, token) => {
    const problem = ingestTokenProblem(token);
    expect(problem).toBe(TOKEN_PROBLEM);
    expect(problem).not.toContain("fake");
  });

  test("the message names the variable it was given, and never the value", () => {
    expect(ingestTokenProblem("short-SECRET", "INGEST_TOKEN_CLIENT_REGISTER")).toBe(
      'INGEST_TOKEN_CLIENT_REGISTER must be 32 or more letters, digits, "-" or "_".',
    );
  });
});

const PROBLEM_HOST =
  "STARTUP_OS_INGEST_URL must be a *.convex.site address, https://os.example.com, or localhost.";

describe("ingestUrlProblem", () => {
  test("an https ingest endpoint is fine", () => {
    expect(ingestUrlProblem("https://happy-otter-123.convex.site/ingest/v1")).toBeNull();
  });

  test("plain http is refused, since the token would travel in the clear", () => {
    expect(ingestUrlProblem("http://happy-otter-123.convex.site/ingest/v1")).toBe(
      "STARTUP_OS_INGEST_URL must be https (http is allowed only for localhost).",
    );
  });

  test("a local backend may use http", () => {
    expect(ingestUrlProblem("http://127.0.0.1:3211/ingest/v1")).toBeNull();
    expect(ingestUrlProblem("http://localhost:3211/ingest/v1")).toBeNull();
    expect(ingestUrlProblem("http://[::1]:3211/ingest/v1")).toBeNull();
  });

  test("anything but the ingest path is refused", () => {
    expect(ingestUrlProblem("https://happy-otter-123.convex.site/")).toBe(
      "STARTUP_OS_INGEST_URL must end in /ingest/v1.",
    );
  });

  test("something that is not a URL is refused", () => {
    expect(ingestUrlProblem("happy-otter")).toBe("STARTUP_OS_INGEST_URL is not a URL.");
  });

  test("a URL with a username or password is refused, without echoing it", () => {
    for (const value of [
      "https://fake-user:fake-pass@happy-otter-123.convex.site/ingest/v1",
      "https://fake-user@happy-otter-123.convex.site/ingest/v1",
      "https://:fake-pass@happy-otter-123.convex.site/ingest/v1",
    ]) {
      const problem = ingestUrlProblem(value);
      expect(problem).toBe("STARTUP_OS_INGEST_URL must not contain credentials.");
      expect(problem).not.toContain("fake");
    }
  });

  test("the OS's own domain is fine: it passes the request to the same endpoint", () => {
    expect(ingestUrlProblem("https://os.example.com/ingest/v1")).toBeNull();
    expect(ingestUrlProblem("https://os.example.com:443/ingest/v1")).toBeNull();
  });

  test("the OS's own domain is held to the same rules as any other", () => {
    expect(ingestUrlProblem("http://os.example.com/ingest/v1")).toBe(
      "STARTUP_OS_INGEST_URL must be https (http is allowed only for localhost).",
    );
    expect(ingestUrlProblem("https://fake-user:fake-pass@os.example.com/ingest/v1")).toBe(
      "STARTUP_OS_INGEST_URL must not contain credentials.",
    );
    expect(ingestUrlProblem("https://os.example.com/standup/v1/open")).toBe(
      "STARTUP_OS_INGEST_URL must end in /ingest/v1.",
    );
  });

  test.each([
    "https://os.example.com.evil.test/ingest/v1",
    "https://evil-os.example.com/ingest/v1",
    "https://xos.example.com/ingest/v1",
    "https://example.com/ingest/v1",
    "https://atlas.example.com/ingest/v1",
    "https://os.example.com:8443/ingest/v1",
    "https://os.example.com@evil.test/ingest/v1",
    "https://startup-os.example.com/ingest/v1",
  ])("%s is not the OS's domain", (value) => {
    expect(ingestUrlProblem(value)).not.toBeNull();
    expect(ingestUrlProblem(value)).not.toBe("STARTUP_OS_INGEST_URL must end in /ingest/v1.");
  });

  test("only a *.convex.site host, the OS's own, or a local one, may be sent the token", () => {
    const problem = PROBLEM_HOST;
    // Not "any https host": a typing slip must not send the token elsewhere.
    expect(ingestUrlProblem("https://evil.example/ingest/v1")).toBe(problem);
    expect(ingestUrlProblem("https://convex.site/ingest/v1")).toBe(problem);
    expect(ingestUrlProblem("https://happy-otter-123.convex.site.evil.example/ingest/v1")).toBe(
      problem,
    );
    expect(ingestUrlProblem("https://evilconvex.site/ingest/v1")).toBe(problem);
  });

  test("a host that merely looks local is not local", () => {
    const http = "STARTUP_OS_INGEST_URL must be https (http is allowed only for localhost).";
    expect(ingestUrlProblem("http://localhost.evil.example/ingest/v1")).toBe(http);
    // Here "localhost" is a username and the host is evil.example.
    expect(ingestUrlProblem("http://localhost@evil.example/ingest/v1")).toBe(
      "STARTUP_OS_INGEST_URL must not contain credentials.",
    );
    expect(ingestUrlProblem("https://localhost.evil.example/ingest/v1")).toBe(PROBLEM_HOST);
  });
});
