import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { HOURLY_LIMIT, NOT_A_USERNAME, TELEGRAM_FAILURES, TEST_MESSAGE } from "./lib/telegramMessage";
import schema from "./schema";
import { NO_TOKEN, PICK_FROM_LIST, announceAssignment } from "./telegram";
import {
  OWNER,
  memberEmail,
  modules,
  signInAsCofounder,
  signInAsEngineer,
  signInAsOwner,
  signInAsSales,
  type TestBackend,
} from "./test.setup";
import { finishScheduled } from "./test.timers";

// The Telegram bot: a message in a company's group when a task is given to
// someone. `fetch` is a stub throughout; nothing here reaches Telegram.

// Obviously not a real token; the word is what the tests look for.
const TOKEN = "123456789:SENTINEL_fake_token_for_tests_only_000";
const SITE = "https://os.example.test";
const NOW = Date.UTC(2026, 9, 13, 9, 0, 0);
const HOUR = 60 * 60 * 1000;
const US = { id: "-1001", title: "Startup team" };
const KZ = { id: "-1002", title: "Globex team" };

const COFOUNDER = memberEmail("cofounder");
const US_SALES = memberEmail("sales", ["us"]);
const KZ_ENGINEER = memberEmail("engineer", ["kz"]);

type Call = { url: string; body: Record<string, unknown>; init: RequestInit };
type Answer = Response | Error | (() => Promise<Response>);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const sent = () => json({ ok: true, result: { message_id: 1 } });

/** Replace fetch with answers used in order (the last repeats); returns what was asked. */
function stubFetch(...answers: Answer[]): Call[] {
  const calls: Call[] = [];
  const list = answers.length > 0 ? answers : [sent()];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        init: init ?? {},
      });
      const answer = list[Math.min(calls.length, list.length) - 1]!;
      if (answer instanceof Error) throw answer;
      if (typeof answer === "function") return answer();
      return answer.clone();
    }),
  );
  return calls;
}

