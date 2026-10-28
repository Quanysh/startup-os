import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { whileTimersRun } from "../test.timers";
import { TELEGRAM_FAILURES } from "./telegramMessage";
import { askTelegram, sendMessage } from "./telegramRequest";

// Obviously not a real token; the word is what the tests look for.
const TOKEN = "123456789:SENTINEL_fake_token_for_tests_only_000";
const URL = `https://api.telegram.org/bot${TOKEN}/sendMessage`;

type Answer = Response | Error | (() => Promise<Response>);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const sent = () => json({ ok: true, result: { message_id: 1 } });

function stubFetch(...answers: Answer[]) {
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

const send = () => whileTimersRun(sendMessage(TOKEN, "-100123", "<b>hi</b>"));

let logged: unknown[][];
beforeEach(() => {
  vi.useFakeTimers();
  logged = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
  }
});
afterEach(() => {
  // Whatever happened, the token reached no log line.
  expect(JSON.stringify(logged)).not.toContain("SENTINEL");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sendMessage", () => {
  test("posts the chat and the text as HTML with no preview, following no redirect", async () => {
    const fetchMock = stubFetch(sent());
    expect(await send()).toEqual({ ok: true, json: { ok: true, result: { message_id: 1 } } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(URL);
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(new Headers(init!.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(init!.body as string)).toEqual({
      chat_id: "-100123",
      text: "<b>hi</b>",
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  });

  test("a value that is not a bot token is never put in an address: no request at all", async () => {
    const fetchMock = stubFetch(sent());
    for (const token of ["", "SENTINEL", "1:x/../SENTINEL"]) {
      const result = await whileTimersRun(sendMessage(token, "-1", "x"));
      expect(result).toEqual({ ok: false, failure: "badToken" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    [401, "token"],
    [404, "token"],
    [400, "chat"],
    [403, "chat"],
    [409, "other"],
    [302, "other"],
  ] as const)("a %i is the fixed failure %s, asked once", async (status, failure) => {
    const fetchMock = stubFetch(
      json({ ok: false, description: `SENTINEL said by Telegram about bot${TOKEN}` }, status),
    );
    const result = await send();
    expect(result).toEqual({ ok: false, failure });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a 200 that does not say ok is a failure", async () => {
    stubFetch(json({ ok: false }));
    expect(await send()).toEqual({ ok: false, failure: "other" });
    stubFetch(new Response("not json", { status: 200 }));
    expect(await send()).toEqual({ ok: false, failure: "other" });
  });

  test("a 5xx is tried once more, and then is a failure in fixed words", async () => {
    const twice = stubFetch(json({}, 502), sent());
    expect((await send()).ok).toBe(true);
    expect(twice).toHaveBeenCalledTimes(2);

    const still = stubFetch(json({}, 502));
    expect(await send()).toEqual({ ok: false, failure: "other" });
    expect(still).toHaveBeenCalledTimes(2);
  });

  test("a network failure is tried once more; what fetch threw is never passed on", async () => {
    const fetchMock = stubFetch(new TypeError(`fetch failed for ${URL}`));
    const result = await send();
    expect(result).toEqual({ ok: false, failure: "unreachable" });
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("no answer within the deadline, twice, is 'did not answer in time'", async () => {
    const fetchMock = stubFetch(() => new Promise<Response>(() => {}));
    expect(await send()).toEqual({ ok: false, failure: "timeout" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("a 429 with a short retry_after is waited out, once", async () => {
    const fetchMock = stubFetch(json({ ok: false, parameters: { retry_after: 7 } }, 429), sent());
    const work = sendMessage(TOKEN, "-100123", "x");
    await vi.advanceTimersByTimeAsync(6_900);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await work).ok).toBe(true);
  });

  test("a second 429 is given up on", async () => {
    const fetchMock = stubFetch(json({ ok: false, parameters: { retry_after: 1 } }, 429));
    expect(await send()).toEqual({ ok: false, failure: "slow" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["longer than 30 seconds", { retry_after: 31 }],
    ["missing", {}],
    ["not a number", { retry_after: "soon" }],
    ["negative", { retry_after: -5 }],
    ["a fraction", { retry_after: 2.5 }],
  ])("a 429 whose retry_after is %s is given up on at once", async (_what, parameters) => {
    const fetchMock = stubFetch(json({ ok: false, parameters }, 429));
    expect(await send()).toEqual({ ok: false, failure: "slow" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a retry_after of exactly 30 seconds is honoured", async () => {
    const fetchMock = stubFetch(json({ ok: false, parameters: { retry_after: 30 } }, 429), sent());
    expect((await send()).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("every failure has a sentence, and none of them could hold a token", () => {
    for (const sentence of Object.values(TELEGRAM_FAILURES)) {
      expect(sentence).toMatch(/^[A-Z][A-Za-z_' ;,.]+\.$/);
    }
  });
});

describe("askTelegram", () => {
  test("getUpdates asks for a few recent updates and does not wait for new ones", async () => {
    const fetchMock = stubFetch(json({ ok: true, result: [] }));
    const result = await whileTimersRun(askTelegram(TOKEN, "getUpdates"));
    expect(result).toEqual({ ok: true, json: { ok: true, result: [] } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates`);
    expect(JSON.parse(init!.body as string)).toEqual({ timeout: 0, limit: 100 });
  });

  test("a 409 (the bot has a webhook) is said as such", async () => {
    stubFetch(json({ ok: false }, 409));
    expect(await whileTimersRun(askTelegram(TOKEN, "getUpdates"))).toEqual({
      ok: false,
      failure: "updates",
    });
  });
});

describe("askTelegram, quick: for a request that holds another one open", () => {
  const quick = () =>
    askTelegram(TOKEN, "sendMessage", { chat_id: "-100123", text: "x" }, { quick: true });

  test("a success is the same answer", async () => {
    const fetchMock = stubFetch(sent());
    expect((await quick()).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a 5xx is not tried again", async () => {
    const fetchMock = stubFetch(json({}, 502), sent());
    expect(await whileTimersRun(quick())).toEqual({ ok: false, failure: "other" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a network failure is not tried again", async () => {
    const fetchMock = stubFetch(new TypeError(`fetch failed for ${URL}`), sent());
    expect(await whileTimersRun(quick())).toEqual({ ok: false, failure: "unreachable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a 429 is not waited out, however short the wait it asks for", async () => {
    const fetchMock = stubFetch(json({ ok: false, parameters: { retry_after: 1 } }, 429), sent());
    // No timer is advanced: the answer is there at once.
    expect(await quick()).toEqual({ ok: false, failure: "slow" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("no answer in eight seconds is given up on, once", async () => {
    const fetchMock = stubFetch(() => new Promise<Response>(() => {}));
    let answer: unknown;
    void quick().then((result) => {
      answer = result;
    });
    await vi.advanceTimersByTimeAsync(7_900);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    expect(answer).toEqual({ ok: false, failure: "timeout" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
