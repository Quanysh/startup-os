import { convexTest } from "convex-test";
import { BOT_WORDS } from "./lib/botRules";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  AGENT_IDS,
  AGENT_NAMES,
  AGENT_OFF,
  APPROVED_BLOCKS_DAYS,
  BRIEF_PAGES,
  BRIEF_WORDS,
  DISMISSED_BLOCKS_DAYS,
  FEEDBACK_ROWS,
  MAX_BRIEF_BULLETS,
  MAX_BULLET_LENGTH,
  MAX_DISMISS_REASON_LENGTH,
  MAX_OPEN_PER_AGENT,
  MAX_PROPOSALS_PER_DAY,
  PROPOSAL_EXPIRES_DAYS,
  QUESTION_RETENTION_DAYS,
  PROPOSAL_WORDS,
} from "./lib/agents";
import { AGENT_WORDS } from "./lib/agentRules";
import {
  BOT_TOKEN,
  DAY,
  NEVER,
  NOW,
  SAM,
  TODAY,
  addSam,
  answer,
  call,
  ownerWithToken,
  seed,
} from "./mcp.kit";
import { writeBrief } from "./lib/briefs";
import { OS_AGENT_WORDS } from "./lib/osAgents";
import { finishScheduled } from "./test.timers";
import schema from "./schema";
import { CANNOT_ASSIGN } from "./tasks";
import {
  OWNER,
  modules,
  signInAsCofounder,
  signInAsEngineer,
  signInAsSales,
  type TestBackend,
} from "./test.setup";

// What the owner's agents may write, and what the owner does with it: the
// daily brief, proposals and their approval, questions and their answers,
// and the switch that turns an agent off. Through the endpoint for what a
// model sends, and through the owner's own functions for what the page does.
//
// Every title, name and figure is made up. What must never come back out of
// a refusal or a record carries the word SECRET.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function world(scope: "read" | "act" = "act") {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  const { owner, token } = await ownerWithToken(t, scope);
  const { userId: samId } = await addSam(t);
  const ownerId = (await t.run((ctx) => ctx.db.query("agentTokens").collect()))[0]!.userId;
  return { t, ids, owner, token, samId, ownerId };
}
type World = Awaited<ReturnType<typeof world>>;

const rows = <Table extends "briefs" | "proposals" | "questions" | "tasks" | "agentCalls">(
  t: TestBackend,
  table: Table,
) => t.run((ctx) => ctx.db.query(table).collect());

const forward = (days: number) => vi.setSystemTime(Date.now() + days * DAY);
/** Past the endpoint's ten-minute window, so a test that writes much is not held by the call limit. */
const breathe = () => vi.setSystemTime(Date.now() + 11 * 60_000);

/** A proposal's arguments, with a key of its own unless one is given. */
let made = 0;
const proposal = (kind: string, payload: unknown, extra: Record<string, unknown> = {}) => ({
  agent: "engineering",
  company: "us",
  kind,
  reason: "Made-up reason.",
  // The key begins with its proposer (Bot Loop v3: another's is an attribution mismatch).
  dedupeKey: `${typeof extra.agent === "string" ? extra.agent : "engineering"}:${kind}:made-up-${(made += 1)}`,
  payload,
  ...extra,
});
const propose = async (w: World, kind: string, payload: unknown, extra?: Record<string, unknown>) =>
  (await answer(w.t, w.token, "propose", proposal(kind, payload, extra))).id as Id<"proposals">;
const refusal = async (w: World, args: unknown) => (await call(w.t, w.token, "propose", args)).said;

// ── The agents and their switches ───────────────────────────────────────────