let logged: unknown[][];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
  vi.stubEnv("TELEGRAM_BOT_TOKEN", TOKEN);
  vi.stubEnv("SITE_URL", SITE);
  logged = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : arg)));
    });
  }
});
afterEach(() => {
  // Whatever a test did, the token reached no log line.
  expect(JSON.stringify(logged)).not.toContain("SENTINEL");
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type Client = Awaited<ReturnType<typeof signInAsOwner>>;
const settingsRow = (t: TestBackend) => t.run((ctx) => ctx.db.query("telegramSettings").first());
const tasks = (t: TestBackend) => t.run((ctx) => ctx.db.query("tasks").collect());
const scheduled = (t: TestBackend) =>
  t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
/** Every row of every table the feature writes or reads, as one string. */
const everythingStored = async (t: TestBackend) =>
  JSON.stringify(
    await t.run(async (ctx) => ({
      settings: await ctx.db.query("telegramSettings").collect(),
      sends: await ctx.db.query("telegramSends").collect(),
      tasks: await ctx.db.query("tasks").collect(),
      members: await ctx.db.query("members").collect(),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
      runs: await ctx.db.query("syncRuns").collect(),
      status: await ctx.db.query("sourceStatus").collect(),
    })),
  );

/** A team, both groups picked and the feature on. */
async function start(settings: Record<string, unknown> = {}) {
  const t = convexTest(schema, modules);
  const owner = await signInAsOwner(t);
  const cofounder = await signInAsCofounder(t);
  const usSales = await signInAsSales(t, ["us"]);
  const kzEngineer = await signInAsEngineer(t, ["kz"]);
  await t.run(async (ctx) => {
    await ctx.db.insert("telegramSettings", { enabled: true, chatUs: US, chatKz: KZ, ...settings });
    for (const [email, name] of [
      [OWNER, "Olga Owner"],
      [COFOUNDER, "Cora Founder"],
      [US_SALES, "Sam Sales"],
      [KZ_ENGINEER, "Erik Engineer"],
    ] as const) {
      const user = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", email))
        .first();
      await ctx.db.patch(user!._id, { name });
    }
  });
  return { t, owner, cofounder, usSales, kzEngineer };
}

const setTelegram = (t: TestBackend, email: string, telegram: string) =>
  t.run(async (ctx) => {
    const row = await ctx.db
      .query("members")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    await ctx.db.patch(row!._id, { telegram });
  });

const text = (call: Call | undefined) => String(call?.body.text);
const LINK = `<a href="${SITE}/board">Open the board</a>`;

// ── When a message is sent ──────────────────────────────────────────────────

describe("when a message is sent", () => {
  test("a task created already assigned", async () => {
    const { t, owner } = await start();
    const calls = stubFetch();
    await owner.mutation(api.tasks.create, { title: "Call back", assignee: COFOUNDER });
    await finishScheduled(t);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(calls[0]!.init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(calls[0]!.body).toEqual({
      chat_id: US.id,
      text: `<b>New task</b> for Cora Founder\nCall back\nBoth · from Olga Owner · ${LINK}`,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  });

  test("an unassigned task that is assigned", async () => {
    const { t, owner } = await start();
    const calls = stubFetch();
    const id = await owner.mutation(api.tasks.create, { title: "Call back" });
    await finishScheduled(t);
    expect(calls).toHaveLength(0);
    await owner.mutation(api.tasks.update, { id, assignee: COFOUNDER });
    await finishScheduled(t);
    expect(calls.map(text)).toEqual([
      `<b>New task</b> for Cora Founder\nCall back\nBoth · from Olga Owner · ${LINK}`,
    ]);
  });

  test("a task reassigned to someone else: one message, for the new person", async () => {
    const { t, owner } = await start();
    const calls = stubFetch();
    const id = await owner.mutation(api.tasks.create, { title: "Call back", assignee: COFOUNDER });
    await finishScheduled(t);
    await owner.mutation(api.tasks.update, { id, assignee: US_SALES });
    await finishScheduled(t);
    expect(calls).toHaveLength(2);
    expect(text(calls[1]).split("\n")[0]).toBe("<b>New task</b> for Sam Sales");
  });

  test("not when it is unassigned", async () => {
    const { t, owner } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Call back", assignee: COFOUNDER });
    await finishScheduled(t);
    const calls = stubFetch();
    await owner.mutation(api.tasks.update, { id, assignee: null });
    // Only the creation's message was ever scheduled: unassigning starts nothing.
    expect(await scheduled(t)).toHaveLength(1);
    await finishScheduled(t);
    expect(calls).toHaveLength(0);
  });

  test("not when other fields change, the same assignee sent again or not", async () => {
    const { t, owner } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Call back", assignee: COFOUNDER });
    await finishScheduled(t);
    const calls = stubFetch();
    await owner.mutation(api.tasks.update, { id, title: "Call back today" });
    await owner.mutation(api.tasks.update, { id, notes: "A note", due: "2026-10-20", kind: "issue" });
    await owner.mutation(api.tasks.update, { id, company: "us" });
    // The editor sends every field on save, the assignee included.
    await owner.mutation(api.tasks.update, { id, title: "Again", assignee: COFOUNDER });
    await owner.mutation(api.tasks.update, { id, assignee: ` ${COFOUNDER.toUpperCase()} ` });
    await finishScheduled(t);
    expect(calls).toHaveLength(0);
    expect((await scheduled(t)).filter((job) => job.state.kind === "pending")).toEqual([]);
  });

  test("not on a move, by the board or by the editor", async () => {
    const { t, owner } = await start();
    const id = await owner.mutation(api.tasks.create, { title: "Call back", assignee: COFOUNDER });
    await finishScheduled(t);
    const calls = stubFetch();
    await owner.mutation(api.tasks.move, { id, column: "doing", index: 0 });
    await owner.mutation(api.tasks.update, { id, column: "done" });
    await finishScheduled(t);
    expect(calls).toHaveLength(0);
  });

  test("not when someone gives a task to themselves, new or existing", async () => {
    const { t, owner, cofounder } = await start();
    const calls = stubFetch();
    await owner.mutation(api.tasks.create, { title: "Mine", assignee: OWNER });
    await cofounder.mutation(api.tasks.create, { title: "Mine too", assignee: COFOUNDER.toUpperCase() });
    const id = await cofounder.mutation(api.tasks.create, { title: "Later mine" });
    await cofounder.mutation(api.tasks.update, { id, assignee: COFOUNDER });
    await finishScheduled(t);
    expect(calls).toHaveLength(0);
    expect(await scheduled(t)).toEqual([]);
  });

  test("a teammate assigning to the owner is a message like any other", async () => {
    const { t, cofounder } = await start();
    const calls = stubFetch();
    await cofounder.mutation(api.tasks.create, { title: "For you", assignee: OWNER });
    await finishScheduled(t);
    expect(text(calls[0])).toBe(
      `<b>New task</b> for Olga Owner\nFor you\nBoth · from Cora Founder · ${LINK}`,
    );
  });

  test("the mutation schedules ids and nothing else: no title, name or address", async () => {
    const { t, owner } = await start();
    stubFetch();
    const id = await owner.mutation(api.tasks.create, { title: "SECRET title", assignee: COFOUNDER });
    const [job] = await scheduled(t);
    expect(job!.name).toBe("telegram:notify");
    const [args] = job!.args as [Record<string, unknown>];
    expect(Object.keys(args).sort()).toEqual(["actorId", "taskId"]);
    expect(args.taskId).toBe(id);
    expect(JSON.stringify(job!.args)).not.toMatch(/SECRET|@|Cora|Olga/);
    await finishScheduled(t);
  });
});

// ── The state at send time ──────────────────────────────────────────────────

describe("the action reads the task again when it sends", () => {
  test("a title changed meanwhile is sent as it now is", async () => {
    const { t, owner } = await start();
    const calls = stubFetch();
    const id = await owner.mutation(api.tasks.create, { title: "Old title", assignee: COFOUNDER });
    await owner.mutation(api.tasks.update, { id, title: "New title", company: "kz", due: "2026-10-20" });
    await finishScheduled(t);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.chat_id).toBe(KZ.id);
    expect(text(calls[0])).toBe(
      `<b>New task</b> for Cora Founder\nNew title\nGlobex · due 20 Oct 2026 · from Olga Owner · ${LINK}`,
    );
  });

  test("a task deleted meanwhile sends nothing", async () => {
    const { t, owner } = await start();
    const calls = stubFetch();
    const id = await owner.mutation(api.tasks.create, { title: "Gone", assignee: COFOUNDER });
    await owner.mutation(api.tasks.remove, { id });
    await finishScheduled(t);
    expect(calls).toHaveLength(0);
  });

  test("a task unassigned meanwhile sends nothing", async () => {
    const { t, owner } = await start();
    const calls = stubFetch();
    const id = await owner.mutation(api.tasks.create, { title: "Dropped", assignee: COFOUNDER });
    await owner.mutation(api.tasks.update, { id, assignee: null });
    await finishScheduled(t);
    expect(calls).toHaveLength(0);
  });

  test("a task reassigned meanwhile never names the person it was first given to", async () => {
    const { t, owner } = await start();
    const calls = stubFetch();
    const id = await owner.mutation(api.tasks.create, { title: "Passed on", assignee: COFOUNDER });
    await owner.mutation(api.tasks.update, { id, assignee: US_SALES });
    await finishScheduled(t);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(text(call).split("\n")[0]).toBe("<b>New task</b> for Sam Sales");
      expect(text(call)).not.toContain("Cora");
    }
  });

  test("a task that has since become the actor's own sends nothing", async () => {
    const { t, owner } = await start();
    const calls = stubFetch();
    const id = await owner.mutation(api.tasks.create, { title: "Back to me", assignee: COFOUNDER });
    await t.run((ctx) => ctx.db.patch(id, { assignee: OWNER }));
    await finishScheduled(t);
    expect(calls).toHaveLength(0);
  });

  test("an assignee removed from the team meanwhile is not announced", async () => {
    const { t, owner } = await start();
    const calls = stubFetch();
    await owner.mutation(api.tasks.create, { title: "For Sam", assignee: US_SALES });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("members")
        .withIndex("by_email", (q) => q.eq("email", US_SALES))
        .first();
      await ctx.db.delete(row!._id);
    });
    await finishScheduled(t);
    expect(calls).toHaveLength(0);
  });

  test("the username on record when it sends is the one used", async () => {
    const { t, owner } = await start();
    const calls = stubFetch();
    await owner.mutation(api.tasks.create, { title: "Tagged", assignee: COFOUNDER });
    await setTelegram(t, COFOUNDER, "Cora_F");
    await finishScheduled(t);
    expect(text(calls[0]).split("\n")[0]).toBe("<b>New task</b> for @Cora_F");
  });
});

// ── What it says ────────────────────────────────────────────────────────────

describe("the message", () => {
  const say = async (
    task: { title: string; company?: "us" | "kz"; due?: string; assignee?: string; notes?: string },
    by: "owner" | "cofounder" = "owner",
    prepare?: (t: TestBackend) => Promise<unknown>,
  ) => {
    const s = await start();
    await prepare?.(s.t);
    const calls = stubFetch();
    await s[by].mutation(api.tasks.create, { assignee: COFOUNDER, ...task });
    await finishScheduled(s.t);
    expect(calls).toHaveLength(1);
    return calls[0]!;
  };

  test("with a username on record: tagged", async () => {
    const call = await say({ title: "Call the clinic back", company: "us" }, "owner", (t) =>
      setTelegram(t, COFOUNDER, "Cora_F"),
    );
    expect(text(call)).toBe(
      `<b>New task</b> for @Cora_F\nCall the clinic back\nStartup · from Olga Owner · ${LINK}`,
    );
  });

  test("without one: the person's name, and no tag", async () => {
    const call = await say({ title: "Call the clinic back", company: "kz", due: "2026-11-02" });
    expect(text(call)).toBe(
      `<b>New task</b> for Cora Founder\nCall the clinic back\nGlobex · due 2 Nov 2026 · from Olga Owner · ${LINK}`,
    );
    expect(text(call)).not.toContain("@");
  });

  test("the owner is tagged by the username the owner gave for themselves", async () => {
    const s = await start();
    await s.owner.mutation(api.telegram.setMine, { telegram: "@Olga_Owner" });
    const calls = stubFetch();
    await s.cofounder.mutation(api.tasks.create, { title: "For you", assignee: OWNER });
    await finishScheduled(s.t);
    expect(text(calls[0]).split("\n")[0]).toBe("<b>New task</b> for @Olga_Owner");
  });

  test("a members row left under the owner's address is not where the owner's username is read", async () => {
    const { t, owner, cofounder } = await start();
    await t.run(async (ctx) => {
      await ctx.db.insert("members", {
        email: OWNER,
        role: "sales",
        companies: ["us", "kz"],
        addedAt: 1,
        addedBy: await ctx.db.insert("users", {}),
        telegram: "Stale_Name",
      });
    });
    // With no username of the owner's own, the owner is named and not tagged.
    let calls = stubFetch();
    await cofounder.mutation(api.tasks.create, { title: "First", assignee: OWNER, company: "us" });
    await finishScheduled(t);
    expect(text(calls[0])).not.toContain("Stale_Name");
    expect(text(calls[0])).toContain("<b>New task</b> for Olga Owner");
    // With one, that is the tag.
    await owner.mutation(api.telegram.setMine, { telegram: "Olga_Owner" });
    calls = stubFetch();
    await cofounder.mutation(api.tasks.create, { title: "Second", assignee: OWNER, company: "us" });
    await finishScheduled(t);
    expect(text(calls[0])).toContain("for @Olga_Owner");
  });

  test("the title is escaped and an @ in it pings nobody", async () => {
    const call = await say({ title: "<b>Fix</b> & tell @durov <a href='x'>now</a>" });
    expect(text(call).split("\n")[1]).toBe(
      "&lt;b&gt;Fix&lt;/b&gt; &amp; tell ＠durov &lt;a href='x'&gt;now&lt;/a&gt;",
    );
    expect(text(call)).not.toContain("@");
  });

  test("never the task's notes, never an address", async () => {
    const call = await say({ title: "Quiet", notes: "SECRET notes about the clinic" });
    expect(JSON.stringify(call.body)).not.toMatch(/SECRET|gmail\.com|startup\.ai/);
  });

  test("a person who has never signed in is 'a teammate', not their address", async () => {
    const s = await start();
    await s.t.run(async (ctx) => {
      await ctx.db.insert("members", {
        email: "never.signed.in@gmail.com",
        role: "sales",
        companies: ["us"],
        addedAt: 1,
        addedBy: await ctx.db.insert("users", {}),
      });
    });
    const calls = stubFetch();
    await s.owner.mutation(api.tasks.create, { title: "Welcome", assignee: "never.signed.in@gmail.com" });
    await finishScheduled(s.t);
    expect(text(calls[0]).split("\n")[0]).toBe("<b>New task</b> for a teammate");
    expect(text(calls[0])).not.toContain("never.signed.in");
  });

  test("no link when SITE_URL is not a site address", async () => {
    vi.stubEnv("SITE_URL", 'https://x.test"><b>');
    const call = await say({ title: "No link" });
    expect(text(call)).toBe("<b>New task</b> for Cora Founder\nNo link\nBoth · from Olga Owner");
  });
});

// ── Which group ─────────────────────────────────────────────────────────────

describe("which group a message goes to", () => {
  const groupFor = async (company: "us" | "kz" | undefined, settings: Record<string, unknown>) => {
    const s = await start(settings);
    const calls = stubFetch();
    await s.owner.mutation(api.tasks.create, { title: "A task", assignee: COFOUNDER, company });
    await finishScheduled(s.t);
    return calls.map((call) => call.body.chat_id);
  };

  test("a company's task goes to its own group", async () => {
    expect(await groupFor("us", {})).toEqual([US.id]);
    expect(await groupFor("kz", {})).toEqual([KZ.id]);
  });

  test("a shared task goes to Startup's group if set, else Globex's", async () => {
    expect(await groupFor(undefined, {})).toEqual([US.id]);
    expect(await groupFor(undefined, { chatUs: undefined })).toEqual([KZ.id]);
  });

  test("a company's task is not sent to the other company's group", async () => {
    expect(await groupFor("us", { chatUs: undefined })).toEqual([]);
    expect(await groupFor("kz", { chatKz: undefined })).toEqual([]);
  });
});

// ── Off ─────────────────────────────────────────────────────────────────────

describe("when the feature is off, nothing is asked of Telegram", () => {
  test.each([["unset", undefined], ["blank", "  "]])(
    "the token %s: nothing is even scheduled",
    async (_what, value) => {
      const { t, owner } = await start();
      if (value === undefined) vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
      else vi.stubEnv("TELEGRAM_BOT_TOKEN", value);
      const calls = stubFetch();
      const id = await owner.mutation(api.tasks.create, { title: "A task", assignee: COFOUNDER });
      await owner.mutation(api.tasks.update, { id, assignee: US_SALES });
      expect(await scheduled(t)).toEqual([]);
      await finishScheduled(t);
      expect(calls).toHaveLength(0);
      expect(await t.run((ctx) => ctx.db.query("telegramSends").collect())).toEqual([]);
    },
  );

  test("the token taken away before the action runs", async () => {
    const { t, owner } = await start();
    const calls = stubFetch();
    await owner.mutation(api.tasks.create, { title: "A task", assignee: COFOUNDER });
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    await finishScheduled(t);
    expect(calls).toHaveLength(0);
    // Off is off: it is not a failure, and no message is counted.
    expect((await settingsRow(t))?.lastError).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.query("telegramSends").collect())).toEqual([]);
  });

  test("switched off", async () => {
    const { t, owner } = await start({ enabled: false });
    const calls = stubFetch();
    await owner.mutation(api.tasks.create, { title: "A task", assignee: COFOUNDER });
    await finishScheduled(t);
    expect(calls).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("telegramSends").collect())).toEqual([]);
  });

  test("no settings at all", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await signInAsCofounder(t);
    const calls = stubFetch();
    await owner.mutation(api.tasks.create, { title: "A task", assignee: COFOUNDER });
    await finishScheduled(t);
    expect(calls).toHaveLength(0);
    expect(await settingsRow(t)).toBeNull();
  });

  test("no group picked", async () => {
    const { t, owner } = await start({ chatUs: undefined, chatKz: undefined });
    const calls = stubFetch();
    await owner.mutation(api.tasks.create, { title: "A task", assignee: COFOUNDER });
    await finishScheduled(t);
    expect(calls).toHaveLength(0);
    expect((await settingsRow(t))?.lastError).toBeUndefined();
    expect((await scheduled(t)).map((job) => job.state.kind)).toEqual(["success"]);
  });
});

