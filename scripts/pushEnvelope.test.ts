import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { run } from "./pushEnvelope";

// Made-up envelopes. Every name and subject contains "SECRET", so one
// assertion proves none of them is ever printed.
const NOW = new Date("2026-10-14T06:00:00Z"); // a Wednesday; the week began 2026-10-12
const TOKEN = "fake-token-0123456789abcdefghijklmnopqrstuvwxyz";
const OTHER_TOKEN = "fake-other-0123456789abcdefghijklmnopqrstuvwxyz";
const URL = "https://fake-otter-123.convex.site/ingest/v1";
const PATH = "/fake/envelope.json";
const USAGE = "Usage: pnpm push:envelope <file.json> [--send]";
const CONFIRMED = '{"ok":true,"inserted":2,"updated":0,"unchanged":0}';

const header = (source: string) => ({
  version: 1,
  source,
  batchId: `${source}-SECRET-batch`,
  observedAt: "2026-10-14T06:00:00Z",
});
const week = (key: string, periodStart: string, value = 5) => ({
  key,
  scope: "startup_insights",
  period: "week",
  periodStart,
  value,
});
const POSTHOG = {
  ...header("posthog"),
  snapshots: [
    week("web_visitors", "2026-10-05", 120),
    week("signups", "2026-10-05", 9),
    week("signups", "2026-09-28", 4),
  ],
};
const GMAIL = {
  ...header("gmail"),
  records: [
    {
      threadId: "18c2f0a1",
      fromName: "SECRET Sender",
      fromAddress: "secret-sender@example-fund.test",
      subject: "SECRET subject",
      lastMessageAt: "2026-10-13T15:04:05Z",
    },
    {
      threadId: "18c2f0a2",
      fromAddress: "another@example-fund.test",
      lastMessageAt: "2026-10-13T16:00:00Z",
    },
  ],
};
const VISIBLE = {
  ...header("visible"),
  mode: "replace",
  investors: [{ externalId: "inv_1", name: "SECRET Capital", contact: "SECRET Partner", stage: "Contacted" }],
};

// The financial model's plan: every scenario, year and figure. It holds no
// name; the lists are spelled out here so the summary is checked against words.
const PLAN_YEARS = [2026, 2027, 2028, 2029, 2030, 2031];
const planRows = (years: number[] = PLAN_YEARS) =>
  ["bear", "base", "bull"].flatMap((scenario) =>
    years.flatMap((year) =>
      ["arr", "revenue", "net_burn", "cash_end", "headcount", "paying_customers", "capital_raised"].map(
        (key) => ({ scenario, year, key, value: 1 }),
      ),
    ),
  );
const plan = (rows: unknown[] = planRows(), source = "financial_model") => ({
  ...header(source),
  plan: { modelVersion: "920ac834b5b2", rows },
});
const PLAN_SUMMARY = [
  "Source: financial_model",
  "Kind: plan",
  "Model version: 920ac834b5b2",
  "Rows: 126",
  "Scenarios: bear, base, bull",
  // An en dash.
  "Years: 2026–2031",
  "Figures: arr, revenue, net_burn, cash_end, headcount, paying_customers, capital_raised",
];

const reply = (body: string | null, status = 200) => async () => new Response(body, { status });

