import { describe, expect, test, vi } from "vitest";
import { postEnvelope } from "./postEnvelope";

const URL = "https://fake-otter-123.convex.site/ingest/v1";
const TOKEN = "fake-token-0123456789abcdefghijklmnopqrstuvwxyz";
const BODY = { customers: [{ name: "SECRET CLINIC ALPHA" }] };

function setup(reply: () => Promise<Response>) {
  const out: string[] = [];
  const err: string[] = [];
  const fetchMock = vi.fn(reply);
  return {
    out,
    err,
    fetchMock,
    printed: () => [...out, ...err].join("\n"),
    deps: {
      fetch: fetchMock as unknown as typeof fetch,
      print: (line: string) => void out.push(line),
      printError: (line: string) => void err.push(line),
    },
  };
}
const json = (body: unknown, status = 200) => async () =>
  new Response(JSON.stringify(body), { status });

describe("postEnvelope", () => {
  test("posts once, with the token, following no redirect, and prints the counts", async () => {
    const h = setup(json({ ok: true, inserted: 2, updated: 1, unchanged: 0, archived: 1 }));
    expect(await postEnvelope(URL, TOKEN, BODY, h.deps)).toBe(0);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(URL);
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    });
    // A deadline, so a hung push ends.
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toEqual(BODY);
    expect(h.out).toEqual([
      "Sending to fake-otter-123.convex.site.",
      "200 ok: inserted 2, updated 1, unchanged 0, archived 1",
    ]);
    expect(h.printed()).not.toContain(TOKEN);
    expect(h.printed()).not.toContain("SECRET");
  });

  test("a refusal prints its code and each issue's path and words, and nothing else", async () => {
    const h = setup(
      json(
        {
          ok: false,
          error: "invalid_customers",
          issues: [{ path: "customers.1.name", message: "is the same clinic as row 0" }],
          echo: "SECRET CLINIC ALPHA",
        },
        422,
      ),
    );
    expect(await postEnvelope(URL, TOKEN, BODY, h.deps)).toBe(1);
    expect(h.err).toEqual([
      "422 invalid_customers",
      "customers.1.name: is the same clinic as row 0",
    ]);
    expect(h.printed()).not.toContain("SECRET");
  });

  test.each([
    ["an error code that is not a plain word", { ok: false, error: "SECRET CLINIC ALPHA" }],
    ["an issue path that is not a path", { ok: false, issues: [{ path: "SECRET CLINIC", message: "x" }] }],
    ["an issue message too long to be one of the endpoint's", { ok: false, issues: [{ path: "customers", message: "SECRET ".repeat(40) }] }],
  ])("%s is not printed", async (_label, body) => {
    const h = setup(json(body, 422));
    expect(await postEnvelope(URL, TOKEN, BODY, h.deps)).toBe(1);
    expect(h.err).toEqual(["422"]);
  });

  test("control characters in an issue's words do not reach the terminal", async () => {
    const h = setup(
      json({ ok: false, error: "invalid_customers", issues: [{ path: "customers", message: "a\u001b[2Jb" }] }, 422),
    );
    await postEnvelope(URL, TOKEN, BODY, h.deps);
    expect(h.err).toEqual(["422 invalid_customers", "customers: a [2Jb"]);
  });

  test("a reply that is not JSON prints its status only", async () => {
    const h = setup(async () => new Response("<html>SECRET sign-in page</html>", { status: 200 }));
    expect(await postEnvelope(URL, TOKEN, BODY, h.deps)).toBe(1);
    expect(h.err).toEqual(["200", "That is not an ingest confirmation, so the push is not confirmed."]);
  });

  test("a redirect is not followed", async () => {
    const h = setup(async () => new Response(null, { status: 302, headers: { Location: "https://elsewhere.example" } }));
    expect(await postEnvelope(URL, TOKEN, BODY, h.deps)).toBe(1);
    expect(h.err).toEqual([
      "The endpoint redirected the request. Nothing was followed and nothing was sent on.",
    ]);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a network failure prints a plain code, never the error's own words", async () => {
    const h = setup(async () => {
      throw Object.assign(new TypeError(`fetch failed for Bearer ${TOKEN}`), {
        cause: { code: "ENOTFOUND" },
      });
    });
    expect(await postEnvelope(URL, TOKEN, BODY, h.deps)).toBe(1);
    expect(h.err).toEqual(["The push could not reach the endpoint (ENOTFOUND)."]);
    expect(h.printed()).not.toContain(TOKEN);
  });

  test("a push that outlives its deadline says so", async () => {
    const h = setup(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    expect(await postEnvelope(URL, TOKEN, BODY, h.deps)).toBe(1);
    expect(h.err).toEqual(["The push could not reach the endpoint (timed out)."]);
  });
});
