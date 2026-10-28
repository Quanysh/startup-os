import { describe, expect, test, vi } from "vitest";
import { ACK_USAGE, OUTBOX_USAGE, runAck, runOutbox, settings } from "./visibleOutbox";

// Made-up data. Every name and note says "SECRET", so one assertion proves
// what a script prints of it.
const TOKEN = "fake-visible-0123456789abcdefghijklmnopqrstuv";
const INGEST_URL = "https://fake-otter-123.convex.site/ingest/v1";
const ENV = { STARTUP_OS_INGEST_URL: INGEST_URL, INGEST_TOKEN_VISIBLE: TOKEN };
const PATH = "/fake/ack.json";

const OUTBOX = {
  ok: true,
  items: [
    {
      id: "row1",
      revision: 0,
      kind: "update",
      investor: { externalId: "inv_1", name: "SECRET Fund" },
      fields: { stage: "meeting", amount: null },
      osStage: "meeting",
      note: "Next step: SECRET",
      extra: "dropped",
    },
    { id: "row2", revision: 3, kind: "create", investor: { name: "SECRET Angel" }, fields: { stage: "target", name: "SECRET Angel" }, osStage: "target" },
  ],
  truncated: false,
};
const ACK = {
  results: [
    { id: "row1", revision: 0, ok: true },
    { id: "row2", revision: 3, ok: true, visibleId: "inv_2" },
    { id: "row3", revision: 0, ok: false, errorCode: "unmapped_stage" },
  ],
};

type Reply = { status?: number; body?: unknown; redirect?: boolean };

function harness(reply: Reply = {}, file: unknown = ACK) {
  const out: string[] = [];
  const err: string[] = [];
  const written = new Map<string, string>();
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    if (reply.redirect) return new Response(null, { status: 302, headers: { Location: "https://elsewhere.test/" } });
    const body = reply.body ?? OUTBOX;
    return new Response(JSON.stringify(body), { status: reply.status ?? 200 });
  });
  const deps = {
    readFile: (path: string) => {
      if (path !== PATH) throw new Error("ENOENT");
      return typeof file === "string" ? file : JSON.stringify(file);
    },
    writeFile: (path: string, text: string) => void written.set(path, text),
    fetch: fetchMock as unknown as typeof fetch,
    print: (line: string) => void out.push(line),
    printError: (line: string) => void err.push(line),
  };
  const printed = () => [...out, ...err].join("\n");
  return { deps, out, err, fetchMock, printed, written };
}

describe("settings", () => {
  test("the two routes are on the ingest endpoint's own host", () => {
    const { deps } = harness();
    expect(settings(ENV, deps)).toEqual({
      outbox: "https://fake-otter-123.convex.site/ingest/v1/visible/outbox",
      ack: "https://fake-otter-123.convex.site/ingest/v1/visible/outbox/ack",
      token: TOKEN,
    });
  });

  test("the app's own domain passes both routes through, as push:envelope's address does", () => {
    const { deps } = harness();
    expect(settings({ ...ENV, STARTUP_OS_INGEST_URL: "https://os.example.com/ingest/v1" }, deps)).toMatchObject({
      outbox: "https://os.example.com/ingest/v1/visible/outbox",
      ack: "https://os.example.com/ingest/v1/visible/outbox/ack",
    });
  });

  test("a missing or unfit token is refused without printing it", () => {
    const { deps, printed } = harness();
    expect(settings({ STARTUP_OS_INGEST_URL: INGEST_URL }, deps)).toBeNull();
    expect(settings({ ...ENV, INGEST_TOKEN_VISIBLE: "short token" }, deps)).toBeNull();
    expect(printed()).not.toContain("short token");
  });
});