describe("the agents", () => {
  test("there are four, each with a name, and all are on until one is switched off", async () => {
    const { t, owner } = await world();
    const agents = await owner.query(api.assistant.agents, {});
    expect(agents.map((agent) => agent.id)).toEqual([...AGENT_IDS]);
    expect(agents.map((agent) => agent.name)).toEqual([
      "Chief of staff",
      "Engineering manager",
      "Sales and pipeline",
      "Finance and compliance",
    ]);
    expect(agents.every((agent) => agent.on && agent.line.length > 20)).toBe(true);

    await owner.mutation(api.assistant.setAgent, { agent: "sales", on: false });
    expect((await owner.query(api.assistant.agents, {})).filter((a) => !a.on).map((a) => a.id)).toEqual([
      "sales",
    ]);
    await owner.mutation(api.assistant.setAgent, { agent: "sales", on: true });
    expect((await owner.query(api.assistant.agents, {})).every((agent) => agent.on)).toBe(true);
    // One row, whatever was switched.
    expect(await t.run((ctx) => ctx.db.query("agentSettings").collect())).toHaveLength(1);
  });

  test("every write from a switched-off agent is refused in fixed words, and writes nothing", async () => {
    const w = await world();
    const { t, owner, token, ids } = w;
    await owner.mutation(api.assistant.setAgent, { agent: "engineering", on: false });

    // A tool not in the engineering manager's own list is refused first, by that list (convex/lib/osAgents.ts).
    const writes: [string, unknown, string][] = [
      ["brief_write", { agent: "engineering", company: "us", bullets: [{ text: "SECRET line" }] }, OS_AGENT_WORDS.notAllowedTool("engineering")],
      ["propose", proposal("task_create", { title: "SECRET task" }), AGENT_OFF],
      ["propose", proposal("deal_next_step", { dealId: ids.usDeal, nextStep: "SECRET step" }), AGENT_OFF],
      ["task_create", { agent: "engineering", title: "SECRET card" }, OS_AGENT_WORDS.notAllowedTool("engineering")],
    ];
    const before = (await rows(t, "tasks")).length;
    for (const [name, args, words] of writes) {
      const reply = await call(t, token, name, args);
      expect(reply.said, name).toBe(words);
      expect(reply.text).not.toContain("SECRET");
    }
    expect(await rows(t, "briefs")).toEqual([]);
    expect(await rows(t, "proposals")).toEqual([]);
    expect((await rows(t, "tasks")).length).toBe(before);

    // Another agent is not held by it, and nor is a call that names none.
    await answer(t, token, "brief_write", { agent: "chief_of_staff", company: "us", bullets: [{ text: "A line" }] });
    await answer(t, token, "task_create", { title: "A card with no agent" });
    // Back on, it writes again.
    await owner.mutation(api.assistant.setAgent, { agent: "engineering", on: true });
    await answer(t, token, "propose", proposal("task_create", { title: "A task" }));
    expect(await rows(t, "proposals")).toHaveLength(1);
  });

  test("a brief's bullet stamped with a switched-off agent is refused, whoever writes it", async () => {
    const { t, owner, token } = await world();
    await owner.mutation(api.assistant.setAgent, { agent: "finance", on: false });
    const reply = await call(t, token, "brief_write", {
      agent: "chief_of_staff",
      company: "us",
      bullets: [{ text: "One" }, { text: "Two", agent: "finance" }],
    });
    expect(reply.said).toBe(AGENT_OFF);
    expect(await rows(t, "briefs")).toEqual([]);
  });

  test("a switched-off agent writes no brief, even one whose every bullet is stamped with another", async () => {
    const { t, owner, token } = await world();
    await owner.mutation(api.assistant.setAgent, { agent: "chief_of_staff", on: false });
    const reply = await call(t, token, "brief_write", {
      agent: "chief_of_staff",
      company: "us",
      bullets: [{ text: "One", agent: "sales" }, { text: "Two", agent: "finance" }],
    });
    expect(reply.said).toBe(AGENT_OFF);
    expect(await rows(t, "briefs")).toEqual([]);
  });

  test("the brief's own writer holds its limits too, whatever let the call through", async () => {
    // Behind the tool's schema: the function that writes is held to the same numbers.
    const { t } = await world();
    const clock = { now: NOW, today: TODAY };
    const write = (bullets: { text: string; page?: string }[]) =>
      t.run((ctx) => writeBrief(ctx, { agent: "sales", company: "us", bullets }, clock));
    await expect(write([])).rejects.toThrow(BRIEF_WORDS.noBullets);
    await expect(
      write(Array.from({ length: MAX_BRIEF_BULLETS + 1 }, () => ({ text: "x" }))),
    ).rejects.toThrow(BRIEF_WORDS.noBullets);
    await expect(write([{ text: "x".repeat(MAX_BULLET_LENGTH + 1) }])).rejects.toThrow(BRIEF_WORDS.tooLong);
    await expect(write([{ text: "x", page: "https://SECRET.example.com" }])).rejects.toThrow(BRIEF_WORDS.page);
    await expect(write([{ text: "x", page: "/payroll" }])).rejects.toThrow(BRIEF_WORDS.page);
    expect(await rows(t, "briefs")).toEqual([]);
    await write([{ text: "x".repeat(MAX_BULLET_LENGTH), page: "/sales" }]);
    expect(await rows(t, "briefs")).toHaveLength(1);
  });

  test("task_create with an agent stamps the card, and the board says which", async () => {
    const { t, owner, token } = await world();
    // The finance agent may call task_create only once the owner gives it the tool (its published version),
    // and only where each call waits for an approval: on Gemini, never on the Mac (convex/lib/osAgents.ts).
    await t.mutation(internal.osAgents.seed, {});
    await t.run(async (ctx) => {
      const version = (await ctx.db.query("agentHarnessVersions").collect()).find((row) => row.agentId === "finance")!;
      await ctx.db.patch(version._id, { tools: [...(version.tools ?? []), "task_create"] });
      const control = (await ctx.db.query("agentControls").collect()).find((row) => row.agentId === "finance")!;
      await ctx.db.patch(control._id, { runsOn: "gemini" });
    });
    await answer(t, token, "task_create", { title: "Stamped", agent: "finance" });
    await answer(t, token, "task_create", { title: "Plain" });
    const tasks = (await rows(t, "tasks")).filter((task) => task.origin?.source === "agent");
    expect(tasks.map((task) => task.origin)).toEqual([
      { source: "agent", agent: "finance" },
      { source: "agent" },
    ]);
    const board = await owner.query(api.tasks.board, {});
    const origins = Object.fromEntries(board.backlog.map((card) => [card.title, card.origin]));
    expect(origins.Stamped).toEqual({ source: "agent", for: null, agent: "finance" });
    expect(origins.Plain).toEqual({ source: "agent", for: null });
    // A name that is none of the four and no bot of the owner's is refused (convex/bots.test.ts).
    expect((await call(t, token, "task_create", { title: "x", agent: "SECRET" })).said).toBe(BOT_WORDS.unknown);
  });

  test("the audit row carries the agent, and nothing of what was written", async () => {
    const w = await world();
    const { t, token } = w;
    await answer(t, token, "brief_write", {
      agent: "chief_of_staff",
      company: "us",
      bullets: [{ text: "SECRET bullet text" }],
    });
    await propose(w, "draft", { title: "SECRET title", body: "SECRET body" }, { reason: "SECRET reason" });
    await answer(t, token, "brief_latest");
    // A name that is not an agent's is not written down as one.
    await call(t, token, "propose", { ...proposal("draft", { title: "x", body: "y" }), agent: "SECRET agent" });
    const audit = await rows(t, "agentCalls");
    expect(audit.map(({ tool, kind, outcome, agent }) => ({ tool, kind, outcome, agent }))).toEqual([
      { tool: "brief_write", kind: "act", outcome: "ok", agent: "chief_of_staff" },
      { tool: "propose", kind: "act", outcome: "ok", agent: "engineering" },
      { tool: "brief_latest", kind: "read", outcome: "ok", agent: undefined },
      { tool: "propose", kind: "act", outcome: "refused", agent: undefined },
    ]);
    expect(JSON.stringify(audit)).not.toContain("SECRET");
    // The owner reads which agent it was, newest first, and nothing more of a call.
    const listed = await w.owner.query(api.assistant.recentCalls, {});
    expect(listed.map((row) => row.agent)).toEqual([null, null, "engineering", "chief_of_staff"]);
    expect(JSON.stringify(listed)).not.toContain("SECRET");
    for (const row of audit) {
      expect(Object.keys(row).sort()).toEqual(
        [
          "_creationTime", "_id", "at", "client", "clientName", "durationMs", "kind", "outcome", "tool", "userId",
          ...(row.agent ? ["agent"] : []),
          // A refusal's code from a closed set (botRules "Refusal codes"), never text.
          ...(row.refusal ? ["refusal"] : []),
        ].sort(),
      );
    }
  });

  test("a read-only token writes none of it", async () => {
    const { t, owner, token } = await world("read");
    // Named through this client, the chief of staff and engineering are their external profiles: the owner's, switched on.
    await owner.mutation(api.bots.addExternalProfile, { id: "chief_of_staff" });
    await owner.mutation(api.bots.addExternalProfile, { id: "engineering" });
    for (const [name, args] of [
      ["brief_write", { agent: "sales", company: "us", bullets: [{ text: "x" }] }],
      ["propose", proposal("draft", { title: "x", body: "y" })],
    ] as const) {
      expect((await call(t, token, name, args)).said).toBe(AGENT_WORDS.readOnly);
    }
    // And still reads what an earlier run wrote.
    expect((await answer(t, token, "brief_latest")).briefs).toEqual([]);
    expect((await answer(t, token, "proposals_open")).rows).toEqual([]);
    expect((await answer(t, token, "proposals_feedback")).rows).toEqual([]);
  });
});

// ── The brief ───────────────────────────────────────────────────────────────