// ── Failures ────────────────────────────────────────────────────────────────

describe("a failure is the bot's own and is said in fixed words", () => {
  const FAILURES: [string, Answer, string][] = [
    ["a refused token", json({ ok: false, description: "Unauthorized SENTINEL" }, 401), TELEGRAM_FAILURES.token],
    ["a group the bot is not in", json({ ok: false, description: "chat not found SENTINEL" }, 400), TELEGRAM_FAILURES.chat],
    ["a bot that was removed", json({ ok: false, description: "kicked" }, 403), TELEGRAM_FAILURES.chat],
    ["no answer", () => new Promise<Response>(() => {}), TELEGRAM_FAILURES.timeout],
    ["no network", new TypeError(`fetch failed https://api.telegram.org/bot${TOKEN}/sendMessage`), TELEGRAM_FAILURES.unreachable],
    ["a server error", json({}, 500), TELEGRAM_FAILURES.other],
    ["a long 429", json({ ok: false, parameters: { retry_after: 600 } }, 429), TELEGRAM_FAILURES.slow],
  ];

  test.each(FAILURES)("%s: the task is saved, and the row says why", async (_what, answer, sentence) => {
    const { t, owner } = await start();
    stubFetch(answer);
    const id = await owner.mutation(api.tasks.create, { title: "Saved anyway", assignee: COFOUNDER });
    expect((await tasks(t))[0]).toMatchObject({ _id: id, title: "Saved anyway", assignee: COFOUNDER });
    // The action itself does not fail either: nothing is left failed.
    await finishScheduled(t);
    expect((await scheduled(t)).map((job) => job.state.kind)).toEqual(["success"]);
    const row = await settingsRow(t);
    expect(row?.lastError).toBe(sentence);
    // A retry or a deadline moves the clock on before the failure is known.
    expect(row?.lastErrorAt).toBeGreaterThanOrEqual(NOW);
    expect(row?.lastSentAt).toBeUndefined();
    expect(await everythingStored(t)).not.toMatch(/SENTINEL|api\.telegram\.org/);
    await owner.mutation(api.tasks.update, { id, title: "Still editable" });
  });

  test("a later message that gets through clears the failure", async () => {
    const { t, owner } = await start();
    stubFetch(json({ ok: false }, 401));
    const id = await owner.mutation(api.tasks.create, { title: "First", assignee: COFOUNDER });
    await finishScheduled(t);
    stubFetch(sent());
    vi.setSystemTime(NOW + 5_000);
    await owner.mutation(api.tasks.update, { id, assignee: US_SALES });
    await finishScheduled(t);
    const row = await settingsRow(t);
    expect(row?.lastSentAt).toBe(NOW + 5_000);
    expect(row?.lastError).toBeUndefined();
    expect(row?.lastErrorAt).toBeUndefined();
  });

  test("a short 429 is waited out and the message sent", async () => {
    const { t, owner } = await start();
    const calls = stubFetch(json({ ok: false, parameters: { retry_after: 2 } }, 429), sent());
    await owner.mutation(api.tasks.create, { title: "Patient", assignee: COFOUNDER });
    await finishScheduled(t);
    expect(calls).toHaveLength(2);
    expect((await settingsRow(t))?.lastError).toBeUndefined();
    expect((await settingsRow(t))?.lastSentAt).toBeTypeOf("number");
  });

  test("a token that is not a token is said, without a request", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "SENTINEL-not-a-token");
    const { t, owner } = await start();
    const calls = stubFetch();
    await owner.mutation(api.tasks.create, { title: "A task", assignee: COFOUNDER });
    await finishScheduled(t);
    expect(calls).toHaveLength(0);
    expect((await settingsRow(t))?.lastError).toBe(TELEGRAM_FAILURES.badToken);
    expect(await everythingStored(t)).not.toContain("SENTINEL");
  });

  test("the hook never fails the task's own write, whatever scheduling does", async () => {
    const ctx = {
      scheduler: {
        runAfter: async () => {
          throw new Error(`SENTINEL ${TOKEN}`);
        },
      },
    } as unknown as MutationCtx;
    await expect(
      announceAssignment(ctx, {
        taskId: "t1" as Id<"tasks">,
        before: undefined,
        after: COFOUNDER,
        actor: { _id: "u1" as Id<"users">, email: OWNER },
      }),
    ).resolves.toBeUndefined();
  });

  test("nothing the owner can read holds the token or an address of Telegram's", async () => {
    const { t, owner } = await start();
    stubFetch(new TypeError(`fetch failed https://api.telegram.org/bot${TOKEN}/sendMessage`));
    await owner.mutation(api.tasks.create, { title: "A task", assignee: COFOUNDER });
    await finishScheduled(t);
    const read = JSON.stringify([
      await owner.query(api.telegram.settings, {}),
      await owner.query(api.sources.list, {}),
      await owner.query(api.sources.recentRuns, {}),
      await owner.query(api.team.list, {}),
    ]);
    expect(read).not.toMatch(/SENTINEL|api\.telegram\.org|123456789/);
  });
});

