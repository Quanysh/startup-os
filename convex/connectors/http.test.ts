import { afterEach, describe, expect, test, vi } from "vitest";
import { ConnectorError } from "./errors";
import { requestJson, type JsonRequest } from "./http";

// Obviously not a real credential.
const SECRET = "fake-secret-for-tests-only";
const REQUEST: JsonRequest = {
  who: "Initech",
  what: "widgets",
  url: "https://api.initech.test/v1/widgets?team=t-123",
  headers: { Authorization: `Bearer ${SECRET}` },
};

type Call = { url: string; init: RequestInit | undefined };

/** Replace fetch with a list of answers, used in order; the last one repeats. */
function answers(...list: (() => Response | Promise<Response>)[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return list[Math.min(calls.length, list.length) - 1]!();
    }),
  );
  return calls;
}

const ok = () => Response.json({ fine: true });
const status = (code: number, body = "the body") => () => new Response(body, { status: code });
/** What a failed request threw. */
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a failure");
    },
    (error: unknown) => error as Error,
  );

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("requestJson", () => {
  test("sends what it was given, follows no redirect, and returns the JSON", async () => {
    const calls = answers(ok);
    const body = JSON.stringify({ q: 1 });
    expect(await requestJson({ ...REQUEST, method: "POST", body })).toEqual({ fine: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(REQUEST.url);
    expect(calls[0]!.init).toMatchObject({ method: "POST", body, redirect: "manual" });
    expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBe(`Bearer ${SECRET}`);
  });

  test("a GET is the default", async () => {
    const calls = answers(ok);
    await requestJson(REQUEST);
    expect(calls[0]!.init?.method).toBe("GET");
  });

  test("a 500 that clears on the second try is not a failure", async () => {
    const calls = answers(status(500), ok);
    expect(await requestJson(REQUEST)).toEqual({ fine: true });
    expect(calls).toHaveLength(2);
  });

  test("a 429 and a dropped connection are tried again too", async () => {
    const limited = answers(status(429), ok);
    await requestJson(REQUEST);
    expect(limited).toHaveLength(2);

    const dropped = answers(() => {
      throw new TypeError("socket closed");
    }, ok);
    await requestJson(REQUEST);
    expect(dropped).toHaveLength(2);
  });

  test("a 401 is not tried again, and is reported by its status only", async () => {
    const calls = answers(status(401, '{"detail":"account dump"}'));
    const error = await failure(requestJson(REQUEST));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toBe("Initech answered 401 for widgets.");
    expect(calls).toHaveLength(1);
  });

  test("two 500s in a row are reported once, after exactly two calls", async () => {
    const calls = answers(status(500));
    expect((await failure(requestJson(REQUEST))).message).toBe("Initech answered 500 for widgets.");
    expect(calls).toHaveLength(2);
  });

  test("a redirect is not followed: it is an answer like any other", async () => {
    const calls = answers(
      () => new Response(null, { status: 307, headers: { location: "https://elsewhere.test/" } }),
    );
    expect((await failure(requestJson(REQUEST))).message).toBe("Initech answered 307 for widgets.");
    expect(calls).toHaveLength(1);
  });

  test("a body that is not JSON is not quoted", async () => {
    answers(() => new Response("Initech Holdings LLC statement"));
    const error = await failure(requestJson(REQUEST));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toBe("Initech's widgets response was not JSON.");
  });

  test("a network failure that names the URL or the header is not quoted", async () => {
    answers(() => {
      throw new TypeError(`fetch failed: ${REQUEST.url} with "Bearer ${SECRET}"`);
    });
    const error = await failure(requestJson(REQUEST));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toBe("Initech could not be reached for widgets.");
  });

  test("a request that never answers is given up on, twice, and cancelled", async () => {
    vi.useFakeTimers();
    const calls = answers(() => new Promise<Response>(() => {}));
    const outcome = failure(requestJson(REQUEST));
    // Two deadlines of twenty seconds and the pause between them.
    await vi.advanceTimersByTimeAsync(41_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toBe("Initech did not answer in time for widgets.");
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.init?.signal?.aborted)).toBe(true);
  });
});