describe("the brief", () => {
  const write = (w: World, args: Record<string, unknown>) =>
    call(w.t, w.token, "brief_write", { agent: "chief_of_staff", company: "us", ...args });

  test("is stored cleaned, a bullet a line, each stamped with its agent and its page", async () => {
    const w = await world();
    const reply = await write(w, {
      bullets: [
        { text: "  Two pull requests\n\twaited\u0000 over  three days.  ", page: "/engineering", agent: "engineering" },
        { text: "Cash: not read yet.\u202e", page: "/finance" },
        { text: "Hid\u200bden and plain." },
      ],
    });
    expect(reply.output).toEqual({ company: "us", day: TODAY, bullets: 3, replaced: false, truncated: false });
    const brief = await w.owner.query(api.assistant.brief, { company: "us" });
    expect(brief).toEqual({
      company: "us",
      day: TODAY,
      writtenAt: NOW,
      bullets: [
        { agent: "engineering", text: "Two pull requests waited over three days.", page: "/engineering" },
        { agent: "chief_of_staff", text: "Cash: not read yet.", page: "/finance" },
        { agent: "chief_of_staff", text: "Hidden and plain." },
      ],
    });
    expect(await w.owner.query(api.assistant.brief, { company: "kz" })).toBeNull();
  });

  test("markup is kept as the characters it is: nothing reads it as markup or a link", async () => {
    const w = await world();
    const texts = ['<img src=x onerror="alert(1)"><b>Bold</b>', "[A link](https://example.com) and **stars**"];
    await write(w, { bullets: texts.map((text) => ({ text })) });
    const brief = await w.owner.query(api.assistant.brief, { company: "us" });
    expect(brief!.bullets.map((bullet) => bullet.text)).toEqual(texts);
  });

  test("written again for the same day it replaces; another day or company is a row of its own", async () => {
    const w = await world();
    await write(w, { bullets: [{ text: "First" }] });
    forward(1 / 24);
    const again = await write(w, { bullets: [{ text: "Second" }, { text: "Third" }] });
    expect(again.output).toMatchObject({ replaced: true, bullets: 2 });
    expect(await rows(w.t, "briefs")).toHaveLength(1);
    const brief = await w.owner.query(api.assistant.brief, { company: "us" });
    expect(brief!.bullets.map((bullet) => bullet.text)).toEqual(["Second", "Third"]);
    expect(brief!.writtenAt).toBe(NOW + DAY / 24);

    await write(w, { company: "kz", bullets: [{ text: "Other company" }] });
    await write(w, { day: "2026-10-13", bullets: [{ text: "Yesterday" }] });
    expect(await rows(w.t, "briefs")).toHaveLength(3);
    // The latest by day is the one shown.
    expect((await w.owner.query(api.assistant.brief, { company: "us" }))!.day).toBe(TODAY);
  });

  test("the day may be the server's or the day either side, and no further", async () => {
    const w = await world();
    for (const day of ["2026-10-13", "2026-10-14", "2026-10-15"]) {
      expect((await write(w, { day, bullets: [{ text: "x" }] })).output).toMatchObject({ day });
    }
    for (const day of ["2026-10-12", "2026-10-16", "2025-10-14"]) {
      expect((await write(w, { day, bullets: [{ text: "x" }] })).said).toBe(BRIEF_WORDS.dayTooFar);
    }
    expect((await write(w, { day: "14 Oct", bullets: [{ text: "x" }] })).said).toBe(
      "The arguments are not valid. day: is not written the way this field is.",
    );
    expect(await rows(w.t, "briefs")).toHaveLength(3);
  });

  test("its limits are held: bullets, their length, their page, their agent", async () => {
    const w = await world();
    const bullets = (count: number) => Array.from({ length: count }, (_, n) => ({ text: `Line ${n}` }));
    const cases: [Record<string, unknown>, string][] = [
      [{ bullets: [] }, "The arguments are not valid. bullets: is too short or too small."],
      [
        { bullets: bullets(MAX_BRIEF_BULLETS + 1) },
        "The arguments are not valid. bullets: is too long or too large.",
      ],
      [
        { bullets: [{ text: "x".repeat(MAX_BULLET_LENGTH + 1) }] },
        "The arguments are not valid. bullets.0.text: is too long or too large.",
      ],
      [{ bullets: [{ text: " \n\u200b " }] }, BRIEF_WORDS.emptyBullet],
      [
        { bullets: [{ text: "x", page: "https://SECRET.example.com" }] },
        "The arguments are not valid. bullets.0.page: is not one of the values this field takes.",
      ],
      [
        { bullets: [{ text: "x", page: "/payroll" }] },
        "The arguments are not valid. bullets.0.page: is not one of the values this field takes.",
      ],
      [
        { bullets: [{ text: "x", agent: "SECRET" }] },
        "The arguments are not valid. bullets.0.agent: is not one of the values this field takes.",
      ],
      [{ agent: "SECRET", bullets: [{ text: "x" }] }, BOT_WORDS.unknown],
      [{ company: "fr", bullets: [{ text: "x" }] }, "The arguments are not valid. company: is not one of the values this field takes."],
      [
        { bullets: [{ text: "x", link: "https://SECRET.example.com" }] },
        "The arguments are not valid. bullets.0: holds a field this tool does not take.",
      ],
    ];
    for (const [args, words] of cases) {
      const reply = await write(w, args);
      expect(reply.said, JSON.stringify(args).slice(0, 60)).toBe(words);
      expect(reply.text).not.toContain("SECRET");
    }
    expect(await rows(w.t, "briefs")).toEqual([]);
    expect((await write(w, { bullets: bullets(MAX_BRIEF_BULLETS) })).output).toMatchObject({ bullets: 8 });
    for (const page of BRIEF_PAGES) {
      expect((await write(w, { bullets: [{ text: "x", page }] })).output).not.toBeNull();
    }
  });

  test("brief_latest gives a later run what was already said, by company", async () => {
    const w = await world();
    await write(w, { bullets: [{ text: "Startup line", page: "/sales" }] });
    await write(w, { company: "kz", bullets: [{ text: "Globex line" }] });
    const both = await answer(w.t, w.token, "brief_latest");
    expect(both.briefs).toEqual([
      { company: "us", day: TODAY, writtenAt: NOW, bullets: [{ agent: "chief_of_staff", text: "Startup line", page: "/sales" }] },
      { company: "kz", day: TODAY, writtenAt: NOW, bullets: [{ agent: "chief_of_staff", text: "Globex line" }] },
    ]);
    expect(((await answer(w.t, w.token, "brief_latest", { company: "kz" })).briefs as unknown[]).length).toBe(1);
  });

  test("the archive: a company's latest eight days, newest first, judged by no clock", async () => {
    const w = await world();
    const days = Array.from({ length: 10 }, (_, n) => `2026-10-${String(n + 1).padStart(2, "0")}`);
    await w.t.run(async (ctx) => {
      for (const day of days) {
        await ctx.db.insert("briefs", {
          company: "us",
          day,
          writtenAt: Date.parse(`${day}T07:00:00Z`),
          bullets: [{ agent: "finance", text: `Line of ${day}` }],
        });
      }
      await ctx.db.insert("briefs", {
        company: "kz",
        day: "2026-10-10",
        writtenAt: NOW,
        bullets: [{ agent: "sales", text: "Globex's line" }],
      });
    });
    const archive = await w.owner.query(api.assistant.briefArchive, { company: "us" });
    expect(archive.map((brief) => brief.day)).toEqual([...days].reverse().slice(0, 8));
    expect(archive[0]).toEqual({
      company: "us",
      day: "2026-10-10",
      writtenAt: Date.parse("2026-10-10T07:00:00Z"),
      bullets: [{ agent: "finance", text: "Line of 2026-10-10" }],
    });
    expect(JSON.stringify(archive)).not.toContain("Globex's line");
    const kz = await w.owner.query(api.assistant.briefArchive, { company: "kz" });
    expect(kz.map((brief) => brief.bullets[0]!.text)).toEqual(["Globex's line"]);
  });
});

// ── Proposals: what an agent may propose ────────────────────────────────────