// ── The hourly limit ────────────────────────────────────────────────────────

describe("at most thirty messages an hour to one group", () => {
  const assignMany = async (owner: Client, t: TestBackend, count: number, company?: "us" | "kz") => {
    for (let i = 0; i < count; i += 1) {
      await owner.mutation(api.tasks.create, { title: `Task ${i}`, assignee: COFOUNDER, company });
    }
    await finishScheduled(t);
  };

  test("the thirty-first is dropped, and the row says so", async () => {
    const { t, owner } = await start();
    const calls = stubFetch();
    await assignMany(owner, t, HOURLY_LIMIT, "us");
    expect(calls).toHaveLength(HOURLY_LIMIT);
    expect((await settingsRow(t))?.lastError).toBeUndefined();
    await assignMany(owner, t, 2, "us");
    expect(calls).toHaveLength(HOURLY_LIMIT);
    expect((await settingsRow(t))?.lastError).toBe(TELEGRAM_FAILURES.flood);
    expect(await tasks(t)).toHaveLength(HOURLY_LIMIT + 2);
  });

  test("each group has its own count", async () => {
    const { t, owner } = await start();
    const calls = stubFetch();
    await assignMany(owner, t, HOURLY_LIMIT, "us");
    await assignMany(owner, t, 1, "kz");
    expect(calls).toHaveLength(HOURLY_LIMIT + 1);
    expect(calls.at(-1)!.body.chat_id).toBe(KZ.id);
  });

  test("an hour later the group can be posted to again, and the old count is forgotten", async () => {
    const { t, owner } = await start();
    const calls = stubFetch();
    await assignMany(owner, t, HOURLY_LIMIT + 1, "us");
    expect(calls).toHaveLength(HOURLY_LIMIT);
    vi.setSystemTime(Date.now() + HOUR + 1);
    await assignMany(owner, t, 1, "us");
    expect(calls).toHaveLength(HOURLY_LIMIT + 1);
    expect(await t.run((ctx) => ctx.db.query("telegramSends").collect())).toHaveLength(1);
  });

  test("a test message counts and is held to the same limit", async () => {
    const { t, owner } = await start();
    const calls = stubFetch();
    await assignMany(owner, t, HOURLY_LIMIT, "us");
    await owner.mutation(api.telegram.sendTest, { company: "us" });
    await finishScheduled(t);
    expect(calls).toHaveLength(HOURLY_LIMIT);
    expect((await settingsRow(t))?.test).toMatchObject({
      company: "us",
      outcome: "failed",
      error: TELEGRAM_FAILURES.flood,
    });
  });
});