describe("pnpm visible:outbox", () => {
  test("prints the items as JSON, dropping fields it does not know, with the token sent and never printed", async () => {
    const { deps, out, fetchMock, printed } = harness();
    expect(await runOutbox([], ENV, deps)).toBe(0);
    const doc = JSON.parse(out.join("\n"));
    expect(doc.items).toHaveLength(2);
    expect(doc.items[0].extra).toBeUndefined();
    expect(doc.truncated).toBe(false);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://fake-otter-123.convex.site/ingest/v1/visible/outbox");
    expect(init).toMatchObject({ method: "GET", redirect: "manual", headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(printed()).not.toContain(TOKEN);
  });

  test("with a path, writes the file and prints counts only", async () => {
    const { deps, written, printed } = harness();
    expect(await runOutbox(["/fake/outbox.json"], ENV, deps)).toBe(0);
    expect(JSON.parse(written.get("/fake/outbox.json")!).items).toHaveLength(2);
    expect(printed()).toContain("Items: 2 (create 1, update 1)");
    expect(printed()).not.toContain("SECRET");
  });

  test("a refusal prints its status and code; a reply it does not recognise prints nothing of it", async () => {
    const refused = harness({ status: 401, body: { ok: false, error: "unauthorized" } });
    expect(await runOutbox([], ENV, refused.deps)).toBe(1);
    expect(refused.err).toEqual(["401 unauthorized"]);

    const odd = harness({ body: { ok: true, items: [{ name: "SECRET" }], truncated: false } });
    expect(await runOutbox([], ENV, odd.deps)).toBe(1);
    expect(odd.printed()).not.toContain("SECRET");
  });

  test("a redirect is not followed", async () => {
    const { deps, fetchMock } = harness({ redirect: true });
    expect(await runOutbox([], ENV, deps)).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a flag or two paths is the usage", async () => {
    const { deps, err, fetchMock } = harness();
    expect(await runOutbox(["--send"], ENV, deps)).toBe(1);
    expect(await runOutbox(["a", "b"], ENV, deps)).toBe(1);
    expect(err).toEqual([OUTBOX_USAGE, OUTBOX_USAGE]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("pnpm visible:ack", () => {
  test("checks the file and says what it holds, sending nothing without --send", async () => {
    const { deps, out, err, fetchMock } = harness();
    expect(await runAck([PATH], {}, deps)).toBe(0);
    expect(out).toEqual(["Results: 3", "Written: 2 (with a Visible id: 1)", "Failed: 1 (unmapped_stage 1)"]);
    expect(err).toEqual(["Nothing was sent. Add --send to post it."]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("--send posts the results and prints the endpoint's counts", async () => {
    const reply = { ok: true, sent: 1, confirmed: 0, failed: 1, stale: 0, unknown: 0 };
    const { deps, out, fetchMock } = harness({ body: reply });
    expect(await runAck([PATH, "--send"], ENV, deps)).toBe(0);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://fake-otter-123.convex.site/ingest/v1/visible/outbox/ack");
    expect(JSON.parse(init!.body as string)).toEqual(ACK);
    expect(out.at(-1)).toBe("200 ok: sent 1, confirmed 0, failed 1, stale 0, unknown 0");
  });

  test("a file the endpoint would refuse is refused here, in a path and fixed words", async () => {
    const { deps, err, fetchMock } = harness({}, { results: [{ id: "a", revision: 0, ok: false, errorCode: "SECRET words" }] });
    expect(await runAck([PATH, "--send"], ENV, deps)).toBe(1);
    expect(err[0]).toMatch(/^results\.0\.errorCode: /);
    expect(err.join("\n")).not.toContain("SECRET");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a file that is not JSON is not quoted", async () => {
    const { deps, err } = harness({}, "{SECRET");
    expect(await runAck([PATH], {}, deps)).toBe(1);
    expect(err).toEqual([`${PATH} is not valid JSON.`]);
  });

  test("an unknown flag, or none or two files, is the usage", async () => {
    const { deps, err } = harness();
    expect(await runAck([PATH, "--force"], ENV, deps)).toBe(1);
    expect(await runAck([], ENV, deps)).toBe(1);
    expect(await runAck([PATH, PATH], ENV, deps)).toBe(1);
    expect(err).toEqual([ACK_USAGE, ACK_USAGE, ACK_USAGE]);
  });

  test("a reply that is not the endpoint's confirmation is not taken for one", async () => {
    const { deps, err } = harness({ body: { ok: true } });
    expect(await runAck([PATH, "--send"], ENV, deps)).toBe(1);
    expect(err).toContain("That is not the endpoint's confirmation, so the ack is not confirmed.");
  });
});
