import { describe, expect, test, vi } from "vitest";
import { run } from "./pushRetention";
import { retentionToEnvelope } from "./retentionToEnvelope";

// Made-up export shaped like the real one. Every name contains "SECRET" so one
// assertion can prove none of them is ever printed or sent.
const EXPORT = {
  cutoff: "2026-10-15",
  fx: 500,
  fxDate: "2026-09-18",
  clients: { ever: 25, active: 16, using: 3, churned: 6, names: ["SECRET CLINIC ALPHA"] },
  usingNames: "SECRET CLINIC BETA, SECRET CLINIC GAMMA",
  rates: { retention: 0.64, monthlyChurn: 0.0375, annualChurn: 0.3679 },
  money: { register: 1_800_000, receipts: 1_650_000, payers: 14, owed: 2_400_000 },
  notes: ["SECRET NOTE about one client"],
};
const NOW = new Date("2026-11-03T09:30:00Z");
const TOKEN = "fake-token-0123456789abcdefghijklmnopqrstuvwxyz";
const URL = "https://fake-otter-123.convex.site/ingest/v1";
const ENV = { STARTUP_OS_INGEST_URL: URL, INGEST_TOKEN_CFO_WORKBOOK: TOKEN };
const PATH = "/fake/retention.json";
const USAGE = "Usage: pnpm push:retention [path/to/retention.json] [--send]";
const CONFIRMED = '{"ok":true,"inserted":8,"updated":0,"unchanged":0}';

const reply = (body: string | null, status = 200) => async () => new Response(body, { status });

function setup(options: { file?: string; reply?: () => Promise<Response> } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const readFile = vi.fn((_path: string) => options.file ?? JSON.stringify(EXPORT));
  const fetchMock = vi.fn(options.reply ?? reply(CONFIRMED));
  const deps = {
    readFile,
    fetch: fetchMock as unknown as typeof fetch,
    print: (line: string) => void out.push(line),
    printError: (line: string) => void err.push(line),
    now: () => NOW,
  };
  return { deps, readFile, fetchMock, out, err, printed: () => [...out, ...err].join("\n") };
}

describe("run: printing is the default", () => {
  test.each([[[]], [["--dry-run"]], [[PATH]], [[PATH, "--dry-run"]]])(
    "%j prints the envelope and sends nothing, even with credentials set",
    async (argv) => {
      const h = setup();
      expect(await run(argv, ENV, h.deps)).toBe(0);
      expect(h.fetchMock).not.toHaveBeenCalled();
      expect(JSON.parse(h.out.join("\n"))).toEqual(retentionToEnvelope(EXPORT, NOW));
      expect(h.printed()).not.toContain("SECRET");
      expect(h.printed()).not.toContain(TOKEN);
      // On stderr, so a piped envelope stays valid JSON.
      expect(h.err.join("\n")).toContain("Nothing was sent. Add --send to push it.");
    },
  );

  test("the export is read from the path given, else from the default beside this repo", async () => {
    const given = setup();
    await run([PATH], ENV, given.deps);
    expect(given.readFile).toHaveBeenCalledWith(PATH);

    const dflt = setup();
    await run([], ENV, dflt.deps);
    expect(dflt.readFile).toHaveBeenCalledWith(
      expect.stringMatching(/startup-model\/tools\/retention\.json$/),
    );
  });
});

