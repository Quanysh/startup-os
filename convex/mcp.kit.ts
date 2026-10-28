// What the agent endpoint's tests share: a token, a JSON-RPC call, and a
// made-up company to read. Two dots in the name, so Convex does not bundle it.
//
// Every name, address, title and figure is made up. What no tool may ever
// return carries the word NEVER.

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { AgentScope } from "./lib/agentRules";
import { addMember, signInAs, signInAsOwner, type TestBackend } from "./test.setup";

/** A Wednesday. The week in progress began on Monday 2026-10-12. */
export const NOW = Date.UTC(2026, 9, 14, 6);
export const DAY = 24 * 60 * 60 * 1000;
export const TODAY = "2026-10-14";
// Obviously not real secrets.
export const ENTROPY = "fake-browser-entropy-0123456789-abcdefghijklmn";
export const GITHUB_TOKEN = "fake-github-push-token-0123456789-abcdefgh";
export const STANDUP_TOKEN = "fake-standup-push-token-0123456789-abcdefg";
export const BOT_TOKEN = "123456789:fake-bot-token-0123456789-abcdefghij";
export const SAM = "sam.teammate@gmail.com";

type Owner = Awaited<ReturnType<typeof signInAsOwner>>;

/** What the Mac's own client is called in these tests: the token that may also run the chat and the agents. */
export const MAC_CLIENT = "Claude Code on the Mac";

/**
 * The signed-in owner and a token of theirs with this scope. One that may act
 * is the Mac's (`runner`), as the one token of before was: the chat's and the
 * agents' runner tools are its alone.
 */
export async function ownerWithToken(t: TestBackend, scope: AgentScope = "act") {
  const owner = await signInAsOwner(t);
  const { token } = await owner.mutation(api.assistant.createToken, {
    entropy: ENTROPY,
    scope,
    name: MAC_CLIENT,
    runner: scope === "act",
    // A plain client, as every token was before "Only bots may use this client" (botsOnly.test.ts).
    botsOnly: false,
  });
  return { owner, token };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** POST /mcp/v1 with a body as given (a string is sent as it is). */
export const post = (
  t: TestBackend,
  token: string | null,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  t.fetch("/mcp/v1", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token === null ? {} : bearer(token)),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

export type RpcReply = {
  status: number;
  text: string;
  body: {
    jsonrpc?: string;
    id?: unknown;
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };
};

async function read(response: Response): Promise<RpcReply> {
  const text = await response.text();
  return { status: response.status, text, body: text === "" ? {} : JSON.parse(text) };
}

/** One JSON-RPC request, id 1. */
export async function rpc(
  t: TestBackend,
  token: string | null,
  method: string,
  params?: unknown,
  headers?: Record<string, string>,
): Promise<RpcReply> {
  return read(await post(t, token, { jsonrpc: "2.0", id: 1, method, params }, headers));
}

export const raw = async (t: TestBackend, token: string | null, body: unknown, headers?: Record<string, string>) =>
  read(await post(t, token, body, headers));

type ToolAnswer = {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError: boolean;
};

/**
 * One `tools/call`. `output` is the tool's answer (its structured content),
 * `said` the text of a tool error, `error` a JSON-RPC error.
 */
export async function call(
  t: TestBackend,
  token: string,
  name: string,
  args: unknown = {},
  headers?: Record<string, string>,
) {
  const reply = await rpc(t, token, "tools/call", { name, arguments: args }, headers);
  const result = reply.body.result as ToolAnswer | undefined;
  return {
    ...reply,
    error: reply.body.error ?? null,
    isError: result?.isError ?? null,
    said: result?.isError ? result.content[0]!.text : null,
    /** A refusal's code and details (a bot's), beside its words: null when there is none. */
    refusal: (result?.isError ? (result.structuredContent ?? null) : null) as Record<string, unknown> | null,
    // Tests reach into answers by key; what each holds is asserted there.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    output: (result?.isError === false ? result.structuredContent! : null) as any,
    textOutput: result?.isError === false ? result.content[0]!.text : null,
  };
}

/** A tool's answer, or a failed test that says what came back instead. */
export async function answer(t: TestBackend, token: string, name: string, args: unknown = {}) {
  const reply = await call(t, token, name, args);
  if (reply.output === null) throw new Error(`${name} did not answer: ${reply.text}`);
  return reply.output as Record<string, unknown> & { truncated: boolean };
}

export const calls = (t: TestBackend) =>
  t.run(async (ctx) =>
    (await ctx.db.query("agentCalls").collect()).map(({ tool, kind, outcome }) => ({
      tool,
      kind,
      outcome,
    })),
  );

export const NEVER = {
  payroll: "NEVER PAYROLL PERSON",
  gross: 987_654_321,
  ownerMail: "NEVER OWNER MAIL",
  ownerMeeting: "NEVER OWNER MEETING",
  teammateMail: "NEVER TEAMMATE MAIL",
  telegram: "never_telegram_name",
  runMessage: "NEVER RUN MESSAGE naming MERCURY_API_TOKEN",
  told: "NEVER told task",
} as const;

/** A teammate on Startup, signed in once (so they can be told things), with the board. */
export async function addSam(t: TestBackend) {
  await addMember(t, { email: SAM, role: "engineer", companies: ["us"] });
  const sam = await signInAs(t, { email: SAM, emailVerificationTime: 1 });
  const userId = await t.run(async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", SAM))
      .first();
    await ctx.db.patch(user!._id, { name: "Sam Teammate" });
    return user!._id;
  });
  return { sam, userId };
}

const header = () => ({
  version: 1,
  source: "github",
  batchId: "github-batch",
  observedAt: "2026-10-14T06:00:00Z",
});

/** GitHub's two lists, sent the way they arrive: through POST /ingest/v1. Needs INGEST_TOKEN_GITHUB. */
export async function pushGithub(t: TestBackend) {
  const send = async (body: unknown) => {
    const response = await t.fetch("/ingest/v1", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer(GITHUB_TOKEN) },
      body: JSON.stringify(body),
    });
    if (response.status !== 200) throw new Error(`the GitHub fixture was refused: ${await response.text()}`);
  };
  const repo = (name: string, company: "us" | "kz") => ({
    repoId: `Made-Up-Org/${name}`,
    org: "Made-Up-Org",
    name,
    company,
    mergedLastWeek: 4,
    open: 3,
    stuck: 1,
    main: company === "kz" ? "failing" : "passing",
    pushedAt: "2026-10-13",
  });
  const pull = (number: number, company: "us" | "kz") => {
    const name = company === "us" ? "startup-app" : "globex-app";
    return {
      repoId: `Made-Up-Org/${name}`,
      number,
      company,
      title: `Made-up ${company} pull request ${number}`,
      url: `https://github.com/Made-Up-Org/${name}/pull/${number}`,
      authorLogin: `made-up-${company}-ada`,
      authorName: `Made-up ${company} Ada`,
      draft: false,
      state: "open",
      createdAt: "2026-10-10T08:00:00Z",
      updatedAt: "2026-10-13T09:00:00Z",
      reviewDecision: "review_required",
      reviewersRequested: 1,
      reviewers: [`made-up-${company}-ben`],
      checks: "passing",
    };
  };
  await send({ ...header(), kind: "repo", records: [repo("startup-app", "us"), repo("globex-app", "kz")] });
  await send({ ...header(), kind: "pull_request", records: [pull(7, "us"), pull(3, "kz")] });
}

