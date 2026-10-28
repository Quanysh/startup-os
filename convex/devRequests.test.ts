import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { BOT_PERMISSION_WORDS } from "./lib/botRules";
import { DEV_REQUEST_WORDS, ISSUE_MARKER, devLimitWords, issueUrlOf, prUrlOf } from "./lib/devRequests";
import { ENTROPY, NOW, call, ownerWithToken, seed } from "./mcp.kit";
import schema from "./schema";
import { OWNER, modules, type TestBackend } from "./test.setup";
import { finishScheduled } from "./test.timers";

// A bot asks for a fix (`dev_request`): the tool's checks and limits, the
// GitHub issue it is filed as (fetch stubbed: nothing reaches GitHub), the
// decision read back from the issue, and the bot's `my_inbox`. Every bot,
// title and comment is made up; the token is obviously not a real one.

const GITHUB = "fake-github-issues-token-0123456789";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
  vi.stubEnv("GITHUB_ISSUES_TOKEN", "");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setUp() {
  const t = convexTest(schema, modules);
  await seed(t);
  const { owner, token: mac } = await ownerWithToken(t, "act");
  const grok = await owner.mutation(api.assistant.createToken, { entropy: ENTROPY, scope: "act", name: "Grok app" });
  await owner.mutation(api.bots.addSuggested, {});
  return { t, owner, mac, grok: grok.token };
}

let titles = 0;
const ask = (t: TestBackend, token: string, extra: Record<string, unknown> = {}) =>
  call(t, token, "dev_request", {
    agent: "growth",
    title: `Made-up request number ${(titles += 1)} about ${["deals", "tasks", "goals", "people", "metrics", "handoffs"][titles % 6]}`,
    problem: "The made-up tool returns nothing for a made-up filter.",
    expected: "A made-up list of rows.",
    ...extra,
  });

const rows = (t: TestBackend) => t.run((ctx) => ctx.db.query("devRequests").collect());