function setup(options: { file?: unknown; reply?: () => Promise<Response> } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const file = options.file === undefined ? POSTHOG : options.file;
  const readFile = vi.fn((_path: string) => (typeof file === "string" ? file : JSON.stringify(file)));
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
const envFor = (source: string, token = TOKEN) => ({
  STARTUP_OS_INGEST_URL: URL,
  [`INGEST_TOKEN_${source.toUpperCase()}`]: token,
});

describe("run: arguments", () => {
  test.each([
    [[]],
    [["--send"]],
    [[PATH, "/fake/another.json"]],
    [[PATH, "--sned"]],
    [[PATH, "-s"]],
    [[PATH, "--send", "--dry-run"]],
    [[PATH, "--send", "--force"]],
  ])("%j prints the usage line, exits 1, and neither reads nor sends", async (argv) => {
    const h = setup();
    expect(await run(argv, envFor("posthog"), h.deps)).toBe(1);
    expect(h.err).toEqual([USAGE]);
    expect(h.out).toEqual([]);
    expect(h.readFile).not.toHaveBeenCalled();
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

describe("run: printing is the default", () => {
  test.each([[[PATH]], [[PATH, "--dry-run"]]])(
    "%j says what the file holds and sends nothing, even with credentials set",
    async (argv) => {
      const h = setup();
      expect(await run(argv, envFor("posthog"), h.deps)).toBe(0);
      expect(h.fetchMock).not.toHaveBeenCalled();
      expect(h.readFile).toHaveBeenCalledWith(PATH);
      expect(h.out).toEqual([
        "Source: posthog",
        "Kind: snapshots",
        "Snapshots: 3",
        "Metric keys: signups, web_visitors",
      ]);
      expect(h.err).toEqual(["Nothing was sent. Add --send to push it."]);
      expect(h.printed()).not.toContain(TOKEN);
    },
  );

  test("printing needs no credentials at all", async () => {
    const h = setup();
    expect(await run([PATH], {}, h.deps)).toBe(0);
    expect(h.out[0]).toBe("Source: posthog");
  });

  test("records: the source, the kind and a count; never a name or a subject", async () => {
    const h = setup({ file: GMAIL });
    expect(await run([PATH], {}, h.deps)).toBe(0);
    expect(h.out).toEqual(["Source: gmail", "Kind: records", "Records: 2"]);
    expect(h.printed()).not.toContain("SECRET");
    expect(h.printed()).not.toContain("example-fund");
  });

  test("Intercom's conversations: counts by where they began; never a name, a title or an id", async () => {
    const chat = (id: string, origin: string, pageArea: string | null) => ({
      id,
      createdAt: "2026-10-13T08:00:00.000Z",
      updatedAt: "2026-10-13T09:00:00.000Z",
      state: "open",
      open: true,
      priority: false,
      waitingSince: null,
      origin,
      pageArea,
      finParticipated: true,
      finOutcome: "escalated",
      humanRepliedAt: null,
      timeToHumanReply: null,
      lastCustomerReplyAt: "2026-10-13T09:00:00.000Z",
      lastHumanReplyAt: null,
      assignee: { id: "41", name: "SECRET Teammate" },
      parts: 3,
      reopens: 0,
      rating: null,
      articles: ["SECRET article"],
    });
    const file = {
      ...header("intercom"),
      appIdCode: "made0up1",
      records: [chat("90001", "customer", "studies"), chat("90002", "test", null)],
    };
    const h = setup({ file });
    expect(await run([PATH], {}, h.deps)).toBe(0);
    expect(h.out).toEqual([
      "Source: intercom",
      "Kind: records (Intercom conversations)",
      "Records: 2",
      "Began: customer 1, test 1, other 0, unknown 0",
    ]);
    expect(h.printed()).not.toContain("SECRET");
    expect(h.printed()).not.toContain("9000");
    const shrinking = setup({ file: { ...file, allowShrink: true } });
    expect(await run([PATH], {}, shrinking.deps)).toBe(0);
    expect(shrinking.out.at(-1)).toBe("Shrink: allowed (it may remove more than half of the chats stored)");
    const bad = setup({ file: { ...file, records: [{ ...chat("1", "customer", null), body: "SECRET" }] } });
    expect(await run([PATH], {}, bad.deps)).not.toBe(0);
    expect(bad.printed()).not.toContain("SECRET");
  });

  test("an explicit empty push says what it will do", async () => {
    const h = setup({ file: { ...header("gmail"), records: [], empty: true } });
    expect(await run([PATH], {}, h.deps)).toBe(0);
    expect(h.out).toEqual([
      "Source: gmail",
      "Kind: records",
      "Records: 0 (an explicit empty push: what is stored will be removed)",
    ]);
  });

  test("investors: counts and the mode; never a firm or a person", async () => {
    const h = setup({ file: VISIBLE });
    expect(await run([PATH], {}, h.deps)).toBe(0);
    expect(h.out).toEqual(["Source: visible", "Kind: investors", "Investors: 1", "Mode: replace"]);
    expect(h.printed()).not.toContain("SECRET");
  });

  test("the batch id is the sender's text and is not printed", async () => {
    const h = setup();
    await run([PATH], {}, h.deps);
    expect(h.printed()).not.toContain("SECRET");
  });

  test("a plan: its model version, a count, and the scenarios, years and figures it covers", async () => {
    const h = setup({ file: plan() });
    expect(await run([PATH], envFor("financial_model"), h.deps)).toBe(0);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.out).toEqual(PLAN_SUMMARY);
    expect(h.err).toEqual(["Nothing was sent. Add --send to push it."]);
    expect(h.printed()).not.toContain("SECRET");
    expect(h.printed()).not.toContain(TOKEN);
  });

  test("Vertical Startup's agents: counts only", async () => {
    const agents = {
      ...header("vertical_agents"),
      agentUsage: [
        {
          product: "vertical_startup",
          agentId: "made-up.select",
          promptVersion: "3",
          provider: "vertex",
          model: "made-up-pro",
          day: "2026-10-13",
          calls: 4,
          errors: 0,
          schemaFailures: 0,
          fallbacks: 0,
          refusals: 0,
          inputTokens: 10,
          outputTokens: 5,
        },
      ],
    };
    const h = setup({ file: agents });
    expect(await run([PATH], envFor("vertical_agents"), h.deps)).toBe(0);
    expect(h.out).toEqual([
      "Source: vertical_agents",
      "Kind: agents",
      "Usage rows: 1",
      "Provider rows: 0",
      "Applied config: not said",
    ]);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  test("a plan's summary is in the OS's order, whatever order the file's rows are in", async () => {
    const h = setup({ file: plan(planRows().reverse()) });
    expect(await run([PATH], {}, h.deps)).toBe(0);
    expect(h.out).toEqual(PLAN_SUMMARY);
  });

  test("a plan of one year names that year alone", async () => {
    const h = setup({ file: plan(planRows([2026])) });
    expect(await run([PATH], {}, h.deps)).toBe(0);
    expect(h.out).toEqual([
      "Source: financial_model",
      "Kind: plan",
      "Model version: 920ac834b5b2",
      "Rows: 21",
      "Scenarios: bear, base, bull",
      "Years: 2026",
      "Figures: arr, revenue, net_burn, cash_end, headcount, paying_customers, capital_raised",
    ]);
  });
});

describe("run: the file is checked with the endpoint's rules before anything else", () => {
  const refused = async (file: unknown, argv = [PATH, "--send"], source = "gmail") => {
    const h = setup({ file });
    expect(await run(argv, envFor(source), h.deps)).toBe(1);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.out).toEqual([]);
    expect(h.printed()).not.toContain("SECRET");
    return h.err;
  };

  test("malformed JSON: said plainly, nothing from the file printed", async () => {
    expect(await refused('{"source": "SECRET')).toEqual([`${PATH} is not valid JSON.`]);
  });

  test("an unreadable file: said plainly", async () => {
    const h = setup();
    h.readFile.mockImplementation(() => {
      throw new Error("ENOENT SECRET detail");
    });
    expect(await run([PATH], {}, h.deps)).toBe(1);
    expect(h.err).toEqual([`Could not read ${PATH}.`]);
  });

  test("an envelope the schema refuses: a path and fixed words, never the unknown field", async () => {
    expect(await refused({ ...GMAIL, "SECRET Person": 1 })).toEqual([
      "envelope: has a field the OS does not accept",
    ]);
  });

  test("fixed words whatever the file holds: a name where a field should be, with no rows at all", async () => {
    // No `records`, `deals` or `customers` key to warn the parser that names are about.
    expect(await refused({ ...header("posthog"), "SECRET Person": 1 }, [PATH], "posthog")).toEqual([
      "envelope: has a field the OS does not accept",
      "envelope: Send snapshots, deals, investors, customers, records, contacts, a plan or agent usage.",
    ]);
    expect(await refused({ ...POSTHOG, snapshots: [{ ...POSTHOG.snapshots[0], "SECRET Person": 1 }] }, [PATH], "posthog")).toEqual([
      "snapshots.0: has a field the OS does not accept",
    ]);
  });

  test("a plan that is not whole is refused before it is shown or sent", async () => {
    // One figure short: 125 rows.
    expect(await refused(plan(planRows().slice(1)), [PATH, "--send"], "financial_model")).toEqual([
      "plan.rows: The plan is incomplete: every scenario needs every figure for every year.",
    ]);
  });

  test("a plan from a source that carries none, and numbers from the one that carries the plan", async () => {
    expect(await refused(plan(planRows(), "cfo_workbook"), [PATH, "--send"], "cfo_workbook")).toEqual([
      "plan: This source does not carry the plan.",
    ]);
    expect(
      await refused(
        { ...header("financial_model"), snapshots: POSTHOG.snapshots },
        [PATH, "--send"],
        "financial_model",
      ),
    ).toEqual(["envelope: This token carries the plan and nothing else."]);
  });

  test("a mail row with a body is refused by row, and nothing of it is printed", async () => {
    const rows = [GMAIL.records[0], { ...GMAIL.records[1], body: "SECRET words" }];
    expect(await refused({ ...GMAIL, records: rows })).toEqual([
      "records.1: has a field the OS does not accept",
    ]);
  });

  test("a name in a refused row is not printed", async () => {
    const rows = [{ ...GMAIL.records[0], fromAddress: "SECRET not an address" }];
    expect(await refused({ ...GMAIL, records: rows })).toEqual([
      "records.0.fromAddress: is not an email address",
    ]);
  });

  test("an empty list without `empty`, and an empty push from a source that has none", async () => {
    expect(await refused({ ...header("gmail"), records: [] })).toEqual([
      'records: An empty list is a failed read. Where nothing waiting is the real answer, send "empty": true with it.',
    ]);
    expect(await refused({ ...header("linear"), records: [], empty: true }, [PATH], "linear")).toEqual([
      "empty: An empty push is never accepted from this source: nothing there is a failed read.",
    ]);
  });

  test("records from a source that carries none, and numbers from one that carries records", async () => {
    expect(await refused({ ...header("posthog"), records: GMAIL.records }, [PATH], "posthog")).toEqual([
      "records: This source does not carry records.",
    ]);
    expect(await refused({ ...header("gmail"), snapshots: POSTHOG.snapshots })).toEqual([
      "envelope: This token carries records and nothing else.",
    ]);
  });

  test("a metric the source does not own is refused in the registry's words", async () => {
    const snapshots = [{ key: "cash", scope: "us", period: "day", periodStart: "2026-10-14", value: 1, currency: "USD" }];
    const h = setup({ file: { ...header("posthog"), snapshots } });
    expect(await run([PATH, "--send"], envFor("posthog"), h.deps)).toBe(1);
    expect(h.err).toEqual(['snapshots.0.source: "cash" (us) is written by "mercury", not "posthog".']);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  test("PostHog's week in progress is refused here, before the endpoint has to", async () => {
    const h = setup({ file: { ...header("posthog"), snapshots: [week("signups", "2026-10-12")] } });
    expect(await run([PATH, "--send"], envFor("posthog"), h.deps)).toBe(1);
    expect(h.err).toEqual([
      "snapshots.0.periodStart: This week has not ended. Only finished weeks are stored.",
    ]);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  test("a pipeline row that could not be true is refused by path", async () => {
    const investors = [{ ...VISIBLE.investors[0], amount: 5, currency: "KZT" }];
    const lines = await refused({ ...VISIBLE, investors }, [PATH], "visible");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^investors\.0\.currency: /);
  });

  test("a source that is not in the manifest, or takes no pushes, is refused without echoing it", async () => {
    for (const source of ["SECRET-source", "vercel", "manual"]) {
      expect(await refused({ ...POSTHOG, source }, [PATH], "posthog")).toEqual([
        "source: is not a source the OS takes pushes from.",
      ]);
    }
  });

  test("the client register is sent with its own script, never this one", async () => {
    const file = {
      ...header("client_register"),
      customers: [{ name: "SECRET clinic", market: "us", status: "active" }],
    };
    expect(await refused(file, [PATH], "client_register")).toEqual([
      "The client register has its own script: pnpm push:customers.",
    ]);
  });

  test("no more than twenty issues are printed, and it says how many were left out", async () => {
    const records = Array.from({ length: 25 }, () => "SECRET");
    const lines = await refused({ ...header("gmail"), records });
    expect(lines).toHaveLength(21);
    expect(lines.at(-1)).toBe("5 more issues not shown.");
  });
});

describe("run: --send", () => {
  test("posts the envelope once, with its own source's token, following no redirect", async () => {
    const h = setup();
    expect(await run([PATH, "--send"], envFor("posthog"), h.deps)).toBe(0);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(URL);
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    });
    expect(JSON.parse(init.body as string)).toEqual(POSTHOG);
    expect(h.out).toEqual([
      "Source: posthog",
      "Kind: snapshots",
      "Snapshots: 3",
      "Metric keys: signups, web_visitors",
      "Sending to fake-otter-123.convex.site.",
      "200 ok: inserted 2, updated 0, unchanged 0",
    ]);
    expect(h.printed()).not.toContain(TOKEN);
  });

  test("the token is chosen by the envelope's source, and no other source's is used", async () => {
    const env = {
      STARTUP_OS_INGEST_URL: URL,
      INGEST_TOKEN_POSTHOG: OTHER_TOKEN,
      INGEST_TOKEN_GMAIL: TOKEN,
    };
    const h = setup({ file: GMAIL });
    expect(await run([PATH, "--send"], env, h.deps)).toBe(0);
    const [, init] = h.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    expect(JSON.parse(init.body as string)).toEqual(GMAIL);
    expect(h.printed()).not.toContain("SECRET");
  });

  test("another source's token is not borrowed: missing its own, it says which to set", async () => {
    const h = setup({ file: GMAIL });
    const env = { STARTUP_OS_INGEST_URL: URL, INGEST_TOKEN_POSTHOG: TOKEN };
    expect(await run([PATH, "--send"], env, h.deps)).toBe(1);
    expect(h.err).toEqual([
      "Set STARTUP_OS_INGEST_URL and INGEST_TOKEN_GMAIL in .env.push or the environment.",
    ]);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  test("a plan is posted once, with the financial model's own token", async () => {
    const file = plan();
    const h = setup({ file });
    const env = { ...envFor("financial_model"), INGEST_TOKEN_CFO_WORKBOOK: OTHER_TOKEN };
    expect(await run([PATH, "--send"], env, h.deps)).toBe(0);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(URL);
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    expect(JSON.parse(init.body as string)).toEqual(file);
    expect(h.out).toEqual([
      ...PLAN_SUMMARY,
      "Sending to fake-otter-123.convex.site.",
      "200 ok: inserted 2, updated 0, unchanged 0",
    ]);
    expect(h.printed()).not.toContain(TOKEN);
  });

  test("a plan without the model's own token is not sent: it says which to set", async () => {
    const h = setup({ file: plan() });
    const env = { STARTUP_OS_INGEST_URL: URL, INGEST_TOKEN_CFO_WORKBOOK: TOKEN };
    expect(await run([PATH, "--send"], env, h.deps)).toBe(1);
    expect(h.err).toEqual([
      "Set STARTUP_OS_INGEST_URL and INGEST_TOKEN_FINANCIAL_MODEL in .env.push or the environment.",
    ]);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  test("a missing URL is said the same way", async () => {
    const h = setup();
    expect(await run([PATH, "--send"], { INGEST_TOKEN_POSTHOG: TOKEN }, h.deps)).toBe(1);
    expect(h.err).toEqual([
      "Set STARTUP_OS_INGEST_URL and INGEST_TOKEN_POSTHOG in .env.push or the environment.",
    ]);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    ["http://fake-otter-123.convex.site/ingest/v1", "STARTUP_OS_INGEST_URL must be https (http is allowed only for localhost)."],
    ["https://os.example.test/ingest/v1", "STARTUP_OS_INGEST_URL must be a *.convex.site address, https://os.example.com, or localhost."],
    ["https://fake-otter-123.convex.site/other", "STARTUP_OS_INGEST_URL must end in /ingest/v1."],
    ["https://user:pass@fake-otter-123.convex.site/ingest/v1", "STARTUP_OS_INGEST_URL must not contain credentials."],
    ["not a url", "STARTUP_OS_INGEST_URL is not a URL."],
  ])("a URL the token must not go to (%s) is refused, and nothing is sent", async (url, words) => {
    const h = setup();
    const env = { STARTUP_OS_INGEST_URL: url, INGEST_TOKEN_POSTHOG: TOKEN };
    expect(await run([PATH, "--send"], env, h.deps)).toBe(1);
    expect(h.err).toEqual([words]);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  test.each(["http://127.0.0.1:3211/ingest/v1", "http://localhost:3211/ingest/v1"])(
    "local dev (%s) is allowed over http",
    async (url) => {
      const h = setup();
      const env = { STARTUP_OS_INGEST_URL: url, INGEST_TOKEN_POSTHOG: TOKEN };
      expect(await run([PATH, "--send"], env, h.deps)).toBe(0);
      const [target] = h.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(target).toBe(url);
    },
  );

  test("a token that is too short or oddly shaped is refused by name, never by value", async () => {
    const h = setup();
    const env = { STARTUP_OS_INGEST_URL: URL, INGEST_TOKEN_POSTHOG: "short SECRET" };
    expect(await run([PATH, "--send"], env, h.deps)).toBe(1);
    expect(h.err).toEqual(['INGEST_TOKEN_POSTHOG must be 32 or more letters, digits, "-" or "_".']);
    expect(h.printed()).not.toContain("SECRET");
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

describe("run: what is printed of the reply", () => {
  const sent = async (respond: () => Promise<Response>, file: unknown = GMAIL) => {
    const h = setup({ file, reply: respond });
    const code = await run([PATH, "--send"], envFor("gmail"), h.deps);
    return { code, ...h };
  };

  test("a refusal is its status, its error code and each issue's path and words", async () => {
    const body = JSON.stringify({
      ok: false,
      error: "invalid_records",
      issues: [{ path: "records.0.fromAddress", message: "is not an email address" }],
      extra: "SECRET not printed",
    });
    const h = await sent(reply(body, 422));
    expect(h.code).toBe(1);
    expect(h.err).toEqual(["422 invalid_records", "records.0.fromAddress: is not an email address"]);
    expect(h.printed()).not.toContain("SECRET");
  });

  test("an issue that is not a plain path and a short sentence is left out", async () => {
    const body = JSON.stringify({
      ok: false,
      error: "invalid_records",
      issues: [
        { path: "records.0 \u001b[31mSECRET", message: "x" },
        { path: "records.1", message: "y".repeat(500) },
        { path: "records.2", message: "is \u001b[2Jfine" },
      ],
    });
    const h = await sent(reply(body, 422));
    expect(h.err).toEqual(["422 invalid_records", "records.2: is  [2Jfine"]);
  });

  test("a reply that is not JSON is never printed, escape sequences and all", async () => {
    const h = await sent(reply("<html>\u001b[2J SECRET sign-in page</html>", 200));
    expect(h.code).toBe(1);
    expect(h.err).toEqual([
      "200",
      "That is not an ingest confirmation, so the push is not confirmed.",
    ]);
    expect(h.printed()).not.toContain("SECRET");
  });

  test("a 204 is not a success", async () => {
    const h = await sent(reply(null, 204));
    expect(h.code).toBe(1);
    expect(h.err.at(-1)).toBe("That is not an ingest confirmation, so the push is not confirmed.");
  });

  test("a 200 that says ok: false is not a success", async () => {
    const h = await sent(reply('{"ok":false,"error":"source_turned_off"}', 200));
    expect(h.code).toBe(1);
    expect(h.err[0]).toBe("200 source_turned_off");
  });

  test("a 409 says why in the endpoint's code", async () => {
    const h = await sent(reply('{"ok":false,"error":"source_turned_off"}', 409));
    expect(h.code).toBe(1);
    expect(h.err).toEqual(["409 source_turned_off"]);
  });

  test("a redirect is reported, not followed", async () => {
    const h = await sent(async () =>
      new Response(null, { status: 302, headers: { Location: "https://elsewhere.example.test/" } }),
    );
    expect(h.code).toBe(1);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.err).toEqual([
      "The endpoint redirected the request. Nothing was followed and nothing was sent on.",
    ]);
  });

  test("a failure to connect names the error code, never the error's own message", async () => {
    const h = await sent(async () => {
      throw Object.assign(new TypeError(`fetch failed with Bearer ${TOKEN}`), {
        cause: { code: "ENOTFOUND" },
      });
    });
    expect(h.code).toBe(1);
    expect(h.err).toEqual(["The push could not reach the endpoint (ENOTFOUND)."]);
    expect(h.printed()).not.toContain(TOKEN);
  });

  test("a reply whose body cannot be read is a failure, said plainly", async () => {
    const h = await sent(async () => {
      const response = new Response("x", { status: 200 });
      vi.spyOn(response, "text").mockRejectedValue(new Error("SECRET stream error"));
      return response;
    });
    expect(h.code).toBe(1);
    expect(h.err).toEqual(["The endpoint's reply could not be read."]);
  });
});

describe("run: Apollo's shared lists", () => {
  // Made-up sequence and stage names; SECRET marks what must not be printed.
  const sequence = {
    sequenceId: "69b49cd9",
    name: "SECRET outreach",
    active: true,
    archived: false,
    steps: 7,
    createdAt: "2026-03-13",
    lastUsedAt: "2026-03-17",
    delivered: 24,
    opened: 1,
    replied: 0,
    bounced: 1,
    unsubscribed: 1,
    clicked: 0,
  };
  const SEQUENCES = { ...header("apollo"), kind: "sequence", records: [sequence] };
  const STAGES = {
    ...header("apollo"),
    kind: "stage_count",
    records: [
      { entity: "contact", stage: "SECRET stage", count: 735 },
      { entity: "contact", stage: "Approaching", count: 24 },
      { entity: "account", stage: "Cold", count: 546 },
    ],
  };
  const refused = async (file: unknown) => {
    const h = setup({ file });
    expect(await run([PATH, "--send"], envFor("apollo"), h.deps)).toBe(1);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.out).toEqual([]);
    expect(h.printed()).not.toContain("SECRET");
    return h.err;
  };

  test("sequences: the source, which list and a count; never a sequence's name", async () => {
    const h = setup({ file: SEQUENCES });
    expect(await run([PATH], {}, h.deps)).toBe(0);
    expect(h.out).toEqual(["Source: apollo", "Kind: records (sequence)", "Records: 1"]);
    expect(h.err).toEqual(["Nothing was sent. Add --send to push it."]);
    expect(h.printed()).not.toContain("SECRET");
  });

  test("stage counts: the same, and never a stage's name", async () => {
    const h = setup({ file: STAGES });
    expect(await run([PATH], {}, h.deps)).toBe(0);
    expect(h.out).toEqual(["Source: apollo", "Kind: records (stage_count)", "Records: 3"]);
    expect(h.printed()).not.toContain("SECRET");
  });

  test("Apollo's numbers still pass, the new ones among them", async () => {
    const week = (key: string, periodStart: string, value: number) => ({
      key,
      scope: "us",
      period: "week",
      periodStart,
      value,
    });
    const file = {
      ...header("apollo"),
      snapshots: [
        week("outbound_delivered", "2026-10-12", 24),
        week("apollo_contacts", "2026-10-12", 760),
        week("apollo_tasks_overdue", "2026-10-12", 23),
        week("apollo_contacts_added", "2026-10-05", 710),
        week("apollo_calls", "2026-10-05", 0),
      ],
    };
    const h = setup({ file });
    expect(await run([PATH], {}, h.deps)).toBe(0);
    expect(h.out).toEqual([
      "Source: apollo",
      "Kind: snapshots",
      "Snapshots: 5",
      "Metric keys: apollo_calls, apollo_contacts, apollo_contacts_added, apollo_tasks_overdue, outbound_delivered",
    ]);
    // A part-week count is refused here, before the endpoint has to.
    const partWeek = { ...file, snapshots: [week("apollo_calls", "2026-10-12", 0)] };
    expect(await refused(partWeek)).toEqual([
      "snapshots.0.periodStart: This week has not ended. Only finished weeks are stored.",
    ]);
  });

  test("a list with no kind, an unknown kind, or beside numbers is refused", async () => {
    const { kind: _kind, ...bare } = SEQUENCES;
    expect(await refused(bare)).toEqual([
      'kind: Say which list this is: "kind" is "sequence" or "stage_count".',
    ]);
    expect(await refused({ ...SEQUENCES, kind: "SECRET" })).toEqual([
      "kind: is not one of the allowed values",
    ]);
    expect(await refused({ ...SEQUENCES, snapshots: POSTHOG.snapshots })).toEqual([
      "snapshots: A records push carries nothing else.",
    ]);
  });

  test("a row with a person in it, a row of the other list, or a count that could not be true: refused by path", async () => {
    expect(
      await refused({ ...SEQUENCES, records: [{ ...sequence, contactName: "SECRET Person" }] }),
    ).toEqual(["records.0: has a field the OS does not accept"]);
    const otherList = await refused({ ...STAGES, kind: "sequence" });
    expect(otherList.length).toBeGreaterThan(0);
    // Every line is a row's path and fixed words, or the count of lines left out.
    expect(
      otherList.every((line) => /^(records\.\d+(\.[A-Za-z]+)?: |\d+ more issues not shown\.$)/.test(line)),
    ).toBe(true);
    expect(await refused({ ...SEQUENCES, records: [{ ...sequence, replied: 25 }] })).toEqual([
      "records.0.replied: is more than delivered",
    ]);
    expect(
      await refused({ ...STAGES, records: [...STAGES.records, { entity: "contact", stage: "approaching", count: 1 }] }),
    ).toEqual(["records.3.stage: repeats an earlier stage"]);
  });

  test("an empty list is refused, whatever it says about itself", async () => {
    expect(await refused({ ...SEQUENCES, records: [] })).toEqual([
      'records: An empty list is a failed read. Where nothing waiting is the real answer, send "empty": true with it.',
    ]);
    expect(await refused({ ...STAGES, records: [], empty: true })).toEqual([
      "empty: An empty push is never accepted from this source: nothing there is a failed read.",
    ]);
  });

  test("a work tool's file with a kind is refused: it has no shared list", async () => {
    const h = setup({ file: { ...GMAIL, kind: "sequence" } });
    expect(await run([PATH], {}, h.deps)).toBe(1);
    expect(h.err).toEqual(["kind: kind is for a shared list, and this source has none."]);
  });

  test("--send posts a list once, with Apollo's own token", async () => {
    const h = setup({ file: STAGES });
    const env = { ...envFor("apollo"), INGEST_TOKEN_GMAIL: OTHER_TOKEN };
    expect(await run([PATH, "--send"], env, h.deps)).toBe(0);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = h.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init).toMatchObject({ headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(JSON.parse(init.body as string)).toEqual(STAGES);
    expect(h.printed()).not.toContain("SECRET");
  });
});

// The examples in the owner's connector-run procedures are held to the same
// checks in connectorRuns.test.ts.

describe("docs/ingest.md: the examples for a connector run", () => {
  // The section a pushing session follows. Each example in it must be an
  // envelope this script, and so the endpoint, accepts as written.
  const section = readFileSync("docs/ingest.md", "utf8").split(
    "## Feeding the OS from Claude connectors",
  )[1]!;
  const examples = [...section.matchAll(/```json\n([\s\S]*?)```/g)]
    .map((match) => match[1]!)
    .filter((block) => block.includes('"snapshots"') || block.includes('"records"'));
  const sourceOf = (block: string) => (JSON.parse(block) as { source: string }).source;

  test("there is one for each of the seven sources and two for GitHub (its numbers and its pull requests); Globex's PostHog is read, not pushed", () => {
    // GitHub is fed by its own script (`pnpm gather:github`), which checks its
    // envelopes with this script's code; its examples are held to the same test.
    expect(examples.map(sourceOf).sort()).toEqual(
      ["apollo", "fireflies", "github", "github", "gmail", "google_calendar", "linear", "mercury", "posthog"].sort(),
    );
  });

  test.each(examples.map((block) => [sourceOf(block), block]))(
    "the %s example passes every check",
    async (_source, block) => {
      const h = setup({ file: block });
      // The moment the examples are written for: Monday 2026-10-12.
      h.deps.now = () => new Date("2026-10-12T06:05:00Z");
      expect(await run([PATH], {}, h.deps)).toBe(0);
      expect(h.err).toEqual(["Nothing was sent. Add --send to push it."]);
    },
  );
});

describe("run: contacts", () => {
  // Made-up people. SECRET, an address or a phone number must never be printed.
  const visible = {
    ...header("visible"),
    contacts: [
      { externalId: "vc-1", name: "SECRET Person", emails: ["secret.person@fund-example.test"], title: "Partner", linkedExternalId: "inv_1" },
      { externalId: "vc-2", name: "SECRET Other", emails: [] },
    ],
  };
  const refused = async (file: unknown, source: string) => {
    const h = setup({ file });
    expect(await run([PATH, "--send"], envFor(source), h.deps)).toBe(1);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.out).toEqual([]);
    expect(h.printed()).not.toContain("SECRET");
    expect(h.printed()).not.toContain("@");
    return h.err;
  };

  test("the source, the kind and a count; never a name or an address", async () => {
    const h = setup({ file: visible });
    expect(await run([PATH], {}, h.deps)).toBe(0);
    expect(h.out).toEqual(["Source: visible", "Kind: contacts", "Contacts: 2", "Mode: upsert"]);
    expect(h.printed()).not.toContain("SECRET");
    expect(h.printed()).not.toContain("@");
  });

  test("sends it with the source's own token", async () => {
    const h = setup({ file: visible });
    expect(await run([PATH, "--send"], envFor("visible"), h.deps)).toBe(0);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = h.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
  });

  test("says how many were left out or dropped, by count", async () => {
    const gmail = {
      ...header("gmail"),
      contacts: [
        { externalId: "g-1", name: "SECRET Person", emails: ["person@clinic-example.test"], interactionCount: 3 },
        { externalId: "g-2", name: "SECRET Robot", emails: ["no-reply@service.test"], interactionCount: 9 },
      ],
    };
    const h = setup({ file: gmail });
    expect(await run([PATH], {}, h.deps)).toBe(0);
    expect(h.out).toEqual([
      "Source: gmail",
      "Kind: contacts",
      "Contacts: 1",
      "Left out (no-reply, the companies' own, too few exchanges): 1",
      "Mode: upsert",
    ]);
    const crm = {
      ...header("kz_crm"),
      contacts: [
        { externalId: "k-1", name: "SECRET Staff", emails: [], phone: "+7 701 000 0000", linkedExternalId: "deal-1" },
        { externalId: "k-2", name: "SECRET Patient", title: "Пациент", emails: [] },
      ],
    };
    const c = setup({ file: crm });
    expect(await run([PATH], {}, c.deps)).toBe(0);
    expect(c.out).toEqual([
      "Source: kz_crm",
      "Kind: contacts",
      "Contacts: 1",
      "Dropped (looked like a patient's record): 1",
      "Mode: upsert",
    ]);
    expect(c.printed()).not.toContain("701");
  });

  test("a bad row is refused in paths and fixed words", async () => {
    const bad = { ...visible, contacts: [{ ...visible.contacts[0], phone: "+1 555 010 0199" }] };
    expect(await refused(bad, "visible")).toEqual(["contacts.0.phone: This token may not send a phone number."]);
  });

  test("a token that carries no contacts, replace, or a source that rides another's token is refused", async () => {
    const linear = { ...header("linear"), contacts: [{ externalId: "l-1", name: "SECRET Person", emails: [] }] };
    expect(await refused(linear, "linear")).toEqual(["contacts: This token does not carry contacts."]);
    expect(await refused({ ...visible, mode: "replace" }, "visible")).toEqual([
      'mode: Contacts are only ever upserted: leave "mode" out or send "upsert". A person missing from a push stays.',
    ]);
    const h = setup({ file: { ...visible, source: "visible_contacts" } });
    expect(await run([PATH], {}, h.deps)).toBe(1);
    expect(h.err).toEqual(["source: is not a source the OS takes pushes from."]);
  });
});