describe("run: --send", () => {
  test("posts the envelope once, to the endpoint, with the token, following no redirect", async () => {
    const h = setup();
    expect(await run([PATH, "--send"], ENV, h.deps)).toBe(0);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(URL);
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    });
    expect(JSON.parse(init.body as string)).toEqual(retentionToEnvelope(EXPORT, NOW));
    expect(h.printed()).toContain("200 ok: true, inserted: 8, updated: 0, unchanged: 0");
    expect(h.printed()).not.toContain(TOKEN);
  });

  test("names the host it is about to post to, and only the host", async () => {
    const h = setup();
    await run(["--send"], ENV, h.deps);
    const line = h.out.find((l) => l.includes("fake-otter-123.convex.site"));
    expect(line).toBeDefined();
    expect(line).not.toContain("/ingest");
    expect(line).not.toContain("https://");
    expect(line).not.toContain(TOKEN);
    // It is said before the reply, not after.
    expect(h.out.indexOf(line!)).toBeLessThan(h.out.findIndex((l) => l.startsWith("200 ")));
  });

  test("missing credentials: says what to set and sends nothing", async () => {
    for (const env of [{}, { STARTUP_OS_INGEST_URL: URL }, { INGEST_TOKEN_CFO_WORKBOOK: TOKEN }]) {
      const h = setup();
      expect(await run(["--send"], env, h.deps)).toBe(1);
      expect(h.err).toEqual([
        "Set STARTUP_OS_INGEST_URL and INGEST_TOKEN_CFO_WORKBOOK in .env.push or the environment.",
      ]);
      expect(h.fetchMock).not.toHaveBeenCalled();
    }
  });

  test.each([
    [
      "an http URL",
      { STARTUP_OS_INGEST_URL: "http://fake-otter-123.convex.site/ingest/v1" },
      "STARTUP_OS_INGEST_URL must be https (http is allowed only for localhost).",
    ],
    [
      "a token with a newline",
      { INGEST_TOKEN_CFO_WORKBOOK: `${TOKEN}\nTAILMARKER` },
      'INGEST_TOKEN_CFO_WORKBOOK must be 32 or more letters, digits, "-" or "_".',
    ],
  ])("%s: refused, nothing sent, nothing echoed", async (_label, override, message) => {
    const h = setup();
    expect(await run(["--send"], { ...ENV, ...override }, h.deps)).toBe(1);
    expect(h.err).toEqual([message]);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.printed()).not.toContain("TAILMARKER");
    expect(h.printed()).not.toContain(TOKEN);
  });
});