describe("propose", () => {
  test("each kind is stored cleaned and open, and proposals_open lists it", async () => {
    const w = await world();
    const { t, ids, token } = w;
    await propose(
      w,
      "task_create",
      { title: "  Review the\u0000 pull request  ", notes: " Line one\r\n\r\n\r\nLine two ", assignee: SAM.toUpperCase(), due: "2026-10-16", column: "this_week" },
      { reason: "  It has waited\n four days.  ", dedupeKey: "engineering:task_create:pr-118" },
    );
    await propose(w, "task_change", { taskId: ids.usTask, assignee: SAM, due: null });
    await propose(w, "deal_next_step", { dealId: ids.usDeal, nextStep: "  Send the pricing  " }, { agent: "sales" });
    await propose(
      w,
      "draft",
      { title: " Follow-up ", body: "Hello,\n\n\n\nA made-up line.\n", about: { type: "deal", id: ids.usDeal } },
      { agent: "sales" },
    );
    const stored = await rows(t, "proposals");
    expect(stored.map(({ agent, kind, company, status, editedBeforeApprove, createdAt }) => ({ agent, kind, company, status, editedBeforeApprove, createdAt }))).toEqual(
      ["engineering", "engineering", "sales", "sales"].map((agent, n) => ({
        agent,
        kind: ["task_create", "task_change", "deal_next_step", "draft"][n],
        company: "us",
        status: "open",
        editedBeforeApprove: false,
        createdAt: NOW,
      })),
    );
    expect(stored[0]).toMatchObject({
      reason: "It has waited four days.",
      dedupeKey: "engineering:task_create:pr-118",
      payload: { title: "Review the pull request", notes: "Line one\n\nLine two", assignee: SAM, due: "2026-10-16", column: "this_week" },
    });
    expect(stored[1]!.payload).toEqual({ taskId: ids.usTask, assignee: SAM, due: null });
    expect(stored[2]!.payload).toEqual({ dealId: ids.usDeal, nextStep: "Send the pricing" });
    expect(stored[3]!.payload).toEqual({
      title: "Follow-up",
      body: "Hello,\n\nA made-up line.",
      about: { type: "deal", id: ids.usDeal },
    });

    const open = (await answer(t, token, "proposals_open")).rows as Record<string, unknown>[];
    expect(open).toHaveLength(4);
    expect(open[0]).toEqual({
      id: stored[0]!._id,
      agent: "engineering",
      kind: "task_create",
      company: "us",
      reason: "It has waited four days.",
      dedupeKey: "engineering:task_create:pr-118",
      createdAt: NOW,
      payload: stored[0]!.payload,
    });
    expect((await answer(t, token, "proposals_open", { company: "kz" })).rows).toEqual([]);
    // Nothing happened: nothing was made, changed or told.
    expect((await rows(t, "tasks")).map((task) => task.title).sort()).toEqual([
      "Example kz task",
      "Example shared task",
      "Example us task",
    ]);
    expect((await t.run((ctx) => ctx.db.get(ids.usDeal)))!.nextStep).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.query("notifications").collect())).filter((row) => row.title !== NEVER.told)).toEqual([]);
  });

  test("a payload is held to the live data when it is proposed", async () => {
    const w = await world();
    const { t, ids } = w;
    const gone = await t.run(async (ctx) => {
      const id = await ctx.db.insert("tasks", { title: "x", kind: "task", column: "backlog", order: 9 });
      await ctx.db.delete(id);
      return id;
    });
    const archived = await t.run((ctx) =>
      ctx.db.insert("deals", { source: "manual", externalId: "a", market: "us", name: "Archived", stage: "lead", order: 9, archivedAt: 1 }),
    );
    const cases: [string, unknown, Record<string, unknown>, string | RegExp][] = [
      ["task_change", { taskId: gone, due: "2026-10-20" }, {}, PROPOSAL_WORDS.taskGone],
      ["task_change", { taskId: "SECRET-not-an-id", due: "2026-10-20" }, {}, PROPOSAL_WORDS.taskGone],
      // An id of another table is not a task's.
      ["task_change", { taskId: ids.usDeal, due: "2026-10-20" }, {}, PROPOSAL_WORDS.taskGone],
      ["task_change", { taskId: ids.kzTask, due: "2026-10-20" }, {}, PROPOSAL_WORDS.taskElsewhere],
      ["task_change", { taskId: ids.usTask }, {}, PROPOSAL_WORDS.nothingToChange],
      // Sam is on Startup alone.
      ["task_change", { taskId: ids.kzTask, assignee: SAM }, { company: "kz" }, PROPOSAL_WORDS.cannotAssign],
      ["task_create", { title: "x", assignee: SAM }, { company: "kz" }, PROPOSAL_WORDS.cannotAssign],
      ["task_create", { title: "x", assignee: "secret.nobody@example.test" }, {}, PROPOSAL_WORDS.cannotAssign],
      ["task_create", { title: "  " }, {}, PROPOSAL_WORDS.title],
      ["task_create", { title: "x", due: "2026-02-31" }, {}, PROPOSAL_WORDS.notADate],
      ["deal_next_step", { dealId: archived, nextStep: "x" }, {}, PROPOSAL_WORDS.dealGone],
      ["deal_next_step", { dealId: ids.usTask, nextStep: "x" }, {}, PROPOSAL_WORDS.dealGone],
      ["deal_next_step", { dealId: ids.kzDeal, nextStep: "x" }, {}, PROPOSAL_WORDS.dealElsewhere],
      ["deal_next_step", { dealId: ids.usDeal, nextStep: " \n " }, {}, PROPOSAL_WORDS.nextStep],
      ["draft", { title: "x", body: " \n " }, {}, PROPOSAL_WORDS.body],
      ["draft", { title: "x", body: "y", about: { type: "deal", id: archived } }, {}, PROPOSAL_WORDS.aboutGone],
      ["draft", { title: "x", body: "y", about: { type: "investor", id: ids.usDeal } }, {}, PROPOSAL_WORDS.aboutGone],
      ["draft", { title: "x", body: "y", about: { type: "customer", id: "SECRET" } }, {}, PROPOSAL_WORDS.aboutGone],
      // The payload of one kind under the name of another.
      ["draft", { title: "x" }, {}, "The arguments are not valid. payload.body: is missing or has the wrong type."],
      ["task_create", { dealId: ids.usDeal, nextStep: "x" }, {}, /^The arguments are not valid\. .*payload: holds a field this tool does not take/],
      ["task_create", { title: "x".repeat(201) }, {}, "The arguments are not valid. payload.title: is too long or too large."],
      ["task_change", { taskId: ids.usTask, column: "SECRET" }, {}, "The arguments are not valid. payload.column: is not one of the values this field takes."],
      ["draft", { title: "x", body: "y", about: { type: "SECRET" } }, {}, "The arguments are not valid. payload.about.type: is not one of the values this field takes."],
      ["task_create", { title: "x" }, { reason: "  " }, PROPOSAL_WORDS.why],
      ["task_create", { title: "x" }, { dedupeKey: "Has Capitals" }, PROPOSAL_WORDS.dedupeKey],
      ["task_create", { title: "x" }, { dedupeKey: "has spaces and SECRET" }, PROPOSAL_WORDS.dedupeKey],
    ];
    for (const [kind, payload, extra, words] of cases) {
      const reply = await call(t, w.token, "propose", proposal(kind, payload, extra));
      const label = `${kind} ${JSON.stringify(payload).slice(0, 50)}`;
      if (typeof words === "string") expect(reply.said, label).toBe(words);
      else expect(reply.said, label).toMatch(words);
      expect(reply.text).not.toMatch(/SECRET|secret\.nobody/);
    }
    expect(await rows(t, "proposals")).toEqual([]);
    // A mirrored deal takes a next step, as on the board; a draft about an update names nothing.
    await propose(w, "deal_next_step", { dealId: ids.kzDeal, nextStep: "Call" }, { company: "kz", agent: "sales" });
    await propose(w, "draft", { title: "Update", body: "Text", about: { type: "update" } });
    await propose(w, "draft", { title: "About a fund", body: "Text", about: { type: "investor", id: ids.investor } });
    // A shared task may be changed from either company.
    await propose(w, "task_change", { taskId: ids.sharedTask, column: "doing" }, { company: "kz" });
    expect(await rows(t, "proposals")).toHaveLength(4);
  });

  test("a key that is open is a repeat; one dismissed stays one for thirty days, one approved for fourteen", async () => {
    const w = await world();
    const { owner } = w;
    const key = { dedupeKey: "engineering:task_create:pr-7" };
    const again = () => refusal(w, proposal("task_create", { title: "Again" }, key));

    const first = await propose(w, "task_create", { title: "First" }, key);
    expect(await again()).toBe(PROPOSAL_WORDS.repeatOpen);
    // Another key is not held by it.
    await propose(w, "task_create", { title: "Other" }, { dedupeKey: "engineering:task_create:pr-8" });

    await owner.mutation(api.assistant.dismiss, { id: first, code: "wrong_timing" });
    expect(await again()).toBe(PROPOSAL_WORDS.repeatDismissed);
    forward(DISMISSED_BLOCKS_DAYS - 1);
    expect(await again()).toBe(PROPOSAL_WORDS.repeatDismissed);
    forward(2);
    const second = await propose(w, "task_create", { title: "Second" }, key);

    await owner.mutation(api.assistant.approve, { id: second });
    expect(await again()).toBe(PROPOSAL_WORDS.repeatApproved);
    forward(APPROVED_BLOCKS_DAYS - 1);
    expect(await again()).toBe(PROPOSAL_WORDS.repeatApproved);
    forward(2);
    const third = await propose(w, "task_create", { title: "Third" }, key);

    // One that expired undecided blocks its key as a dismissal does (Approvals v2), for thirty days.
    forward(PROPOSAL_EXPIRES_DAYS + 1);
    await w.t.mutation(internal.assistant.sweep, {});
    expect((await w.t.run((ctx) => ctx.db.get(third)))!.status).toBe("expired");
    expect(await again()).toBe(PROPOSAL_WORDS.repeatExpired);
    forward(DISMISSED_BLOCKS_DAYS + 1);
    await propose(w, "task_create", { title: "Fourth" }, key);
  });

  test("an agent may have twenty open, and forty are made in a day by all of them", async () => {
    const w = await world();
    for (let n = 0; n < MAX_OPEN_PER_AGENT; n++) await propose(w, "draft", { title: `T${n}`, body: "b" });
    breathe();
    expect(await refusal(w, proposal("draft", { title: "x", body: "b" }))).toBe(PROPOSAL_WORDS.tooManyOpen);
    // Another agent has its own twenty.
    for (let n = 0; n < MAX_OPEN_PER_AGENT; n++) {
      await propose(w, "draft", { title: `S${n}`, body: "b" }, { agent: "sales" });
    }
    expect(await rows(w.t, "proposals")).toHaveLength(MAX_PROPOSALS_PER_DAY);
    expect(await refusal(w, proposal("draft", { title: "x", body: "b" }, { agent: "finance" }))).toBe(
      PROPOSAL_WORDS.tooManyToday,
    );
    // The next UTC day there is room again, for an agent with fewer than twenty open.
    forward(1);
    await propose(w, "draft", { title: "x", body: "b" }, { agent: "finance" });
    // Deciding one frees a place for the agent that was full.
    expect(await refusal(w, proposal("draft", { title: "x", body: "b" }))).toBe(PROPOSAL_WORDS.tooManyOpen);
    const [one] = await rows(w.t, "proposals");
    await w.owner.mutation(api.assistant.dismiss, { id: one!._id, code: "wrong_timing" });
    await propose(w, "draft", { title: "x", body: "b" });
  });

  test("proposals_feedback is the last thirty decided, with the owner's reason and no payload", async () => {
    const w = await world();
    const { t, owner, token } = w;
    const ids: Id<"proposals">[] = [];
    for (let n = 0; n < 17; n++) {
      ids.push(await propose(w, "draft", { title: `SECRET title ${n}`, body: "SECRET body" }, { reason: "SECRET reason", dedupeKey: `engineering:draft:deal-${n}` }));
    }
    for (const [n, id] of ids.entries()) {
      vi.setSystemTime(NOW + (n + 1) * 60_000);
      if (n % 2 === 0) await owner.mutation(api.assistant.dismiss, n === 0 ? { id, reason: "  Not now  " } : { id, code: "wrong_timing" });
      else await owner.mutation(api.assistant.approve, { id });
    }
    const feedback = (await answer(t, token, "proposals_feedback")).rows as Record<string, unknown>[];
    expect(feedback).toHaveLength(17);
    // Newest decision first.
    expect(feedback[0]).toEqual({
      agent: "engineering",
      kind: "draft",
      company: "us",
      dedupeKey: "engineering:draft:deal-16",
      status: "dismissed",
      decision: "rejected",
      rejectCode: "wrong_timing",
      rejectReason: null,
      dismissReason: null,
      decidedAt: NOW + 17 * 60_000,
      decisionMs: expect.any(Number),
      edited: false,
      edits: [],
      urgency: "normal",
      goal: null,
      bot: null,
      rejection: { kind: "draft", code: "wrong_timing", reason: null },
      // What approving made, for a kind that makes something (deal_create's new deal): none here.
      createdId: null,
      // Withdrawn by its proposer (spec §14): null on every other row.
      withdrawReason: null,
      withdrawNote: null,
      replacedBy: null,
      // A click in the app: the chat decision's three fields stay empty.
      decidedBy: null,
      via: null,
      decisionReason: null,
    });
    expect(feedback.at(-1)).toMatchObject({ dedupeKey: "engineering:draft:deal-0", dismissReason: "Not now" });
    expect(feedback[1]).toMatchObject({ status: "approved", dismissReason: null });
    expect(JSON.stringify(feedback)).not.toContain("SECRET");
    expect(FEEDBACK_ROWS).toBe(30);
    expect((await answer(t, token, "proposals_feedback", { company: "kz" })).rows).toEqual([]);
    // An open one is not feedback.
    await propose(w, "draft", { title: "x", body: "y" });
    expect(((await answer(t, token, "proposals_feedback")).rows as unknown[]).length).toBe(17);
  });
});