// ── Settings ────────────────────────────────────────────────────────────────

describe("telegram.settings", () => {
  test("before anything is set: off, no groups, and whether the token is there", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    expect(await owner.query(api.telegram.settings, {})).toEqual({
      tokenSet: true,
      siteSet: true,
      enabled: false,
      chats: { us: null, kz: null },
      canChangeShared: true,
      canPickGroups: true,
      mine: null,
      mineLinked: false,
      mineLinkedAt: null,
      people: [],
      log: [],
      botUsername: null,
      untagged: "kz",
      commands: {
        wanted: false,
        failure: null,
        failureAt: null,
        state: "unknown",
        pending: null,
        deliveryError: null,
        deliveryErrorAt: null,
        checkedAt: null,
        working: false,
        error: null,
      },
      found: null,
      finding: false,
      foundAt: null,
      findError: null,
      test: null,
      lastSentAt: null,
      lastError: null,
      lastErrorAt: null,
      teammates: 0,
      withoutUsername: 0,
    });
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    vi.stubEnv("SITE_URL", "");
    expect(await owner.query(api.telegram.settings, {})).toMatchObject({
      tokenSet: false,
      siteSet: false,
    });
  });

  test("it says the token is set, never what it is", async () => {
    const { owner } = await start();
    const read = await owner.query(api.telegram.settings, {});
    expect(read.tokenSet).toBe(true);
    expect(JSON.stringify(read)).not.toMatch(/SENTINEL|123456789/);
  });

  test("how many teammates have no username", async () => {
    const { t, owner } = await start();
    await setTelegram(t, COFOUNDER, "Cora_F");
    expect(await owner.query(api.telegram.settings, {})).toMatchObject({
      teammates: 3,
      withoutUsername: 2,
    });
  });

  test("not for a teammate without the settings area", async () => {
    const { cofounder } = await start();
    await expect(cofounder.query(api.telegram.settings, {})).rejects.toThrow("not_allowed");
  });
});

