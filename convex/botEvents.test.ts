import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ownerMember } from "./lib/agentStore";
import { approveProposal } from "./lib/proposals";
import { CANNOT_ASSIGN, SOME_BOT } from "./tasks";
import {
  EVENTS_PER_BOT_PER_HOUR,
  PREVIOUS_SIGNATURE_HEADER,
  RETRY_BACKOFF_MS,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  WEBHOOK_SECRET_ENV,
  WEBHOOK_SECRET_PREVIOUS_ENV,
  WEBHOOK_URL_ENV,
  signBody,
} from "./lib/botEvents";
import { PROPOSAL_WORDS } from "./lib/agents";
import { ENTROPY, NOW, call, ownerWithToken } from "./mcp.kit";
import schema from "./schema";
import { OWNER, modules, signInAsCofounder, signInAsOwner, type TestBackend } from "./test.setup";

// Outbound bot events. Every title, note and address is made up. The secrets
// below are not credentials; the tests assert they never reach a job or a row.

const URL = "https://example.com/hook";
const SECRET = "test-secret-should-not-leave-0123456789abcdef";
const OLD_SECRET = "old-test-secret-should-not-leave-0123456789";
const NOTES = "NOTES-SHOULD-NOT-LEAVE-9f3a made-up chart";
const SUMMARY = "SUMMARY-SHOULD-NOT-LEAVE-9f3a";
const WHY = "WHY-SHOULD-NOT-LEAVE-9f3a";
const DISMISS = "DISMISS-SHOULD-NOT-LEAVE-9f3a";