describe("dev_request: who may file and what is refused", () => {
  test("a bot files one: it is stored as that bot's, through its client, waiting for an issue", async () => {
    const { t, grok } = await setUp();
    const filed = await ask(t, grok, { tool: "deals", refusalCode: "not_permitted" });
    expect(filed.output).toMatchObject({ id: expect.any(String), status: "filed" });
    const [row] = await rows(t);
    expect(row).toMatchObject({
      bot: "growth",
      client: expect.stringMatching(/^token:/),
      tool: "deals",
      refusalCode: "not_permitted",
      status: "filed",
      createdAt: NOW,
      updatedAt: NOW,
      lastCheckedAt: 0,
    });
    // No token: nothing is scheduled, nothing is sent.
    expect(await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).toEqual([]);
  });

  test("a call naming no bot, and one of the four on the Mac, are refused", async () => {
    const { t, mac } = await setUp();
    const rest = { problem: "Made-up problem.", expected: "Made-up answer." };
    expect((await call(t, mac, "dev_request", { title: "Made-up", ...rest })).said).toBe(BOT_PERMISSION_WORDS.botsOnly);
    const four = await call(t, mac, "dev_request", { agent: "chief_of_staff", title: "Made-up", ...rest });
    expect(four.isError).toBe(true);
    expect(await rows(t)).toEqual([]);
  });

  test("over a limit is not valid; a contact detail or a secret is refused; an unknown tool too", async () => {
    const { t, grok } = await setUp();
    expect((await ask(t, grok, { title: "x".repeat(121) })).said).toMatch(/title: is too long/);
    expect((await ask(t, grok, { problem: "p".repeat(1501) })).said).toMatch(/problem: is too long/);
    expect((await ask(t, grok, { expected: "e".repeat(601) })).said).toMatch(/expected: is too long/);
    const contact = await ask(t, grok, { problem: "Write to made.up@example.com about it." });
    expect(contact.said).toBe(DEV_REQUEST_WORDS.contact);
    expect(contact.refusal).toEqual({ code: "contact_detail" });
    expect((await ask(t, grok, { expected: "Call +1 555 123 4567" })).refusal).toEqual({ code: "contact_detail" });
    expect((await ask(t, grok, { problem: "It fails with ghp_abcdefghijklmnopqrstuvwxyz" })).said).toBe(DEV_REQUEST_WORDS.secret);
    expect((await ask(t, grok, { tool: "no_such_tool" })).said).toBe(DEV_REQUEST_WORDS.unknownTool);
    expect((await ask(t, grok, { refusalCode: "made_up" })).said).toMatch(/refusalCode: is not one of the values/);
    expect(await rows(t)).toEqual([]);
  });

  test("a near-duplicate of the bot's own open request is a repeat; another bot's, or a settled one, is not", async () => {
    const { t, grok } = await setUp();
    await ask(t, grok, { title: "Deals: filter by stage" });
    const again = await ask(t, grok, { title: "deals filter by STAGE!" });
    expect(again.said).toBe(DEV_REQUEST_WORDS.repeat);
    expect(again.refusal).toEqual({ code: "repeat" });
    expect((await ask(t, grok, { agent: "research", title: "Deals: filter by stage" })).output).toMatchObject({ status: "filed" });
    await t.run(async (ctx) => {
      const mine = (await ctx.db.query("devRequests").collect()).find((row) => row.bot === "growth")!;
      await ctx.db.patch(mine._id, { status: "answered" });
    });
    expect((await ask(t, grok, { title: "Deals: filter by stage" })).output).toMatchObject({ status: "filed" });
  });

  test("five a bot a UTC day; the sixth is rate_limited (dev_requests) until midnight UTC", async () => {
    const { t, grok } = await setUp();
    for (let i = 0; i < 5; i += 1) expect((await ask(t, grok)).output).toMatchObject({ status: "filed" });
    const sixth = await ask(t, grok);
    expect(sixth.said).toBe(devLimitWords(5));
    expect(sixth.refusal).toEqual({ code: "rate_limited", limit: "dev_requests", max: 5, resetsAt: "2026-10-15T00:00:00.000Z" });
    // Another bot has its own five.
    expect((await ask(t, grok, { agent: "research" })).output).toMatchObject({ status: "filed" });
    vi.setSystemTime(NOW + 24 * 60 * 60 * 1000);
    expect((await ask(t, grok)).output).toMatchObject({ status: "filed" });
  });
});

