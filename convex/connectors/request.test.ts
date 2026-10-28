import { afterEach, describe, expect, test, vi } from "vitest";
import { ConnectorError } from "./errors";
import { ask, askJson, type Ask } from "./request";

const REQUEST: Ask = {
  who: "Linear",
  what: "issues",
  url: "https://api.example.test/graphql",
  method: "POST",
  headers: { Authorization: "fake-linear-key" },
  body: "{}",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Answer each call in turn with the next response (or throw the next error). */
function stubFetch(...answers: (Response | Error | (() => Promise<Response>))[]) {
  let n = 0;
  const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => {
    const answer = answers[Math.min(n, answers.length - 1)]!;
    n += 1;
    if (answer instanceof Error) throw answer;
    if (typeof answer === "function") return answer();
    return answer.clone();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The rejection, so its class and its message can both be checked. */
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected a rejection.");
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ask / askJson", () => {
  test("every call is made with redirect: manual, to the URL asked for", async () => {
    const fetchMock = stubFetch(json({ ok: true }));
    await askJson(REQUEST);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(REQUEST.url);
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      body: "{}",
      headers: { Accept: "application/json", Authorization: "fake-linear-key" },
    });
  });

  test("a GET is the default", async () => {
    const fetchMock = stubFetch(json({}));
    await askJson({ who: "Gmail", what: "the inbox", url: "https://api.example.test/x" });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "manual" });
  });

  test("a 200 with JSON is returned parsed", async () => {
    stubFetch(json({ data: { issues: [] } }));
    expect(await askJson(REQUEST)).toEqual({ data: { issues: [] } });
  });

  test("a 404 is reported by its status only, and not retried", async () => {
    const fetchMock = stubFetch(json({ error: "REMOTE-TEXT" }, 404));
    const error = await failure(askJson(REQUEST));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toBe("Linear answered 404 for issues.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a redirect is never followed", async () => {
    const fetchMock = stubFetch(
      new Response(null, { status: 302, headers: { Location: "https://evil.test/" } }),
    );
    const error = await failure(askJson(REQUEST));
    expect(error.message).toBe("Linear answered 302 for issues.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("one blip is retried", async () => {
    const fetchMock = stubFetch(json({}, 503), json({ ok: true }));
    expect(await askJson(REQUEST)).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("a second failure is the answer: two tries, never three", async () => {
    const fetchMock = stubFetch(json({}, 503));
    const error = await failure(askJson(REQUEST));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toBe("Linear answered 503 for issues.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("a 429 is a blip too", async () => {
    const fetchMock = stubFetch(json({}, 429));
    expect((await failure(askJson(REQUEST))).message).toBe("Linear answered 429 for issues.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("what fetch throws is never quoted", async () => {
    const fetchMock = stubFetch(new Error("https://secret.test/?key=abc"));
    const error = await failure(askJson(REQUEST));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toBe("Linear could not be reached for issues.");
    expect(error.message).not.toContain("secret.test");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("a request that never answers is given up on after the deadline, twice", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch(() => new Promise<Response>(() => {}));
    const pending = failure(askJson(REQUEST));
    await vi.advanceTimersByTimeAsync(19_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000);
    const error = await pending;
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toBe("Linear did not answer in time for issues.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("a 200 that is not JSON is refused in our words", async () => {
    stubFetch(new Response("<html>REMOTE-TEXT</html>", { status: 200 }));
    const error = await failure(askJson(REQUEST));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toBe("Linear's issues response was not JSON.");
  });

  test("ask hands back a 400 with its body instead of throwing", async () => {
    const fetchMock = stubFetch(json({ error: "invalid_grant" }, 400));
    expect(await ask(REQUEST)).toEqual({ status: 400, json: { error: "invalid_grant" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("ask hands back a body that is not JSON as undefined", async () => {
    stubFetch(new Response("", { status: 200 }));
    expect(await ask(REQUEST)).toEqual({ status: 200, json: undefined });
  });
  test("asked to, a 429 is handed back with its body instead of being tried again", async () => {
    const fetchMock = stubFetch(json({ parameters: { retry_after: 3 } }, 429));
    expect(await ask({ ...REQUEST, hand429: true })).toEqual({
      status: 429,
      json: { parameters: { retry_after: 3 } },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