// ── Proposals: what the owner does with one ─────────────────────────────────

/** Who was told what, without the actor: what a person's own action is compared by. */
const told = (t: TestBackend) =>
  t.run(async (ctx) =>
    (await ctx.db.query("notifications").collect())
      .filter((row) => row.title !== NEVER.told)
      .map((row) => ({
        to: row.recipient,
        kind: row.kind,
        title: row.title,
        company: row.company ?? null,
        column: row.column ?? null,
        due: row.due ?? null,
      })),
  );
const actors = (t: TestBackend) =>
  t.run(async (ctx) =>
    (await ctx.db.query("notifications").collect())
      .filter((row) => row.title !== NEVER.told)
      .map((row) => row.actor),
  );
const named = (list: Awaited<ReturnType<typeof told>>, sam: string) =>
  list.map((row) => ({ ...row, to: row.to === sam ? "sam" : "someone else" }));

describe("approve", () => {
  test("a new task is the one the app would make, as the owner, marked as that agent's", async () => {
    const w = await world();
    const { t, owner, ownerId } = w;
    const id = await propose(w, "task_create", {
      title: "Review the pull request",
      notes: "It waited four days.",
      assignee: SAM,
      due: "2026-10-16",
      column: "this_week",
    });
    forward(1 / 24);
    const result = await owner.mutation(api.assistant.approve, { id });
    const task = (await rows(t, "tasks")).find((row) => row.title === "Review the pull request")!;
    expect(result).toEqual({ taskId: task._id });
    expect(task).toMatchObject({
      notes: "It waited four days.",
      assignee: SAM,
      due: "2026-10-16",
      column: "this_week",
      company: "us",
      kind: "task",
      createdBy: ownerId,
      origin: { source: "agent", agent: "engineering" },
    });
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
      status: "approved",
      decidedAt: NOW + DAY / 24,
      result: { taskId: task._id },
      editedBeforeApprove: false,
    });
  });

  test("it tells exactly who the owner's own change would tell, never the owner, and says Claude did it", async () => {
    // The same four changes twice: approved from proposals, and made by the owner on the board.
    // With a bot token, a task given to someone schedules the announcement. Every timer is
    // faked so the queue can be read and then run out (it finds no group picked and sends
    // nothing); Telegram is never asked.
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", BOT_TOKEN);
    const asked = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", asked);
    const byAgent = await world();
    {
      const w = byAgent;
      const create = await propose(w, "task_create", { title: "Call the clinic", assignee: SAM });
      const { taskId } = (await w.owner.mutation(api.assistant.approve, { id: create })) as { taskId: Id<"tasks"> };
      for (const change of [{ due: "2026-10-21" }, { column: "doing" }, { assignee: null, column: "done" }] as const) {
        const id = await propose(w, "task_change", { taskId, ...change });
        await w.owner.mutation(api.assistant.approve, { id });
      }
      // The owner's own task: nobody to tell.
      const own = await propose(w, "task_create", { title: "The owner's own", assignee: OWNER });
      await w.owner.mutation(api.assistant.approve, { id: own });
    }
    const scheduled = (t: TestBackend) =>
      t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).map((job) => job.name));
    // One backend at a time: each is read before the next is made.
    const agentTold = named(await told(byAgent.t), byAgent.samId);
    const agentActors = await actors(byAgent.t);
    const agentScheduled = await scheduled(byAgent.t);
    await finishScheduled(byAgent.t);

    const byPerson = await world();
    {
      const { owner } = byPerson;
      const taskId = await owner.mutation(api.tasks.create, { title: "Call the clinic", assignee: SAM, company: "us" });
      await owner.mutation(api.tasks.update, { id: taskId, due: "2026-10-21" });
      await owner.mutation(api.tasks.move, { id: taskId, column: "doing", index: 0 });
      await owner.mutation(api.tasks.update, { id: taskId, assignee: null, column: "done" });
      await owner.mutation(api.tasks.create, { title: "The owner's own", assignee: OWNER, company: "us" });
    }
    expect(agentTold).toEqual(named(await told(byPerson.t), byPerson.samId));
    expect(agentTold.map((row) => `${row.to}: ${row.kind}`)).toEqual([
      "sam: assigned",
      "sam: due",
      "sam: moved",
      "sam: unassigned",
    ]);
    // Said to be the owner's Claude, for that owner, who is told nothing of it.
    expect(agentActors).toEqual(
      Array.from({ length: 4 }, () => ({ type: "agent", userId: byAgent.ownerId })),
    );
    expect(await actors(byPerson.t)).toEqual(
      Array.from({ length: 4 }, () => ({ type: "user", userId: byPerson.ownerId })),
    );
    // The Telegram announcement: once, for the task given to Sam, in both.
    const personScheduled = await scheduled(byPerson.t);
    await finishScheduled(byPerson.t);
    expect(agentScheduled).toEqual(["telegram:notify"]);
    expect(agentScheduled).toEqual(personScheduled);
    expect(asked).not.toHaveBeenCalled();
  });

  test("a change to a task changes what it names and nothing else; null clears", async () => {
    const w = await world();
    const { t, ids, owner } = w;
    await t.run((ctx) => ctx.db.patch(ids.usTask, { assignee: SAM, due: "2026-10-20", notes: "Kept" }));
    const id = await propose(w, "task_change", { taskId: ids.usTask, assignee: null, due: null, column: "doing" });
    expect(await owner.mutation(api.assistant.approve, { id })).toEqual({ taskId: ids.usTask });
    const task = (await t.run((ctx) => ctx.db.get(ids.usTask)))!;
    expect(task).toMatchObject({ title: "Example us task", notes: "Kept", column: "doing" });
    expect([task.assignee, task.due]).toEqual([undefined, undefined]);
    // The card was not the agent's and is not made its own.
    expect(task.origin).toBeUndefined();
  });

  test("a next step is set on the deal, a mirrored one included, and nothing else of it changes", async () => {
    const w = await world();
    const { t, ids, owner } = w;
    const before = (await t.run((ctx) => ctx.db.get(ids.kzDeal)))!;
    const id = await propose(w, "deal_next_step", { dealId: ids.kzDeal, nextStep: "Call on Monday" }, { company: "kz", agent: "sales" });
    expect(await owner.mutation(api.assistant.approve, { id })).toEqual({ dealId: ids.kzDeal });
    expect(await t.run((ctx) => ctx.db.get(ids.kzDeal))).toEqual({ ...before, nextStep: "Call on Monday" });
  });

  test("a draft is only kept: nothing is made, changed, told or scheduled", async () => {
    const w = await world();
    const { t, owner } = w;
    const snapshot = async () =>
      JSON.stringify(
        await t.run(async (ctx) => [
          await ctx.db.query("tasks").collect(),
          await ctx.db.query("deals").collect(),
          await ctx.db.query("investors").collect(),
          await ctx.db.query("notifications").collect(),
          await ctx.db.system.query("_scheduled_functions").collect(),
        ]),
      );
    const id = await propose(w, "draft", { title: "Follow-up", body: "Hello" }, { agent: "sales" });
    const before = await snapshot();
    expect(await owner.mutation(api.assistant.approve, { id })).toEqual({ kept: true });
    expect(await snapshot()).toBe(before);
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "approved", result: { kept: true } });
  });

  test("what no longer applies at the click is refused with a sentence, and the proposal stays open", async () => {
    const w = await world();
    const { t, ids, owner } = w;
    const change = await propose(w, "task_change", { taskId: ids.usTask, due: "2026-10-20" });
    const step = await propose(w, "deal_next_step", { dealId: ids.usDeal, nextStep: "Call" });
    const give = await propose(w, "task_create", { title: "For Sam", assignee: SAM });
    const reassign = await propose(w, "task_change", { taskId: ids.sharedTask, assignee: SAM });
    const moved = await propose(w, "task_change", { taskId: ids.sharedTask, column: "doing" });

    await t.run(async (ctx) => {
      await ctx.db.delete(ids.usTask);
      await ctx.db.patch(ids.usDeal, { archivedAt: 1 });
      // Sam leaves the team; the shared task goes to the other company.
      const row = (await ctx.db.query("members").collect()).find((member) => member.email === SAM)!;
      await ctx.db.delete(row._id);
      await ctx.db.patch(ids.sharedTask, { company: "kz" });
    });
    const tasksBefore = JSON.stringify(await rows(t, "tasks"));
    for (const [id, words] of [
      [change, PROPOSAL_WORDS.taskGone],
      [step, PROPOSAL_WORDS.dealGone],
      [give, PROPOSAL_WORDS.cannotAssign],
      [reassign, PROPOSAL_WORDS.taskElsewhere],
      [moved, PROPOSAL_WORDS.taskElsewhere],
    ] as const) {
      await expect(owner.mutation(api.assistant.approve, { id })).rejects.toThrow(words);
      expect((await t.run((ctx) => ctx.db.get(id)))!.status).toBe("open");
    }
    expect(JSON.stringify(await rows(t, "tasks"))).toBe(tasksBefore);
    expect(await told(t)).toEqual([]);
    // The app's own refusal is the last word where the two checks differ.
    expect(CANNOT_ASSIGN).toBe("That person cannot be given this task.");
  });

  test("edited first, it does what the edit says and is marked as edited", async () => {
    const w = await world();
    const { t, ids, owner } = w;
    const create = await propose(w, "task_create", { title: "Model's title", due: "2026-10-16" });
    await owner.mutation(api.assistant.approve, {
      id: create,
      edit: { title: "  The owner's title  ", assignee: SAM, column: "doing" },
    });
    const task = (await rows(t, "tasks")).find((row) => row.title === "The owner's title")!;
    // The whole payload is the edit's: the date the form dropped is gone.
    expect(task).toMatchObject({ assignee: SAM, column: "doing" });
    expect(task.due).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.get(create))).toMatchObject({
      editedBeforeApprove: true,
      payload: { title: "The owner's title", assignee: SAM, column: "doing" },
    });

    const step = await propose(w, "deal_next_step", { dealId: ids.usDeal, nextStep: "Call" });
    await owner.mutation(api.assistant.approve, { id: step, edit: { dealId: ids.usDeal, nextStep: "Email instead" } });
    expect((await t.run((ctx) => ctx.db.get(ids.usDeal)))!.nextStep).toBe("Email instead");

    const draft = await propose(w, "draft", { title: "T", body: "Model's text", about: { type: "update" } });
    await owner.mutation(api.assistant.approve, { id: draft, edit: { title: "T", body: "Owner's text" } });
    // What a draft is about is not the form's to drop.
    expect((await t.run((ctx) => ctx.db.get(draft)))!.payload).toEqual({
      title: "T",
      body: "Owner's text",
      about: { type: "update" },
    });

    // The same thing sent back is not an edit.
    const same = await propose(w, "task_change", { taskId: ids.usTask, due: "2026-10-20" });
    await owner.mutation(api.assistant.approve, { id: same, edit: { taskId: ids.usTask, due: "2026-10-20" } });
    expect((await t.run((ctx) => ctx.db.get(same)))!.editedBeforeApprove).toBe(false);
  });

  test("an edit is held to the proposal's kind, its target and the live data", async () => {
    const w = await world();
    const { t, ids, owner } = w;
    const change = await propose(w, "task_change", { taskId: ids.usTask, due: "2026-10-20" });
    const step = await propose(w, "deal_next_step", { dealId: ids.usDeal, nextStep: "Call" });
    const create = await propose(w, "task_create", { title: "A task" });
    const refused = async (id: Id<"proposals">, edit: unknown, words: string) => {
      await expect(owner.mutation(api.assistant.approve, { id, edit: edit as never })).rejects.toThrow(words);
      expect((await t.run((ctx) => ctx.db.get(id)))!.status).toBe("open");
    };
    await refused(change, { taskId: ids.sharedTask, due: "2026-10-20" }, PROPOSAL_WORDS.fixedField);
    await refused(step, { dealId: ids.kzDeal, nextStep: "Call" }, PROPOSAL_WORDS.fixedField);
    await refused(change, { title: "A draft", body: "Text" }, PROPOSAL_WORDS.payload);
    await refused(create, { dealId: ids.usDeal, nextStep: "x" }, PROPOSAL_WORDS.payload);
    await refused(change, { taskId: ids.usTask }, PROPOSAL_WORDS.nothingToChange);
    await refused(create, { title: "x", assignee: "nobody@example.test" }, PROPOSAL_WORDS.cannotAssign);
    await refused(create, { title: "  " }, PROPOSAL_WORDS.title);
    await refused(create, { title: "x", due: "tomorrow" }, PROPOSAL_WORDS.notADate);
    expect((await rows(t, "tasks")).length).toBe(3);
  });

  test("one already decided, or gone, is refused; a dismissal keeps the owner's reason", async () => {
    const w = await world();
    const { t, owner } = w;
    const one = await propose(w, "draft", { title: "x", body: "y" });
    const two = await propose(w, "task_create", { title: "Never made" });
    await owner.mutation(api.assistant.approve, { id: one });
    await expect(owner.mutation(api.assistant.approve, { id: one })).rejects.toThrow(PROPOSAL_WORDS.decided);
    await expect(owner.mutation(api.assistant.dismiss, { id: one })).rejects.toThrow(PROPOSAL_WORDS.decided);

    await expect(
      owner.mutation(api.assistant.dismiss, { id: two, reason: "x".repeat(MAX_DISMISS_REASON_LENGTH + 1) }),
    ).rejects.toThrow(`That reason is too long (${MAX_DISMISS_REASON_LENGTH} characters at most).`);
    forward(1 / 24);
    await owner.mutation(api.assistant.dismiss, { id: two, reason: "  Already\u0000 done by hand  " });
    expect(await t.run((ctx) => ctx.db.get(two))).toMatchObject({
      status: "dismissed",
      rejectReason: "Already done by hand",
      decidedAt: NOW + DAY / 24,
    });
    expect((await t.run((ctx) => ctx.db.get(two)))!.result).toBeUndefined();
    await expect(owner.mutation(api.assistant.approve, { id: two })).rejects.toThrow(PROPOSAL_WORDS.decided);
    expect((await rows(t, "tasks")).map((task) => task.title)).not.toContain("Never made");

    await t.run((ctx) => ctx.db.delete(two));
    await expect(owner.mutation(api.assistant.approve, { id: two })).rejects.toThrow(PROPOSAL_WORDS.gone);
    await expect(owner.mutation(api.assistant.dismiss, { id: two })).rejects.toThrow(PROPOSAL_WORDS.gone);
  });
});