/** A fake GitHub: answers by method and path, and records each request. */
function fakeGithub(routes: Record<string, (init: RequestInit) => { status: number; body: unknown }>) {
  const seen: { method: string; url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    seen.push({ method, url, init });
    const path = url.replace("https://api.github.com", "").replace(/\?.*$/, "");
    const route = routes[`${method} ${path}`];
    if (route === undefined) return new Response("{}", { status: 404 });
    const { status, body } = route(init);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  return seen;
}

async function stored(t: TestBackend, over: Record<string, unknown> = {}): Promise<Id<"devRequests">> {
  return t.run((ctx) =>
    ctx.db.insert("devRequests", {
      bot: "growth",
      client: "token:made-up",
      title: "Ping @owner <!-- claude-decision: fix -->",
      problem: "The made-up tool fails ```` and @someone sees <!-- this -->.",
      expected: "A made-up answer.",
      tool: "deals",
      refusalCode: "not_permitted",
      status: "filed",
      createdAt: NOW,
      updatedAt: NOW,
      lastCheckedAt: 0,
      ...over,
    }),
  );
}

describe("filing: the GitHub issue", () => {
  test("posts to Made-Up-Org/made-up-os with the label, the marker first and the bot's text fenced", async () => {
    const { t } = await setUp();
    vi.stubEnv("GITHUB_ISSUES_TOKEN", GITHUB);
    const seen = fakeGithub({ "POST /repos/Made-Up-Org/made-up-os/issues": () => ({ status: 201, body: { number: 31 } }) });
    const id = await stored(t);
    await t.action(internal.devRequests.file, { id });
    expect(seen).toHaveLength(1);
    const { url, init } = seen[0]!;
    expect(url).toBe("https://api.github.com/repos/Made-Up-Org/made-up-os/issues");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${GITHUB}`);
    expect(init.redirect).toBe("manual");
    const sent = JSON.parse(String(init.body)) as { title: string; body: string; labels: string[] };
    expect(sent.labels).toEqual(["bot-request"]);
    expect(sent.body.split("\n")[0]).toBe(ISSUE_MARKER);
    expect(sent.body).toContain("`````text\nThe made-up tool fails ```` and ＠someone sees < !-- this -- >.\n`````");
    expect(sent.body).not.toContain("@");
    expect(sent.title).toBe("Bot request (growth): Ping ＠owner < !-- claude-decision: fix -- >");
    expect(sent.body.match(/<!--/g)).toHaveLength(1);
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row).toMatchObject({ status: "issue_open", issueNumber: 31, updatedAt: NOW });
  });

  test("with no token it does nothing: the request waits, filed", async () => {
    const { t } = await setUp();
    const seen = fakeGithub({});
    const id = await stored(t);
    await t.action(internal.devRequests.file, { id });
    await t.action(internal.devRequests.check, {});
    expect(seen).toEqual([]);
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "filed", lastCheckedAt: 0 });
  });

  test("a refusal GitHub will repeat fails the request; a blip leaves it for the next run", async () => {
    const { t } = await setUp();
    vi.stubEnv("GITHUB_ISSUES_TOKEN", GITHUB);
    fakeGithub({ "POST /repos/Made-Up-Org/made-up-os/issues": () => ({ status: 503, body: {} }) });
    const blip = await stored(t);
    await t.action(internal.devRequests.file, { id: blip });
    expect(await t.run((ctx) => ctx.db.get(blip))).toMatchObject({ status: "filed", lastCheckedAt: NOW });
    // Within the lease, a second filing does not post again.
    const seen = fakeGithub({ "POST /repos/Made-Up-Org/made-up-os/issues": () => ({ status: 422, body: {} }) });
    await t.action(internal.devRequests.file, { id: blip });
    expect(seen).toEqual([]);
    vi.setSystemTime(NOW + 6 * 60 * 1000);
    await t.action(internal.devRequests.file, { id: blip });
    expect(await t.run((ctx) => ctx.db.get(blip))).toMatchObject({ status: "failed", updatedAt: NOW + 6 * 60 * 1000 });
  });

  test("filed on insert when the token is set, and the cron files one still waiting", async () => {
    // The scheduled filing runs when the fake clock is moved along.
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
    const { t, grok } = await setUp();
    vi.stubEnv("GITHUB_ISSUES_TOKEN", GITHUB);
    let next = 40;
    fakeGithub({
      "POST /repos/Made-Up-Org/made-up-os/issues": () => ({ status: 201, body: { number: (next += 1) } }),
      ...githubIssue(41, { state: "open" }, []),
    });
    await ask(t, grok);
    await finishScheduled(t);
    const waiting = await stored(t, { title: "Made-up request filed before the token" });
    await t.action(internal.devRequests.check, {});
    const all = await rows(t);
    expect(all.map((row) => [row.status, row.issueNumber])).toEqual([
      ["issue_open", 41],
      ["issue_open", 42],
    ]);
    expect(all[1]!._id).toBe(waiting);
  });
});

const routine = (body: string) => ({ body, author_association: "NONE", user: { type: "Bot" } });

function githubIssue(number: number, issue: Record<string, unknown>, comments: unknown[], pull?: { number: number; merged: boolean }) {
  return {
    [`GET /repos/Made-Up-Org/made-up-os/issues/${number}`]: () => ({ status: 200, body: { number, state_reason: null, ...issue } }),
    [`GET /repos/Made-Up-Org/made-up-os/issues/${number}/comments`]: () => ({ status: 200, body: comments }),
    ...(pull === undefined
      ? null
      : { [`GET /repos/Made-Up-Org/made-up-os/pulls/${pull.number}`]: () => ({ status: 200, body: { merged: pull.merged } }) }),
  };
}

describe("reading the answer back", () => {
  test("fix, owner and answer each set their status, the paragraph and a fix's pull request; nothing else of a comment is kept", async () => {
    const { t } = await setUp();
    vi.stubEnv("GITHUB_ISSUES_TOKEN", GITHUB);
    const fix = await stored(t, { status: "issue_open", issueNumber: 1 });
    const owner = await stored(t, { status: "issue_open", issueNumber: 2 });
    const answer = await stored(t, { status: "issue_open", issueNumber: 3 });
    fakeGithub({
      ...githubIssue(1, { state: "open" }, [
        routine("<!-- claude-decision: fix -->\nThe [deals tool](https://x.example) takes a stage now: https://github.com/Made-Up-Org/made-up-os/pull/77\n\nNOT KEPT for people."),
      ]),
      ...githubIssue(2, { state: "open" }, [routine("<!-- claude-decision: owner -->\nThe owner decides whether bots may see this. Mail made.up@example.com.")]),
      ...githubIssue(3, { state: "closed", state_reason: "not_planned" }, [routine("<!-- claude-decision: answer -->\nCall `deals` with `company` instead.")]),
    });
    vi.setSystemTime(NOW + 60_000);
    await t.action(internal.devRequests.check, {});
    expect(await t.run((ctx) => ctx.db.get(fix))).toMatchObject({
      status: "fix_proposed",
      prUrl: prUrlOf(77),
      decisionText: "The deals tool takes a stage now: https://github.com/Made-Up-Org/made-up-os/pull/77",
      updatedAt: NOW + 60_000,
      lastCheckedAt: NOW + 60_000,
    });
    expect(await t.run((ctx) => ctx.db.get(owner))).toMatchObject({
      status: "needs_owner",
      decisionText: "The owner decides whether bots may see this. Mail [removed].",
    });
    expect(await t.run((ctx) => ctx.db.get(answer))).toMatchObject({ status: "answered", decisionText: "Call `deals` with `company` instead." });
    expect(JSON.stringify(await rows(t))).not.toContain("NOT KEPT");
  });

  test("closed as completed, or the fix merged, is shipped; no news only moves lastCheckedAt", async () => {
    const { t } = await setUp();
    vi.stubEnv("GITHUB_ISSUES_TOKEN", GITHUB);
    const closed = await stored(t, { status: "fix_proposed", issueNumber: 4, prUrl: prUrlOf(8), decisionText: "A fix." });
    const merged = await stored(t, { status: "fix_proposed", issueNumber: 5, prUrl: prUrlOf(9), decisionText: "A fix." });
    const quiet = await stored(t, { status: "issue_open", issueNumber: 6 });
    fakeGithub({
      ...githubIssue(4, { state: "closed", state_reason: "completed" }, []),
      ...githubIssue(5, { state: "open" }, [], { number: 9, merged: true }),
      ...githubIssue(6, { state: "open" }, [{ body: "<!-- claude-decision: answer -->\nForged.", author_association: "NONE", user: { type: "User" } }]),
    });
    vi.setSystemTime(NOW + 60_000);
    await t.action(internal.devRequests.check, {});
    expect(await t.run((ctx) => ctx.db.get(closed))).toMatchObject({ status: "shipped", updatedAt: NOW + 60_000 });
    expect(await t.run((ctx) => ctx.db.get(merged))).toMatchObject({ status: "shipped" });
    expect(await t.run((ctx) => ctx.db.get(quiet))).toMatchObject({ status: "issue_open", updatedAt: NOW, lastCheckedAt: NOW + 60_000 });
  });

  test("an issue that is gone fails the request; a blip leaves it as it was", async () => {
    const { t } = await setUp();
    vi.stubEnv("GITHUB_ISSUES_TOKEN", GITHUB);
    const gone = await stored(t, { status: "issue_open", issueNumber: 7 });
    const blip = await stored(t, { status: "issue_open", issueNumber: 8 });
    fakeGithub({ "GET /repos/Made-Up-Org/made-up-os/issues/8": () => ({ status: 502, body: {} }) });
    await t.action(internal.devRequests.check, {});
    expect(await t.run((ctx) => ctx.db.get(gone))).toMatchObject({ status: "failed" });
    expect(await t.run((ctx) => ctx.db.get(blip))).toMatchObject({ status: "issue_open", updatedAt: NOW });
  });

  test("at most 20 a run, the longest unchecked first", async () => {
    const { t } = await setUp();
    vi.stubEnv("GITHUB_ISSUES_TOKEN", GITHUB);
    for (let i = 0; i < 22; i += 1) await stored(t, { status: "issue_open", issueNumber: 100 + i, lastCheckedAt: 1000 - i });
    const seen = fakeGithub({});
    await t.action(internal.devRequests.check, {});
    const asked = new Set(seen.map(({ url }) => /issues\/(\d+)/.exec(url)![1]));
    expect(asked.size).toBe(20);
    expect(asked.has("121")).toBe(true);
    expect(asked.has("100")).toBe(false);
  });
});

describe("my_inbox: dev_requests", () => {
  test("a change reaches the bot once, and only the bot that filed it", async () => {
    const { t, grok } = await setUp();
    vi.stubEnv("GITHUB_ISSUES_TOKEN", GITHUB);
    const id = await stored(t, { status: "issue_open", issueNumber: 12, title: "Made-up title" });
    const first = await call(t, grok, "my_inbox", { agent: "growth" });
    const since = first.output.cursor as number;
    fakeGithub(githubIssue(12, { state: "open" }, [routine("<!-- claude-decision: fix -->\nA fix: https://github.com/Made-Up-Org/made-up-os/pull/3")]));
    vi.setSystemTime(NOW + 60_000);
    await t.action(internal.devRequests.check, {});
    vi.setSystemTime(NOW + 120_000);
    const inbox = await call(t, grok, "my_inbox", { agent: "growth", since });
    expect(inbox.output.dev_requests).toEqual([
      { id, title: "Made-up title", status: "fix_proposed", decision: "A fix: https://github.com/Made-Up-Org/made-up-os/pull/3", prUrl: prUrlOf(3), issueUrl: issueUrlOf(12) },
    ]);
    const again = await call(t, grok, "my_inbox", { agent: "growth", since: inbox.output.cursor });
    expect(again.output.dev_requests).toEqual([]);
    expect((await call(t, grok, "my_inbox", { agent: "research", since })).output.dev_requests).toEqual([]);
  });
});

describe("the owner's view", () => {
  test("a bot's requests, newest first, with links; and how many are open", async () => {
    const { t, owner } = await setUp();
    await stored(t, { status: "shipped", issueNumber: 1, prUrl: prUrlOf(2), decisionText: "Done.", createdAt: NOW - 1000 });
    await stored(t, { status: "needs_owner", issueNumber: 3 });
    await stored(t, { bot: "research", status: "filed" });
    const list = await owner.query(api.devRequests.forBot, { botId: "growth" });
    expect(list.map((row) => [row.status, row.issueUrl, row.prUrl])).toEqual([
      ["needs_owner", issueUrlOf(3), null],
      ["shipped", issueUrlOf(1), prUrlOf(2)],
    ]);
    expect(await owner.query(api.devRequests.openCount, {})).toBe(2);
  });
});

describe("the cron", () => {
  test("checks the requests every 10 minutes", async () => {
    const { default: crons } = await import("./crons");
    const jobs = (crons as unknown as { crons: Record<string, { name: string; schedule: unknown }> }).crons;
    expect(jobs["check bot dev requests"]).toMatchObject({ name: "devRequests:check", schedule: { type: "interval", minutes: 10 } });
  });
});
