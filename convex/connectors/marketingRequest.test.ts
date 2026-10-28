import { afterEach, describe, expect, test, vi } from "vitest";
import { ConnectorError } from "./errors";
import {
  REQUEST_TIMEOUT_MS,
  RETRY_PAUSE_MS,
  requestJson,
  type RequestSpec,
} from "./marketingRequest";

// Obviously not a real key.
const KEY = "fake-key-for-tests-only";
const URL_ASKED = "https://api.example.test/v1/things?account=acct-123";
const spec: RequestSpec = {
  service: "Example",
  what: "things",
  url: URL_ASKED,
  method: "POST",
  headers: { "x-api-key": KEY },
  body: '{"page":1}',
};

type Call = { url: string; init: RequestInit };
/** Replace fetch; each call is answered by the next of `answers`, the last one repeating. */
function stub(...answers: (() => Response | Promise<Response>)[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return answers[Math.min(calls.length, answers.length) - 1]!();
    }),
  );
  return calls;
}
const ok = () => Response.json({ fine: true });
const failure = (run: Promise<unknown>) =>
  run.then(
    () => null,
    (error: unknown) => error as Error,
  );

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("requestJson", () => {
  test("sends what it was given to the URL it was given, and never follows a redirect", async () => {
    const calls = stub(ok);
    expect(await requestJson(spec)).toEqual({ fine: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(URL_ASKED);
    expect(calls[0]!.init).toMatchObject({
      method: "POST",
      headers: { "x-api-key": KEY },
      body: '{"page":1}',
      redirect: "manual",
    });
  });

  test("a redirect is an answer like any other: reported, not followed, not retried", async () => {
    const calls = stub(
      () => new Response(null, { status: 307, headers: { location: "https://elsewhere.test/" } }),
    );
    const error = await failure(requestJson(spec));
    expect(error?.message).toBe("Example answered 307 for things.");
    expect(calls).toHaveLength(1);
  });

  test("a 500 that clears on the second try is not a failure", async () => {
    const calls = stub(() => new Response("down", { status: 500 }), ok);
    expect(await requestJson(spec)).toEqual({ fine: true });
    expect(calls).toHaveLength(2);
  });

  test("a 429 and a dropped connection are tried again too", async () => {
    const limited = stub(() => new Response("slow down", { status: 429 }), ok);
    expect(await requestJson(spec)).toEqual({ fine: true });
    expect(limited).toHaveLength(2);

    const dropped = stub(() => {
      throw new TypeError("socket closed");
    }, ok);
    expect(await requestJson(spec)).toEqual({ fine: true });
    expect(dropped).toHaveLength(2);
  });

  test("two 500s in a row are reported once, after exactly two calls", async () => {
    const calls = stub(() => new Response("down", { status: 500 }));
    const error = await failure(requestJson(spec));
    expect(error?.message).toBe("Example answered 500 for things.");
    expect(calls).toHaveLength(2);
  });

  test("a 401 is not tried again, and its body is not quoted", async () => {
    const calls = stub(
      () => new Response('{"error":"key fake-key-for-tests-only is invalid"}', { status: 401 }),
    );
    const error = await failure(requestJson(spec));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error?.message).toBe("Example answered 401 for things.");
    expect(calls).toHaveLength(1);
  });

  test("a body that is not JSON is not quoted", async () => {
    stub(() => new Response("Initech Holdings LLC statement"));
    const error = await failure(requestJson(spec));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error?.message).toBe("Example's things response was not JSON.");
  });

  test("a network failure that names the URL or the key is not quoted", async () => {
    stub(() => {
      throw new TypeError(`fetch failed: ${URL_ASKED} with x-api-key ${KEY}`);
    });
    const error = await failure(requestJson(spec));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error?.message).toBe("Example could not be reached for things.");
    expect(error?.message).not.toContain(KEY);
    expect(error?.message).not.toContain("acct-123");
  });

  test("a request that never answers is cancelled at the deadline, tried once more, then reported", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const calls = stub(() => new Promise<Response>(() => {}));
    const run = failure(requestJson(spec));
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(RETRY_PAUSE_MS);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    const error = await run;
    expect(error?.message).toBe("Example did not answer in time for things.");
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.init.signal?.aborted)).toBe(true);
  });

  test("the method defaults to GET", async () => {
    const calls = stub(ok);
    await requestJson({ service: "Example", what: "things", url: URL_ASKED, headers: {} });
    expect(calls[0]!.init.method).toBe("GET");
  });
});