describe("the sweep", () => {
  test("an open proposal older than seven days is marked expired; nothing else is touched", async () => {
    const w = await world();
    const { t, owner } = w;
    const old = await propose(w, "draft", { title: "Old", body: "b" });
    const decided = await propose(w, "draft", { title: "Decided", body: "b" });
    await owner.mutation(api.assistant.dismiss, { id: decided, code: "wrong_timing" });
    forward(PROPOSAL_EXPIRES_DAYS - 1);
    const young = await propose(w, "draft", { title: "Young", body: "b" });
    await t.mutation(internal.assistant.sweep, {});
    expect((await t.run((ctx) => ctx.db.get(old)))!.status).toBe("open");

    forward(2);
    await t.mutation(internal.assistant.sweep, {});
    const now = Date.now();
    expect(await t.run((ctx) => ctx.db.get(old))).toMatchObject({ status: "expired", decidedAt: now });
    expect((await t.run((ctx) => ctx.db.get(young)))!.status).toBe("open");
    expect((await t.run((ctx) => ctx.db.get(decided)))!.status).toBe("dismissed");
    // An expired one cannot be approved after the fact.
    await expect(owner.mutation(api.assistant.approve, { id: old })).rejects.toThrow(PROPOSAL_WORDS.decided);
    // And it takes no arguments: nothing typed is ever a scheduled function's argument.
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    for (const job of jobs) expect(JSON.stringify(job.args)).not.toMatch(/Old|Young|Decided/);
  });

  test("questions left from the removed Ask age out, answered or not", async () => {
    const { t } = await world();
    const ask = (text: string, answered: boolean) =>
      t.run((ctx) =>
        ctx.db.insert("questions", {
          company: "us",
          text,
          askedAt: Date.now(),
          ...(answered ? { answer: "An answer.", answeredAt: Date.now(), agent: "chief_of_staff" as const } : null),
        }),
      );
    await ask("Old, waiting?", false);
    await ask("Old, answered?", true);
    forward(QUESTION_RETENTION_DAYS + 1);
    const young = await ask("Young?", false);
    await t.mutation(internal.assistant.sweep, {});
    expect((await t.run((ctx) => ctx.db.query("questions").collect())).map((row) => row._id)).toEqual([young]);
  });
});