/**
 * A made-up company with something on every page, and beside it what no
 * tool may return: payroll, the owner's own mail and meeting notes, a
 * teammate's own mail, a Telegram username, a run's stored message.
 */
export async function seed(t: TestBackend) {
  return await t.run(async (ctx) => {
    const snap = (
      key: string,
      scope: string,
      period: "week" | "month",
      periodStart: string,
      value: number,
      source: string,
    ) => ctx.db.insert("metricSnapshots", { key, scope, period, periodStart, value, source, syncedAt: NOW - DAY });
    await snap("mrr", "us", "month", "2026-08-01", 5_000, "manual");
    await snap("mrr", "us", "month", "2026-09-01", 6_000, "manual");
    await snap("mrr", "kz", "month", "2026-09-01", 4_400_000, "cfo_workbook");
    await snap("fx_usd_kzt", "company", "month", "2026-09-01", 440, "cfo_workbook");
    await snap("prs_stuck", "us", "week", "2026-10-05", 2, "github");
    await snap("repos_failing", "kz", "week", "2026-10-05", 1, "github");

    await ctx.db.insert("sourceStatus", {
      source: "mercury",
      state: "error",
      message: NEVER.runMessage,
      lastRunAt: NOW - DAY,
      lastOkAt: NOW - 3 * DAY,
    });
    await ctx.db.insert("sourceStatus", { source: "cfo_workbook", state: "ok", lastRunAt: NOW - DAY, lastOkAt: NOW - DAY });
    await ctx.db.insert("sourceStatus", { source: "gmail", state: "ok", lastRunAt: NOW, lastOkAt: NOW });

    const deal = (market: "us" | "kz", source: string, name: string) =>
      ctx.db.insert("deals", {
        source,
        externalId: `deal-${market}`,
        market,
        name,
        stage: "qualified",
        order: 0,
        amount: 1_000,
        // Quiet for a month: on the attention list.
        lastActivityAt: NOW - 30 * DAY,
      });
    const usDeal = await deal("us", "manual", "Example US Deal");
    const kzDeal = await deal("kz", "kz_crm", "Example KZ Deal");

    const investor = await ctx.db.insert("investors", {
      source: "manual",
      externalId: "inv-1",
      name: "Example Fund",
      stage: "meeting",
      order: 0,
      lastActivityAt: NOW - 30 * DAY,
    });

    const clinic = (market: "us" | "kz") =>
      ctx.db.insert("customers", {
        source: "client_register",
        nameKey: `example ${market} clinic`,
        name: `Example ${market} Clinic`,
        market,
        status: "active",
        currency: market === "us" ? "USD" : "KZT",
        syncedAt: NOW - DAY,
      });
    await clinic("us");
    await clinic("kz");
    await ctx.db.insert("sourceStatus", { source: "client_register", state: "ok", lastRunAt: NOW - DAY, lastOkAt: NOW - DAY });

    const obligation = (category: "hipaa" | "kz_data" | "corporate_tax", due: string) =>
      ctx.db.insert("obligations", {
        category,
        title: `Example ${category} item`,
        due,
        dueConfirmed: true,
        recurrence: "none",
        status: "open",
      });
    await obligation("hipaa", "2026-10-01"); // overdue, Startup's
    await obligation("kz_data", "2026-10-20"); // due soon, Globex's
    await obligation("corporate_tax", "2027-03-01");

    const task = (title: string, company?: "us" | "kz") =>
      ctx.db.insert("tasks", { title, kind: "task", column: "backlog", order: 0, company });
    const sharedTask = await task("Example shared task");
    const usTask = await task("Example us task", "us");
    const kzTask = await task("Example kz task", "kz");

    await ctx.db.insert("goals", { quarter: "2026-Q4", title: "Example goal", status: "on_track", order: 0 });

    // ── What no tool may return ──
    const payPerson = await ctx.db.insert("payrollPeople", {
      company: "kz",
      name: NEVER.payroll,
      kind: "employee",
      monthlyGross: NEVER.gross,
      currency: "KZT",
      notes: `${NEVER.payroll} note`,
      order: 0,
    });
    await ctx.db.insert("payrollRuns", {
      company: "kz",
      month: "2026-09-01",
      status: "draft",
      preparedAt: 1,
      rows: [
        {
          personId: payPerson,
          name: NEVER.payroll,
          kind: "employee",
          currency: "KZT",
          gross: NEVER.gross,
          lines: [],
          net: NEVER.gross,
          cost: NEVER.gross,
        },
      ],
    });
    // The owner's own mail and meeting notes (no `owner`), and a teammate's own mail.
    await ctx.db.insert("mirrorRecords", {
      source: "gmail",
      externalId: "thread-1",
      sortAt: NOW,
      syncedAt: NOW,
      record: {
        kind: "mail",
        threadId: "thread-1",
        fromName: NEVER.ownerMail,
        fromAddress: "never@example.test",
        subject: NEVER.ownerMail,
        lastMessageAt: NOW,
      },
    });
    await ctx.db.insert("mirrorRecords", {
      source: "fireflies",
      externalId: "meeting-1",
      sortAt: NOW,
      syncedAt: NOW,
      record: {
        kind: "meeting",
        meetingId: "meeting-1",
        title: NEVER.ownerMeeting,
        heldAt: NOW,
        durationMinutes: 30,
        participants: [],
        overview: NEVER.ownerMeeting,
        actionItems: [],
      },
    });
    const teammate = await ctx.db.insert("users", {});
    await ctx.db.insert("mirrorRecords", {
      owner: "ada.teammate@gmail.com",
      userId: teammate,
      source: "gmail",
      externalId: "thread-2",
      sortAt: NOW,
      syncedAt: NOW,
      record: {
        kind: "mail",
        threadId: "thread-2",
        fromName: NEVER.teammateMail,
        fromAddress: "never2@example.test",
        subject: NEVER.teammateMail,
        lastMessageAt: NOW,
      },
    });
    await ctx.db.insert("members", {
      email: "tg.teammate@gmail.com",
      role: "engineer",
      companies: ["us"],
      telegram: NEVER.telegram,
      addedAt: 1,
      addedBy: teammate,
    });
    // Somebody's notification about a task that is gone.
    const gone = await task(NEVER.told, "us");
    await ctx.db.delete(gone);
    await ctx.db.insert("notifications", {
      recipient: teammate,
      kind: "assigned",
      actor: { type: "system", source: "standup" },
      taskId: gone,
      company: "us",
      title: NEVER.told,
      createdAt: 1,
    });

    return { usDeal, kzDeal, investor, sharedTask, usTask, kzTask } satisfies Record<
      string,
      Id<"deals"> | Id<"investors"> | Id<"tasks">
    >;
  });
}

export type Seeded = Awaited<ReturnType<typeof seed>>;
export type { Owner };