describe("telegram.setMine", () => {
  test("the owner's own username, kept by user and not by address", async () => {
    const { t, owner } = await start();
    await owner.mutation(api.telegram.setMine, { telegram: "@Olga_Owner" });
    expect((await owner.query(api.telegram.settings, {})).mine).toBe("Olga_Owner");
    const row = await settingsRow(t);
    expect(row?.owners).toHaveLength(1);
    expect(row?.owners?.[0]?.telegram).toBe("Olga_Owner");
    expect(JSON.stringify(row)).not.toContain(OWNER);
    // The rest of the row is left alone.
    expect(row).toMatchObject({ enabled: true, chatUs: US, chatKz: KZ });
  });

  test("blank clears it; a second save replaces, never adds", async () => {
    const { t, owner } = await start();
    await owner.mutation(api.telegram.setMine, { telegram: "Olga_Owner" });
    await owner.mutation(api.telegram.setMine, { telegram: "Olga_Two" });
    expect((await settingsRow(t))?.owners).toHaveLength(1);
    await owner.mutation(api.telegram.setMine, { telegram: " " });
    expect((await settingsRow(t))?.owners).toEqual([]);
    expect((await owner.query(api.telegram.settings, {})).mine).toBeNull();
  });

  test("what is no username is refused", async () => {
    const { owner } = await start();
    await expect(owner.mutation(api.telegram.setMine, { telegram: "x y" })).rejects.toThrow(
      NOT_A_USERNAME,
    );
  });
});

describe("telegram.save", () => {
  const FOUND = [
    { id: "-2001", title: "New Startup group", type: "supergroup" as const },
    { id: "-2002", title: "New Globex group", type: "group" as const },
  ];

  test("picks a group for each company from the ones found, with its title", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await t.run((ctx) => ctx.db.insert("telegramSettings", { enabled: false, found: FOUND }));
    await owner.mutation(api.telegram.save, { enabled: true, chatUs: "-2001", chatKz: "-2002" });
    expect(await settingsRow(t)).toMatchObject({
      enabled: true,
      chatUs: { id: "-2001", title: "New Startup group" },
      chatKz: { id: "-2002", title: "New Globex group" },
    });
  });

  test("a group already picked can be kept, or given to the other company, once it is no longer listed", async () => {
    const { t, owner } = await start();
    await owner.mutation(api.telegram.save, { enabled: true, chatUs: US.id, chatKz: US.id });
    expect(await settingsRow(t)).toMatchObject({ chatUs: US, chatKz: US });
  });

  test("null takes a group away; switching off keeps the groups", async () => {
    const { t, owner } = await start();
    await owner.mutation(api.telegram.save, { enabled: false, chatUs: null, chatKz: KZ.id });
    const row = await settingsRow(t);
    expect(row?.enabled).toBe(false);
    expect(row?.chatUs).toBeUndefined();
    expect(row?.chatKz).toEqual(KZ);
  });

  test.each([["an id never found", "-999"], ["text that is no id", "<b>SECRET</b>"]])(
    "%s is refused in fixed words and nothing changes",
    async (_what, chat) => {
      const { t, owner } = await start();
      const error = await owner
        .mutation(api.telegram.save, { enabled: false, chatUs: chat, chatKz: null })
        .then(() => null, (e: Error) => e.message);
      expect(error).toContain(PICK_FROM_LIST);
      expect(error).not.toContain("SECRET");
      expect(await settingsRow(t)).toMatchObject({ enabled: true, chatUs: US, chatKz: KZ });
    },
  );

  test("the first save makes the one row", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.telegram.save, { enabled: true, chatUs: null, chatKz: null });
    await owner.mutation(api.telegram.save, { enabled: false, chatUs: null, chatKz: null });
    expect(await t.run((ctx) => ctx.db.query("telegramSettings").collect())).toHaveLength(1);
  });
});