describe("the owner's list of proposals", () => {
  test("open ones with what each is about, both companies and one count; what became of the rest, 30 days back", async () => {
    const w = await world();
    const { t, ids, owner, ownerId } = w;
    await t.run((ctx) => ctx.db.patch(ownerId, { name: "Olga Owner" }));
    const change = await propose(w, "task_change", { taskId: ids.usTask, assignee: SAM });
    await propose(w, "deal_next_step", { dealId: ids.usDeal, nextStep: "Call" }, { agent: "sales" });
    await propose(w, "task_create", { title: "For the owner", assignee: OWNER });
    await propose(w, "draft", { title: "KZ draft", body: "b" }, { company: "kz", agent: "sales" });

    // One list of both companies: the page, its count, Today and the Bots tab read it so.
    const listed = await owner.query(api.assistant.inbox, {});
    expect(listed).toHaveLength(4);
    const byId = (id: string) => listed.find((row) => row.id === id)!;
    expect(byId(change)).toMatchObject({
      source: "proposal",
      agent: "engineering",
      kind: "task_change",
      company: "us",
      why: "Made-up reason.",
      payload: { taskId: ids.usTask, assignee: SAM },
      about: { task: "Example us task", deal: null, assignee: "Sam Teammate" },
    });
    expect(listed.find((row) => row.kind === "task_create")!.about).toEqual({ task: null, deal: null, assignee: "Olga Owner" });
    expect(listed.find((row) => row.kind === "deal_next_step")!.about).toEqual({ task: null, deal: "Example US Deal", assignee: null });
    expect((await owner.query(api.assistant.inbox, { company: "kz" })).map((row) => row.kind)).toEqual(["draft"]);
    expect(await owner.query(api.assistant.decided, { since: 0 })).toEqual([]);

    // A target that has gone reads as gone, not as an error.
    await t.run((ctx) => ctx.db.delete(ids.usTask));
    expect((await owner.query(api.assistant.inbox, {})).find((row) => row.id === change)!.about!.task).toBeNull();

    for (let n = 0; n < 12; n++) {
      const id = await propose(w, "draft", { title: `Draft ${n}`, body: "b" });
      vi.setSystemTime(NOW + (n + 1) * 60_000);
      if (n % 2 === 0) await owner.mutation(api.assistant.approve, { id });
      else await owner.mutation(api.assistant.dismiss, { id, reason: "No", code: "wrong_timing" });
    }
    const decided = await owner.query(api.assistant.decided, { since: 0 });
    expect(decided).toHaveLength(12);
    expect(decided[0]).toMatchObject({
      source: "proposal",
      kind: "draft",
      status: "dismissed",
      rejectCode: "wrong_timing",
      rejectReason: "No",
      result: null,
      edited: false,
      payload: { title: "Draft 11", body: "b" },
    });
    expect(decided[1]).toMatchObject({ status: "approved", result: { kept: true } });
    // `since` is the page's: nothing decided before it.
    expect(await owner.query(api.assistant.decided, { since: NOW + 12 * 60_000 })).toHaveLength(1);
    expect(await owner.query(api.assistant.inbox, {})).toHaveLength(4);
  });
});