describe("run: arguments", () => {
  test.each([
    [["--dryrun"]],
    [["--help"]],
    [["--Send"]],
    [["--dry-run=true"]],
    [["-h"]],
    [["a.json", "b.json"]],
    [["--send", "--dry-run"]],
    [["--send", "a.json", "b.json"]],
  ])("%j prints the usage line and does nothing else", async (argv) => {
    const h = setup();
    expect(await run(argv, ENV, h.deps)).toBe(1);
    expect(h.err).toEqual([USAGE]);
    expect(h.out).toEqual([]);
    expect(h.readFile).not.toHaveBeenCalled();
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

describe("run: the export", () => {
  test("malformed JSON: said plainly, nothing from the file printed", async () => {
    const h = setup({ file: 'SECRET CLINIC {"usingNames": ' });
    expect(await run([PATH, "--send"], ENV, h.deps)).toBe(1);
    expect(h.err).toEqual([`${PATH} is not valid JSON.`]);
    expect(h.printed()).not.toContain("SECRET");
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  test("an unreadable file: said plainly", async () => {
    const h = setup();
    h.readFile.mockImplementation(() => {
      throw new Error("ENOENT: no such file, open 'SECRET path'");
    });
    expect(await run([PATH], ENV, h.deps)).toBe(1);
    expect(h.err).toEqual([`Could not read ${PATH}.`]);
  });

  test.each([[[PATH]], [[PATH, "--send"]]])(
    "%j: a name sitting in a field the mapping reads is never echoed",
    async (argv) => {
      const file = JSON.stringify({
        ...EXPORT,
        cutoff: "SECRET CLINIC",
        money: { ...EXPORT.money, receipts: "SECRET", payers: "SECRET" },
      });
      const h = setup({ file });
      expect(await run(argv, ENV, h.deps)).toBe(1);
      expect(h.printed()).not.toContain("SECRET");
      expect(h.printed()).toContain("cutoff");
      expect(h.fetchMock).not.toHaveBeenCalled();
    },
  );

  test.each([[[PATH]], [[PATH, "--send"]]])(
    "%j: a figure the registry would refuse is refused here, and nothing is sent",
    async (argv) => {
      const h = setup({ file: JSON.stringify({ ...EXPORT, fx: 50 }) });
      expect(await run(argv, ENV, h.deps)).toBe(1);
      expect(h.err).toEqual(["USD/KZT rate cannot be below 100."]);
      expect(h.out).toEqual([]);
      expect(h.fetchMock).not.toHaveBeenCalled();
    },
  );

  test("a month still in progress is not refused as a future one", async () => {
    // The cutoff month is the current month on the day of the push.
    const h = setup({ file: JSON.stringify({ ...EXPORT, cutoff: "2026-11-03" }) });
    expect(await run([PATH], ENV, h.deps)).toBe(0);
  });
});

describe("run: what the endpoint answers", () => {
  test.each([
    [401, '{"ok":false,"error":"unauthorized","issues":[]}'],
    [422, '{"ok":false,"error":"invalid_snapshots","issues":[{"path":"snapshots.0.value"}]}'],
    [503, '{"ok":false,"error":"ingest_not_configured"}'],
  ])("%i: exit 1, the status and the reply's own fields shown, the token not", async (status, body) => {
    const h = setup({ reply: reply(body, status) });
    expect(await run([PATH, "--send"], ENV, h.deps)).toBe(1);
    const answer = JSON.parse(body) as { error: string };
    expect(h.err[0]).toBe(`${status} ok: false, error: ${answer.error}`);
    expect(h.printed()).not.toContain(TOKEN);
  });

  test("a confirmation is printed as its status and counts", async () => {
    const h = setup();
    expect(await run([PATH, "--send"], ENV, h.deps)).toBe(0);
    expect(h.out.at(-1)).toBe("200 ok: true, inserted: 8, updated: 0, unchanged: 0");
    expect(h.err).toEqual([]);
  });

  test("each issue is printed as its path and message, and nothing else of it", async () => {
    const body = JSON.stringify({
      ok: false,
      error: "invalid_snapshots",
      issues: [
        { path: "snapshots.0.value", message: "MRR cannot be below 0.", received: "LEAK-ONE" },
        { path: ["snapshots", 1, "key"], message: "Unknown metric.", extra: { deep: "LEAK-TWO" } },
      ],
      debug: "LEAK-THREE",
    });
    const h = setup({ reply: reply(body, 422) });
    expect(await run([PATH, "--send"], ENV, h.deps)).toBe(1);
    expect(h.err).toEqual([
      "422 ok: false, error: invalid_snapshots",
      "snapshots.0.value: MRR cannot be below 0.",
      "snapshots.1.key: Unknown metric.",
    ]);
    expect(h.printed()).not.toContain("LEAK");
  });

  test("no more than twenty issues are printed, and it says how many were left out", async () => {
    const issues = Array.from({ length: 25 }, (_, i) => ({ path: `snapshots.${i}`, message: "Bad." }));
    const h = setup({ reply: reply(JSON.stringify({ ok: false, error: "invalid_snapshots", issues }), 422) });
    await run([PATH, "--send"], ENV, h.deps);
    expect(h.err.filter((line) => line.endsWith(": Bad."))).toHaveLength(20);
    expect(h.err.at(-1)).toBe("5 more issues not shown.");
  });

  test("a field of the wrong type is left out rather than printed", async () => {
    const body = JSON.stringify({ ok: "LEAK", error: { nested: "LEAK" }, inserted: "LEAK", issues: "LEAK" });
    const h = setup({ reply: reply(body, 400) });
    expect(await run([PATH, "--send"], ENV, h.deps)).toBe(1);
    expect(h.err).toEqual(["400"]);
  });

  test("a long reply that is not JSON is never printed, escape sequences and all", async () => {
    // What a proxy's error page, or anything else answering in the endpoint's place, could send.
    const body = `\u001b[2J\u001b[31mBODYMARKER ${"x".repeat(50 * 1024)}`;
    expect(body.length).toBeGreaterThan(50 * 1024);
    expect(body).toContain("\u001b");
    for (const status of [200, 502]) {
      const h = setup({ reply: reply(body, status) });
      expect(await run([PATH, "--send"], ENV, h.deps)).toBe(1);
      expect(h.err.slice(0, 2)).toEqual([String(status), "The endpoint did not answer with JSON."]);
      for (const line of [...h.out, ...h.err]) {
        expect(line).not.toContain("BODYMARKER");
        expect(line).not.toContain("\u001b");
        expect(line.length).toBeLessThan(200);
      }
    }
  });

  test("an escape sequence inside a JSON field is not printed either", async () => {
    const body = JSON.stringify({
      ok: false,
      error: "bad\u001b[31m",
      issues: [{ path: "a\u001b[2J", message: "m\u001b[0m\nsecond line" }],
    });
    const h = setup({ reply: reply(body, 422) });
    await run([PATH, "--send"], ENV, h.deps);
    for (const line of h.err) {
      expect(line).not.toContain("\u001b");
      expect(line).not.toContain("\n");
    }
    expect(h.err[1]).toContain("second line");
  });

  test("a redirect is reported, not followed", async () => {
    const h = setup({
      reply: async () =>
        new Response(null, { status: 307, headers: { Location: "https://fake-elsewhere.example/" } }),
    });
    expect(await run([PATH, "--send"], ENV, h.deps)).toBe(1);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.err.join("\n")).toMatch(/redirected/i);
    expect(h.err.join("\n")).toMatch(/nothing was followed/i);
    expect(h.printed()).not.toContain("fake-elsewhere");
  });

  test("a 200 that is not the endpoint's JSON answer is not a success", async () => {
    const h = setup({ reply: reply("<html><body>Sign in</body></html>") });
    expect(await run([PATH, "--send"], ENV, h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("not an ingest confirmation");
  });

  test("a 204 is not a success", async () => {
    const h = setup({ reply: reply(null, 204) });
    expect(await run([PATH, "--send"], ENV, h.deps)).toBe(1);
  });

  test("a 200 that says ok: false is not a success", async () => {
    const h = setup({ reply: reply('{"ok":false}') });
    expect(await run([PATH, "--send"], ENV, h.deps)).toBe(1);
  });

  test("a reply whose body cannot be read is a failure, said plainly", async () => {
    const h = setup({
      reply: async () => {
        const response = new Response("x", { status: 200 });
        vi.spyOn(response, "text").mockRejectedValue(new Error(`boom ${TOKEN}`));
        return response;
      },
    });
    expect(await run([PATH, "--send"], ENV, h.deps)).toBe(1);
    expect(h.err).toEqual(["The endpoint's reply could not be read."]);
  });
});

describe("run: when the request fails", () => {
  test("names the error code, never the error's own message", async () => {
    const h = setup({
      reply: async () => {
        throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
      },
    });
    expect(await run([PATH, "--send"], ENV, h.deps)).toBe(1);
    expect(h.err).toEqual(["The push could not reach the endpoint (ENOTFOUND)."]);
    expect(h.printed()).not.toContain("fetch failed");
  });

  test("an error that quotes the header is not printed", async () => {
    const h = setup({
      reply: async () => {
        throw new TypeError(`Headers.append: "Bearer ${TOKEN}" is an invalid header value.`);
      },
    });
    expect(await run([PATH, "--send"], ENV, h.deps)).toBe(1);
    expect(h.err).toEqual(["The push could not reach the endpoint (unknown error)."]);
    expect(h.printed()).not.toContain(TOKEN);
  });

  test("a cause code that is not a plain code is not echoed", async () => {
    const h = setup({
      reply: async () => {
        throw new TypeError("fetch failed", { cause: { code: `Bearer ${TOKEN}` } });
      },
    });
    expect(await run([PATH, "--send"], ENV, h.deps)).toBe(1);
    expect(h.printed()).not.toContain(TOKEN);
  });
});