beforeEach(() => {
  // setTimeout too: convex-test runs a scheduled action on a timer, and a
  // delivery that starts mid-mutation races the test. These tests assert the
  // scheduled job, not the POST (that is the `deliver` suite).
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "setInterval"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
  vi.stubEnv(WEBHOOK_URL_ENV, "");
  vi.stubEnv(WEBHOOK_SECRET_ENV, "");
  vi.stubEnv(WEBHOOK_SECRET_PREVIOUS_ENV, "");
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Job = { name: string; args: unknown; scheduledTime: number };

const jobs = async (t: TestBackend) =>
  (
    (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())) as Job[]
  ).filter((job) => job.name === "botEvents:deliver");

const argsOf = (job: Job) => (job.args as [Record<string, unknown>])[0]!;

async function ownerWorld() {
  const t = convexTest(schema, modules);
  const owner = await signInAsOwner(t);
  await owner.mutation(api.bots.addSuggested, {});
  return { t, owner };
}

const botRow = (t: TestBackend, botId: string) =>
  t.run(async (ctx) => (await ctx.db.query("bots").collect()).find((bot) => bot.botId === botId)!);

const statusRow = (t: TestBackend, bot: string) =>
  t.run(async (ctx) => (await ctx.db.query("botEventStatus").collect()).find((row) => row.bot === bot) ?? null);

function withWebhook() {
  vi.stubEnv(WEBHOOK_URL_ENV, URL);
  vi.stubEnv(WEBHOOK_SECRET_ENV, SECRET);
}

describe("scheduling", () => {
  test("unset URL creates the task and schedules nothing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { t, owner } = await ownerWorld();
    const id = await owner.mutation(api.tasks.create, {
      title: "For growth",
      company: "us",
      assignee: "growth",
      notes: NOTES,
    });
    expect(id).toBeTruthy();
    expect(await jobs(t)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("creating or reassigning a task to a bot schedules one delivery, and nothing else does", async () => {
    withWebhook();
    const { t, owner } = await ownerWorld();
    const long = `${"A".repeat(180)} tail`;
    const id = await owner.mutation(api.tasks.create, {
      title: long,
      company: "kz",
      assignee: " Growth ",
      notes: NOTES,
    });
    const [job] = await jobs(t);
    expect(job!.name).toBe("botEvents:deliver");
    const args = argsOf(job!);
    expect(Object.keys(args).sort()).toEqual(
      ["agent", "at", "attempt", "company", "deliveryId", "event", "id", "title", "userId"].sort(),
    );
    expect(args).toMatchObject({
      event: "task.assigned",
      company: "kz",
      agent: "growth",
      id,
      attempt: 0,
      at: NOW,
      userId: (await botRow(t, "growth")).userId,
    });
    expect(String(args.deliveryId)).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(String(args.title).length).toBeLessThanOrEqual(140);
    expect(String(args.title).endsWith("…")).toBe(true);
    expect(JSON.stringify(args)).not.toContain(NOTES);
    expect(JSON.stringify(args)).not.toContain(SECRET);

    await owner.mutation(api.tasks.update, { id, title: "Renamed only" });
    expect(await jobs(t)).toHaveLength(1);

    await owner.mutation(api.tasks.update, { id, assignee: OWNER });
    expect(await jobs(t)).toHaveLength(1);

    await owner.mutation(api.tasks.update, { id, assignee: "research" });
    const again = await jobs(t);
    expect(again).toHaveLength(2);
    expect(argsOf(again[1]!).agent).toBe("research");
    expect(argsOf(again[1]!).deliveryId).not.toBe(args.deliveryId);

    const shared = await owner.mutation(api.tasks.create, { title: "Shared card", assignee: "growth" });
    expect(shared).toBeTruthy();
    expect(await jobs(t)).toHaveLength(2);
  });

  test("only a switched-on bot of the owner's, on the board and on that company, may hold a task, refused in one sentence", async () => {
    withWebhook();
    const { t, owner } = await ownerWorld();
    const give = (assignee: string, company: "us" | "kz" = "us") =>
      owner.mutation(api.tasks.create, { title: `For ${assignee}`, company, assignee });

    // Unknown, one of the bare four (the Mac agents, sales included), a Mac spelling.
    for (const assignee of ["nope_bot", "sales", "chief_of_staff", "engineering", "finance", "mac:engineering", "bot:sales"]) {
      await expect(give(assignee)).rejects.toThrow(CANNOT_ASSIGN);
    }
    // An external profile only as `bot:<id>`, and only once it exists and is on.
    await expect(give("bot:chief_of_staff")).rejects.toThrow(CANNOT_ASSIGN);
    await owner.mutation(api.bots.addExternalProfile, { id: "chief_of_staff" });
    const chief = await give("bot:chief_of_staff");
    expect(argsOf((await jobs(t)).at(-1)!)).toMatchObject({ agent: "chief_of_staff", id: chief });
    expect((await t.run((ctx) => ctx.db.get(chief)))!.assignee).toBe("bot:chief_of_staff");

    const growth = await botRow(t, "growth");
    await owner.mutation(api.bots.update, { id: growth._id, company: "us" });
    await expect(give("growth", "kz")).rejects.toThrow(CANNOT_ASSIGN);

    await owner.mutation(api.bots.update, { id: growth._id, enabled: false });
    await expect(give("growth")).rejects.toThrow(CANNOT_ASSIGN);

    const research = await botRow(t, "research");
    await owner.mutation(api.bots.update, {
      id: research._id,
      permissions: [{ area: "memory", level: "write" }],
    });
    await expect(give("research")).rejects.toThrow(CANNOT_ASSIGN);

    // Each refusal above is the same sentence an unknown id gets.
    const said = await give("nope_bot").catch((error: Error) => error.message);
    const off = await give("growth").catch((error: Error) => error.message);
    expect(off).toBe(said);
  });

  test("a teammate cannot give a task to a bot, and sees `a bot` where the owner sees its name", async () => {
    withWebhook();
    const { t, owner } = await ownerWorld();
    const mate = await signInAsCofounder(t);
    await expect(
      mate.mutation(api.tasks.create, { title: "Mine for growth", company: "us", assignee: "growth" }),
    ).rejects.toThrow(CANNOT_ASSIGN);
    const theirs = await mate.mutation(api.tasks.create, { title: "A plain card", company: "us" });
    await expect(mate.mutation(api.tasks.update, { id: theirs, assignee: "growth" })).rejects.toThrow(CANNOT_ASSIGN);
    expect(await jobs(t)).toEqual([]);

    const held = await owner.mutation(api.tasks.create, { title: "Held by growth", company: "us", assignee: "growth" });
    const ownerCard = (await owner.query(api.tasks.board, {})).backlog.find((row) => row.id === held);
    expect(ownerCard!.assignee).toEqual({ status: "teammate", email: "growth", name: "Growth Bot" });
    const mateCard = (await mate.query(api.tasks.board, {})).backlog.find((row) => row.id === held);
    expect(mateCard!.assignee).toEqual({ status: "teammate", email: "growth", name: SOME_BOT });
    expect(JSON.stringify(await mate.query(api.tasks.board, {}))).not.toContain("Growth Bot");
  });

  test("a person who loses a task to a bot is still told", async () => {
    withWebhook();
    const { t, owner } = await ownerWorld();
    const mate = await signInAsCofounder(t);
    // The teammate's `users` row, so they have somewhere to be told.
    await mate.query(api.tasks.board, {});
    const mateEmail = (await t.run((ctx) => ctx.db.query("members").collect()))[0]!.email;
    const id = await owner.mutation(api.tasks.create, { title: "Was theirs", company: "us", assignee: mateEmail });
    await owner.mutation(api.tasks.update, { id, assignee: "growth" });
    const told = await t.run(async (ctx) =>
      (await ctx.db.query("notifications").collect()).filter((row) => row.taskId === id).map((row) => row.kind),
    );
    expect(told).toContain("reassigned");
    expect(argsOf((await jobs(t)).at(-1)!)).toMatchObject({ agent: "growth", id });
  });

  test("a bot cannot give a task to a bot, by a tool or by a proposal, in the same words as an unknown one", async () => {
    withWebhook();
    const t = convexTest(schema, modules);
    const { owner, token } = await ownerWithToken(t, "act");
    const grok = await owner.mutation(api.assistant.createToken, { entropy: ENTROPY, scope: "act", name: "Grok app" });
    await owner.mutation(api.bots.addSuggested, {});

    const byBot = await call(t, grok.token, "task_create", {
      agent: "research",
      company: "us",
      title: "For growth, from research",
      assignee: "growth",
    });
    expect(byBot.isError).toBe(true);
    const unknown = await call(t, grok.token, "task_create", {
      agent: "research",
      company: "us",
      title: "For nobody, from research",
      assignee: "nope_bot",
    });
    expect(byBot.said).toContain(CANNOT_ASSIGN);
    expect(byBot.said).toBe(unknown.said);

    const plain = await call(t, grok.token, "task_create", { agent: "research", company: "us", title: "A plain card" });
    expect(plain.isError).toBeFalsy();
    const moved = await call(t, grok.token, "task_update", { agent: "research", id: plain.output.id, assignee: "growth" });
    expect(moved.isError).toBe(true);
    expect(moved.said).toContain(CANNOT_ASSIGN);

    const proposed = await call(t, grok.token, "propose", {
      agent: "research",
      company: "us",
      kind: "task_create",
      why: WHY,
      dedupeKey: "research:task_create:bot-to-bot",
      payload: { title: "Growth should take this", assignee: "growth" },
    });
    expect(proposed.isError).toBe(true);
    expect(proposed.said).toContain(PROPOSAL_WORDS.cannotAssign);
    expect(await jobs(t)).toEqual([]);

    // The owner's own client (no bot named) may.
    const own = await call(t, token, "task_create", { company: "us", title: "The owner's own", assignee: "growth" });
    expect(own.isError).toBeFalsy();
    expect(argsOf((await jobs(t)).at(-1)!)).toMatchObject({ agent: "growth", id: own.output.id });
  });

  test("a handoff to a bot schedules, and a person, a Mac agent, a switched-off bot or the other company does not", async () => {
    withWebhook();
    const t = convexTest(schema, modules);
    const { owner, token } = await ownerWithToken(t, "act");
    await owner.mutation(api.bots.addSuggested, {});
    await owner.mutation(api.bots.addExternalProfile, { id: "engineering" });
    const made = await call(t, token, "handoff_create", {
      company: "us",
      to: "Growth",
      title: "Research is done",
      summary: SUMMARY,
      agent: "research",
    });
    expect(made.output).toMatchObject({ created: true });
    const [job] = await jobs(t);
    expect(argsOf(job!)).toMatchObject({
      event: "handoff.assigned",
      company: "us",
      agent: "growth",
      id: made.output.id,
      at: NOW,
      attempt: 0,
    });
    expect(JSON.stringify(argsOf(job!))).not.toContain(SUMMARY);
    expect(Object.keys(argsOf(job!))).not.toContain("decision");

    const person = await call(t, token, "handoff_create", {
      company: "us",
      to: OWNER,
      title: "Please review the sample list",
      summary: "A short ask.",
      agent: "research",
    });
    expect(person.isError).toBeFalsy();
    expect(await jobs(t)).toHaveLength(1);

    await call(t, token, "handoff_create", {
      company: "us",
      to: "mac:engineering",
      title: "For the Mac agent",
      summary: "Schedule work.",
      agent: "research",
    });
    expect(await jobs(t)).toHaveLength(1);

    const engineering = await call(t, token, "handoff_create", {
      company: "us",
      to: "engineering",
      title: "For the engineering profile",
      summary: SUMMARY,
      agent: "research",
    });
    expect(argsOf((await jobs(t)).at(-1)!)).toMatchObject({
      event: "handoff.assigned",
      agent: "engineering",
      id: engineering.output.id,
    });
    expect(await jobs(t)).toHaveLength(2);

    await owner.mutation(api.handoffs.reassign, { id: made.output.id as Id<"handoffs">, to: "GROWTH" });
    expect(await jobs(t)).toHaveLength(2);

    await owner.mutation(api.handoffs.reassign, { id: made.output.id as Id<"handoffs">, to: "support" });
    const moved = (await jobs(t)).map(argsOf).find((args) => args.agent === "support");
    expect(moved).toMatchObject({ event: "handoff.assigned", agent: "support", id: made.output.id });
    expect(await jobs(t)).toHaveLength(3);

    const support = await botRow(t, "support");
    await owner.mutation(api.bots.update, { id: support._id, enabled: false });
    await owner.mutation(api.handoffs.reassign, { id: made.output.id as Id<"handoffs">, to: "growth" });
    await owner.mutation(api.handoffs.reassign, { id: made.output.id as Id<"handoffs">, to: "support" });
    // Growth was woken; switched-off support was not.
    expect((await jobs(t)).map(argsOf).filter((args) => args.agent === "support")).toHaveLength(1);
    expect(await jobs(t)).toHaveLength(4);

    const growth = await botRow(t, "growth");
    await owner.mutation(api.bots.update, { id: growth._id, company: "kz" });
    await call(t, token, "handoff_create", {
      company: "us",
      to: "growth",
      title: "Not this market",
      summary: SUMMARY,
      agent: "research",
    });
    expect(await jobs(t)).toHaveLength(4);
  });

  test("a bot's proposal decided schedules proposal.decided; one of the four's never does", async () => {
    withWebhook();
    const t = convexTest(schema, modules);
    const { owner, token } = await ownerWithToken(t, "act");
    const grok = await owner.mutation(api.assistant.createToken, { entropy: ENTROPY, scope: "act", name: "Grok app" });
    await owner.mutation(api.bots.addSuggested, {});
    await owner.mutation(api.bots.addExternalProfile, { id: "chief_of_staff" });

    const propose = (dedupeKey: string, title: string) =>
      call(t, grok.token, "propose", {
        agent: "growth",
        company: "us",
        kind: "task_create",
        why: WHY,
        dedupeKey,
        payload: { title },
      });

    const approved = await propose("growth:task_create:webhook-approve", "Pricing page copy");
    expect(approved.output.id).toBeTruthy();
    await owner.mutation(api.assistant.approve, { id: approved.output.id as Id<"proposals"> });
    const [yes] = await jobs(t);
    expect(argsOf(yes!)).toMatchObject({
      event: "proposal.decided",
      company: "us",
      agent: "growth",
      id: approved.output.id,
      title: "Pricing page copy",
      decision: "approved",
      at: NOW,
    });
    expect(JSON.stringify(argsOf(yes!))).not.toContain(WHY);

    const dismissed = await propose("growth:task_create:webhook-dismiss", "Old landing page");
    await owner.mutation(api.assistant.dismiss, {
      id: dismissed.output.id as Id<"proposals">,
      reason: DISMISS,
    });
    const no = (await jobs(t)).map(argsOf).find((args) => args.decision === "dismissed")!;
    expect(no).toMatchObject({
      event: "proposal.decided",
      agent: "growth",
      id: dismissed.output.id,
      decision: "dismissed",
      title: "Old landing page",
    });
    expect(JSON.stringify(no)).not.toContain(DISMISS);
    expect(JSON.stringify(no)).not.toContain(WHY);

    const decided = await propose("growth:task_create:webhook-decide", "November sample brief");
    const answer = await call(t, grok.token, "proposal_decide", {
      agent: "chief_of_staff",
      ids: [decided.output.id],
      decision: "approve",
    });
    expect(answer.isError).toBeFalsy();
    expect(argsOf((await jobs(t))[2]!)).toMatchObject({
      event: "proposal.decided",
      decision: "approved",
      agent: "growth",
      id: decided.output.id,
    });

    const automatic = await propose("growth:task_create:webhook-auto", "Automatic sample card");
    await t.run(async (ctx) => {
      const user = (await ctx.db.query("users").collect()).find((row) => row.email === OWNER)!;
      await approveProposal(ctx, ownerMember(user), automatic.output.id as Id<"proposals">, {
        now: NOW,
        decision: "auto_approved",
      });
    });
    expect(argsOf((await jobs(t)).at(-1)!)).toMatchObject({
      decision: "auto_approved",
      agent: "growth",
      id: automatic.output.id,
      title: "Automatic sample card",
    });
    const before = (await jobs(t)).length;

    // The Mac runner's sales agent (no bot): decided, and nothing leaves.
    const mac = await call(t, token, "propose", {
      agent: "sales",
      company: "us",
      kind: "task_create",
      why: WHY,
      dedupeKey: "sales:task_create:mac-agent",
      payload: { title: "A Mac agent's card" },
    });
    expect(mac.isError).toBeFalsy();
    await owner.mutation(api.assistant.approve, { id: mac.output.id as Id<"proposals"> });
    const macDismissed = await call(t, token, "propose", {
      agent: "chief_of_staff",
      company: "us",
      kind: "task_create",
      why: WHY,
      dedupeKey: "chief_of_staff:task_create:mac-agent",
      payload: { title: "The Mac chief's card" },
    });
    await owner.mutation(api.assistant.dismiss, { id: macDismissed.output.id as Id<"proposals">, reason: DISMISS });
    expect(await jobs(t)).toHaveLength(before);
  });

  test("sixty events a bot an hour; the rest are counted and not sent", async () => {
    withWebhook();
    const { t, owner } = await ownerWorld();
    for (let i = 0; i < EVENTS_PER_BOT_PER_HOUR + 2; i++) {
      await owner.mutation(api.tasks.create, { title: `Card ${i}`, company: "us", assignee: "growth" });
    }
    expect(await jobs(t)).toHaveLength(EVENTS_PER_BOT_PER_HOUR);
    expect(await statusRow(t, "growth")).toMatchObject({ sent: EVENTS_PER_BOT_PER_HOUR, dropped: 2 });
    await owner.mutation(api.tasks.create, { title: "Research's own", company: "us", assignee: "research" });
    expect(await jobs(t)).toHaveLength(EVENTS_PER_BOT_PER_HOUR + 1);
    const row = await statusRow(t, "growth");
    expect(Object.keys(row!).sort()).toEqual(["_creationTime", "_id", "bot", "dropped", "sent", "windowStart"]);
  });
});

describe("deliver", () => {
  async function world() {
    const { t, owner } = await ownerWorld();
    const growth = await botRow(t, "growth");
    // The row a scheduled event has: made by scheduling one.
    await t.run((ctx) =>
      ctx.db.insert("botEventStatus", { bot: "growth", windowStart: NOW, sent: 1, dropped: 0 }),
    );
    const event = {
      event: "task.assigned" as const,
      company: "us" as const,
      agent: "growth",
      id: "task-1",
      title: "Call the sample clinic",
      deliveryId: "0b7c4d1e-1111-4222-8333-444455556666",
      at: NOW,
      userId: growth.userId,
      attempt: 0,
    };
    const run = (over: Record<string, unknown> = {}) => t.action(internal.botEvents.deliver, { ...event, ...over });
    return { t, owner, growth, run };
  }

  test("unset URL does not fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { run } = await world();
    await run();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a 2xx posts once, signed, with no redirect, and the row says when", async () => {
    withWebhook();
    vi.stubEnv(WEBHOOK_SECRET_PREVIOUS_ENV, OLD_SECRET);
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { t, run } = await world();
    await run();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(URL);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    const headers = init.headers as Record<string, string>;
    expect(headers).toMatchObject({ "Content-Type": "application/json", "User-Agent": "startup-os" });
    const body = String(init.body);
    expect(JSON.parse(body)).toEqual({
      deliveryId: "0b7c4d1e-1111-4222-8333-444455556666",
      event: "task.assigned",
      company: "us",
      agent: "growth",
      id: "task-1",
      title: "Call the sample clinic",
      at: NOW,
    });
    const timestamp = headers[TIMESTAMP_HEADER]!;
    expect(timestamp).toBe(String(Math.floor(NOW / 1000)));
    expect(headers[SIGNATURE_HEADER]).toBe(await signBody(SECRET, timestamp, body));
    expect(headers[PREVIOUS_SIGNATURE_HEADER]).toBe(await signBody(OLD_SECRET, timestamp, body));
    // No secret in a header, and no fixed auth header.
    expect(JSON.stringify(headers)).not.toContain(SECRET);
    expect(JSON.stringify(headers)).not.toContain(OLD_SECRET);
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain("authorization");
    expect(await jobs(t)).toEqual([]);
    expect(await statusRow(t, "growth")).toMatchObject({ lastSentAt: NOW });
    expect(spy).not.toHaveBeenCalled();
  });

  test("a bot switched off, or taken off the board, after it was queued is not woken", async () => {
    withWebhook();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { owner, growth, run } = await world();
    await owner.mutation(api.bots.update, { id: growth._id, enabled: false });
    await run();
    expect(fetchMock).not.toHaveBeenCalled();
    await owner.mutation(api.bots.update, {
      id: growth._id,
      enabled: true,
      permissions: [{ area: "gtm", level: "write" }],
    });
    await run();
    expect(fetchMock).not.toHaveBeenCalled();
    await owner.mutation(api.bots.update, { id: growth._id, permissions: [{ area: "board", level: "read" }] });
    await run();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("a non-2xx or a network error is tried again with the same delivery id, then the row says why, never what", async () => {
    withWebhook();
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { t, run } = await world();
    await run();
    const [retry] = await jobs(t);
    expect(argsOf(retry!)).toMatchObject({ attempt: 1, event: "task.assigned", deliveryId: "0b7c4d1e-1111-4222-8333-444455556666" });
    expect(retry!.scheduledTime).toBe(NOW + RETRY_BACKOFF_MS[0]);
    expect((await statusRow(t, "growth"))!.lastFailure).toBeUndefined();

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error(`boom ${URL} ${SECRET}`);
    }));
    await run({ attempt: 3, title: NOTES });
    const row = await statusRow(t, "growth");
    expect(row!.lastFailure).toEqual({ what: "network", at: NOW });
    expect(await jobs(t)).toHaveLength(1);

    vi.stubGlobal("fetch", fetchMock);
    await run({ attempt: 3, title: NOTES });
    expect((await statusRow(t, "growth"))!.lastFailure).toEqual({ what: "http 500", at: NOW });
    const kept = JSON.stringify(await t.run((ctx) => ctx.db.query("botEventStatus").collect()));
    expect(kept).not.toContain(SECRET);
    expect(kept).not.toContain("example.com");
    expect(kept).not.toContain(NOTES);
    expect(spy).not.toHaveBeenCalled();
  });

  test("a private address, or no secret, is not requested, and the row says unusable", async () => {
    vi.stubEnv(WEBHOOK_URL_ENV, "https://169.254.169.254/latest");
    vi.stubEnv(WEBHOOK_SECRET_ENV, SECRET);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { t, run } = await world();
    await run();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await jobs(t)).toEqual([]);
    expect((await statusRow(t, "growth"))!.lastFailure).toEqual({ what: "unusable", at: NOW });

    vi.stubEnv(WEBHOOK_URL_ENV, URL);
    vi.stubEnv(WEBHOOK_SECRET_ENV, "");
    await run();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