// ── Questions ───────────────────────────────────────────────────────────────

describe("the week's counts", () => {
  test("briefs, proposals made and tasks by agents since a moment", async () => {
    const w = await world();
    const { t, owner, token } = w;
    // Before the week: counted by none of it.
    await answer(t, token, "brief_write", { agent: "chief_of_staff", company: "us", bullets: [{ text: "Old" }] });
    const old = await propose(w, "task_create", { title: "Old task" });
    await owner.mutation(api.assistant.approve, { id: old });
    forward(3);
    const since = Date.now();

    await answer(t, token, "brief_write", { agent: "chief_of_staff", company: "us", bullets: [{ text: "New" }] });
    await answer(t, token, "brief_write", { agent: "chief_of_staff", company: "kz", bullets: [{ text: "New" }] });
    const one = await propose(w, "task_create", { title: "New task" });
    const two = await propose(w, "draft", { title: "x", body: "y" });
    await propose(w, "draft", { title: "x", body: "y" });
    await owner.mutation(api.assistant.approve, { id: one });
    await owner.mutation(api.assistant.dismiss, { id: two, code: "wrong_timing" });
    await answer(t, token, "task_create", { title: "Made directly" });
    await owner.mutation(api.tasks.create, { title: "The owner's own" });

    expect(await owner.query(api.assistant.measure, { since })).toEqual({
      briefs: 2,
      proposed: 3,
      tasks: 2,
      // The owner and Sam on Startup; the owner alone on Globex. (A row with
      // no sign-in, tg.teammate, is on Startup too.)
      people: { us: 3, kz: 1 },
    });
    expect(await owner.query(api.assistant.measure, { since: 0 })).toMatchObject({
      briefs: 3,
      proposed: 4,
      tasks: 3,
    });
  });
});

describe("names and text stay out of what is thrown and recorded", () => {
  test("no refusal of an owner function quotes what was typed", async () => {
    const w = await world();
    const { owner } = w;
    const id = await propose(w, "task_create", { title: "A task" });
    const said: string[] = [];
    for (const attempt of [
      () => owner.mutation(api.assistant.dismiss, { id, reason: `SECRET ${"x".repeat(300)}` }),
      () => owner.mutation(api.assistant.approve, { id, edit: { title: "SECRET", assignee: "secret.person@example.test" } }),
      () => owner.mutation(api.assistant.approve, { id, edit: { title: "SECRET", due: "SECRET day" } }),
    ]) {
      said.push(await attempt().then(() => "", (error: unknown) => String(error)));
    }
    expect(said.every((line) => line !== "")).toBe(true);
    expect(said.join("\n")).not.toMatch(/SECRET|secret\.person/);
    expect(AGENT_NAMES.finance).toBe("Finance and compliance");
  });
});

describe("only the owner", () => {
  test("a co-founder, a salesperson, an engineer and a stranger are refused, told nothing, and change nothing", async () => {
    const w = await world();
    const { t } = w;
    const id = await propose(w, "task_create", { title: "SECRET task" }, { reason: "SECRET reason" });
    await answer(t, w.token, "brief_write", { agent: "chief_of_staff", company: "us", bullets: [{ text: "SECRET bullet" }] });
    const state = async () =>
      JSON.stringify([
        await rows(t, "proposals"),
        await rows(t, "briefs"),
        await rows(t, "tasks"),
        await t.run((ctx) => ctx.db.query("agentSettings").collect()),
      ]);
    const before = await state();
    type Caller = Awaited<ReturnType<typeof signInAsCofounder>>;
    const callers: Caller[] = [
      await signInAsCofounder(t),
      await signInAsSales(t),
      await signInAsEngineer(t),
      t as unknown as Caller,
    ];
    for (const caller of callers) {
      const attempts = [
        () => caller.query(api.assistant.brief, { company: "us" }),
        () => caller.query(api.assistant.briefArchive, { company: "us" }),
        () => caller.query(api.assistant.inbox, {}),
        () => caller.query(api.assistant.decided, { since: 0 }),
        () => caller.query(api.assistant.agents, {}),
        () => caller.query(api.assistant.measure, { since: 0 }),
        () => caller.mutation(api.assistant.approve, { id }),
        () => caller.mutation(api.assistant.dismiss, { id, reason: "x" }),
        () => caller.mutation(api.assistant.setAgent, { agent: "sales", on: false }),
      ];
      for (const attempt of attempts) {
        const said = await attempt().then(
          (value) => JSON.stringify(value),
          (error: unknown) => String(error),
        );
        expect(said).toContain("not_owner");
        expect(said).not.toContain("SECRET");
      }
    }
    expect(await state()).toBe(before);
  });
});