// ── Find my groups ──────────────────────────────────────────────────────────

describe("telegram.findChats", () => {
  const UPDATES = {
    ok: true,
    result: [
      {
        update_id: 1,
        message: {
          message_id: 5,
          text: "SECRET message @startup_bot",
          from: { id: 7, first_name: "SECRET", username: "cora_f" },
          chat: { id: -100123, title: "Startup team", type: "supergroup", username: "SECRET_link" },
        },
      },
      {
        update_id: 2,
        message: { text: "SECRET dm", chat: { id: 7, type: "private", first_name: "SECRET" } },
      },
      {
        update_id: 3,
        my_chat_member: {
          chat: { id: -456, title: "Globex", type: "group" },
          from: { first_name: "SECRET", username: "Cora_F" },
        },
      },
      {
        // A stranger's group with the same title: nobody on record is in it.
        update_id: 4,
        message: {
          text: "/start",
          from: { id: 8, username: "SECRET_stranger" },
          chat: { id: -100999, title: "Startup team", type: "supergroup" },
        },
      },
      {
        update_id: 5,
        my_chat_member: { chat: { id: -100998, title: "Startup team", type: "group" }, from: { id: 9 } },
      },
    ],
  };
  const methods = (calls: Call[]) => calls.map((call) => call.url.split("/").pop());

  test("asks getUpdates and keeps each group's id, title and type, and nothing else", async () => {
    const { t, owner } = await start();
    await setTelegram(t, COFOUNDER, "Cora_F");
    const calls = stubFetch(json(UPDATES));
    await owner.mutation(api.telegram.findChats, {});
    expect((await owner.query(api.telegram.settings, {})).finding).toBe(true);
    await finishScheduled(t);
    // Who the bot is, where its updates go (nowhere: no webhook), then what it has seen.
    expect(methods(calls).slice(0, 3)).toEqual(["getMe", "getWebhookInfo", "getUpdates"]);
    // Then only how many are in each group on offer.
    expect(new Set(methods(calls).slice(3))).toEqual(new Set(["getChatMemberCount"]));
    expect(calls[2]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates`);
    expect(calls[2]!.init).toMatchObject({ method: "POST", redirect: "manual" });
    const read = await owner.query(api.telegram.settings, {});
    expect(read).toMatchObject({ finding: false, findError: null });
    expect(read.foundAt).toBeGreaterThanOrEqual(NOW);
    expect(read.found).toEqual([
      { id: "-100123", title: "Startup team", type: "supergroup" },
      { id: "-456", title: "Globex", type: "group" },
    ]);
    expect(await everythingStored(t)).not.toContain("SECRET");
    // The groups already picked are untouched.
    expect(await settingsRow(t)).toMatchObject({ chatUs: US, chatKz: KZ, enabled: true });
  });

  test("a group nobody on record wrote in or added the bot to is not found, whatever it is called", async () => {
    const { t, owner } = await start();
    stubFetch(json(UPDATES));
    await owner.mutation(api.telegram.findChats, {});
    await finishScheduled(t);
    expect((await owner.query(api.telegram.settings, {})).found).toEqual([]);
    expect(await everythingStored(t)).not.toContain("-100999");
  });

  test("the owner's own username vouches for a group too", async () => {
    const { t, owner } = await start();
    await owner.mutation(api.telegram.setMine, { telegram: "@Cora_F" });
    stubFetch(json(UPDATES));
    await owner.mutation(api.telegram.findChats, {});
    await finishScheduled(t);
    expect((await owner.query(api.telegram.settings, {})).found?.map((chat) => chat.id)).toEqual([
      "-100123",
      "-456",
    ]);
  });

  test("how many are in each group on offer is asked and kept, for the found and the picked", async () => {
    const { t, owner } = await start();
    await setTelegram(t, COFOUNDER, "Cora_F");
    const SIZES: Record<string, unknown> = { "-100123": 12, "-456": 3, [US.id]: 9, [KZ.id]: "SECRET" };
    const asked: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const method = String(url).split("/").pop();
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (method === "getUpdates") return json(UPDATES);
        if (method !== "getChatMemberCount") return json({ ok: true, result: { url: "" } });
        asked.push(body);
        return json({ ok: true, result: SIZES[String(body.chat_id)] });
      }),
    );
    await owner.mutation(api.telegram.findChats, {});
    await finishScheduled(t);
    expect(asked).toHaveLength(4);
    expect(asked).toEqual(expect.arrayContaining([{ chat_id: "-100123" }, { chat_id: US.id }]));
    const read = await owner.query(api.telegram.settings, {});
    expect(read.found).toEqual([
      { id: "-100123", title: "Startup team", type: "supergroup", members: 12 },
      { id: "-456", title: "Globex", type: "group", members: 3 },
    ]);
    expect(read.chats).toEqual({ us: { ...US, members: 9 }, kz: KZ });
    expect(await everythingStored(t)).not.toContain("SECRET");
    // Picked from the list, a group keeps its size.
    await owner.mutation(api.telegram.save, { enabled: true, chatUs: "-100123", chatKz: null });
    expect((await owner.query(api.telegram.settings, {})).chats.us).toEqual({
      id: "-100123",
      title: "Startup team",
      members: 12,
    });
  });

  test("a group that cannot be counted is listed without a number, and that is no failure", async () => {
    const { t, owner } = await start();
    await setTelegram(t, COFOUNDER, "Cora_F");
    stubFetch(json({ ok: true, result: {} }), json({ ok: true, result: { url: "" } }), json(UPDATES), json({ ok: false }, 403));
    await owner.mutation(api.telegram.findChats, {});
    await finishScheduled(t);
    const read = await owner.query(api.telegram.settings, {});
    expect(read).toMatchObject({ finding: false, findError: null });
    expect(read.found).toEqual([
      { id: "-100123", title: "Startup team", type: "supergroup" },
      { id: "-456", title: "Globex", type: "group" },
    ]);
  });

  test("none seen is an empty list, not a failure", async () => {
    const { t, owner } = await start();
    stubFetch(json({ ok: true, result: [] }));
    await owner.mutation(api.telegram.findChats, {});
    await finishScheduled(t);
    expect(await owner.query(api.telegram.settings, {})).toMatchObject({
      found: [],
      finding: false,
      findError: null,
    });
  });

  test.each([
    ["a refused token", json({ ok: false }, 401), TELEGRAM_FAILURES.token],
    [
      // A webhook set between the two questions: Telegram refuses getUpdates.
      "a bot with a webhook",
      [json({ ok: true, result: {} }), json({ ok: true, result: { url: "" } }), json({ ok: false }, 409)],
      TELEGRAM_FAILURES.updates,
    ],
    ["no network", new TypeError(`failed https://api.telegram.org/bot${TOKEN}/getUpdates`), TELEGRAM_FAILURES.unreachable],
  ] as [string, Answer | Answer[], string][])("%s is said in fixed words, and the last list is kept", async (_w, answer, sentence) => {
    const kept = [{ id: "-9", title: "Kept", type: "group" as const }];
    const { t, owner } = await start({ found: kept });
    stubFetch(...(Array.isArray(answer) ? answer : [answer]));
    await owner.mutation(api.telegram.findChats, {});
    await finishScheduled(t);
    expect(await owner.query(api.telegram.settings, {})).toMatchObject({
      finding: false,
      findError: sentence,
      found: kept,
    });
    expect(await everythingStored(t)).not.toMatch(/SENTINEL|api\.telegram\.org/);
  });

  test("without the token it is refused, and nothing is started", async () => {
    const { t, owner } = await start();
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const calls = stubFetch();
    await expect(owner.mutation(api.telegram.findChats, {})).rejects.toThrow(NO_TOKEN);
    expect(await scheduled(t)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("the owner's alone", async () => {
    const { t, cofounder } = await start();
    await expect(cofounder.mutation(api.telegram.findChats, {})).rejects.toThrow("not_owner");
    expect(await scheduled(t)).toEqual([]);
  });
});

// ── The test message ────────────────────────────────────────────────────────

describe("telegram.sendTest", () => {
  test("posts the fixed sentence to that company's group and says it was sent", async () => {
    const { t, owner } = await start({ enabled: false });
    const calls = stubFetch();
    await owner.mutation(api.telegram.sendTest, { company: "kz" });
    expect((await owner.query(api.telegram.settings, {})).test).toEqual({
      company: "kz",
      at: NOW,
      outcome: "sending",
      error: null,
    });
    await finishScheduled(t);
    expect(calls.map((call) => call.body)).toEqual([
      { chat_id: KZ.id, text: TEST_MESSAGE, parse_mode: "HTML", disable_web_page_preview: true },
    ]);
    expect((await owner.query(api.telegram.settings, {})).test).toMatchObject({
      company: "kz",
      outcome: "sent",
      error: null,
    });
    // A test is not a task's message: the last-sent time is not its to set.
    expect((await settingsRow(t))?.lastSentAt).toBeUndefined();
  });

  test.each([
    ["a refused token", json({ ok: false }, 401), TELEGRAM_FAILURES.token],
    ["a group the bot is not in", json({ ok: false }, 403), TELEGRAM_FAILURES.chat],
    ["no answer", () => new Promise<Response>(() => {}), TELEGRAM_FAILURES.timeout],
  ] as [string, Answer, string][])("%s is reported in fixed words", async (_what, answer, sentence) => {
    const { t, owner } = await start();
    stubFetch(answer);
    await owner.mutation(api.telegram.sendTest, { company: "us" });
    await finishScheduled(t);
    expect((await owner.query(api.telegram.settings, {})).test).toMatchObject({
      company: "us",
      outcome: "failed",
      error: sentence,
    });
    expect(await everythingStored(t)).not.toMatch(/SENTINEL|api\.telegram\.org/);
  });

  test("a company with no group is refused before anything is started", async () => {
    const { t, owner } = await start({ chatKz: undefined });
    const calls = stubFetch();
    await expect(owner.mutation(api.telegram.sendTest, { company: "kz" })).rejects.toThrow(
      "Pick a group for Globex first.",
    );
    expect(await scheduled(t)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("without the token it is refused", async () => {
    const { owner } = await start();
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    await expect(owner.mutation(api.telegram.sendTest, { company: "us" })).rejects.toThrow(NO_TOKEN);
  });

  test("not for a teammate without the settings area", async () => {
    const { cofounder } = await start();
    await expect(cofounder.mutation(api.telegram.sendTest, { company: "us" })).rejects.toThrow(
      "not_allowed",
    );
  });
});
