import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { BOT_WORDS } from "./lib/botRules";
import { SWEEP_NOTES, SWEEP_WORDS } from "./lib/proposalSweep";
import { AGENT_HEADER, OS_AGENT_WORDS } from "./lib/osAgents";
import { DAY, ENTROPY, NOW, call, ownerWithToken, seed } from "./mcp.kit";
import schema from "./schema";
import { TASK_ARCHIVED } from "./tasks";
import { OWNER, modules } from "./test.setup";

// Notes, comments, archiving a task, reassigning a handoff, and sweeping
// proposals. A bot with write does it at once. One that may only propose
// stores a proposal the owner approves. Made-up titles throughout.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function world() {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  const { owner, token: mac } = await ownerWithToken(t, "act");
  const grok = await owner.mutation(api.assistant.createToken, { entropy: ENTROPY, scope: "act", name: "Grok app" });
  await owner.mutation(api.bots.addSuggested, {});
  // Write on go-to-market only: it may propose, and it may not write a note, a comment, an archive or a reassign.
  await owner.mutation(api.bots.create, {
    botId: "scribe",
    name: "Scribe",
    role: "Notes",
    permissions: [{ area: "gtm", level: "write" }],
  });
  return { t, owner, mac, grok: grok.token, ids };
}

const as = (bot: string) => ({ [AGENT_HEADER]: bot });

async function propose(t: Awaited<ReturnType<typeof world>>["t"], token: string, bot: string, args: Record<string, unknown>) {
  const reply = await call(
    t,
    token,
    "propose",
    { company: "us", why: "Made-up why.", ...args },
    as(bot),
  );
  if (reply.output === null) throw new Error(`propose did not answer: ${reply.text}`);
  return reply.output.id as string;
}

const boardIds = async (owner: Awaited<ReturnType<typeof world>>["owner"]) => {
  const board = await owner.query(api.tasks.board, {});
  return [...board.backlog, ...board.this_week, ...board.doing, ...board.done].map((task) => task.id);
};

async function handoff(t: Awaited<ReturnType<typeof world>>["t"], token: string) {
  const made = await call(
    t,
    token,
    "handoff_create",
    { company: "us", to: "growth", title: "Made-up follow-up on the pricing page", summary: "Ten clinics shortlisted." },
    as("research"),
  );
  if (made.output === null) throw new Error(`handoff_create did not answer: ${made.text}`);
  return made.output.id as string;
}

describe("direct writes", () => {
  test("research writes a note, comments, archives a task and reassigns a handoff", async () => {
    const { t, owner, grok, ids } = await world();
    const handed = await handoff(t, grok);

    const note = await call(
      t,
      grok,
      "note_write",
      { company: "us", title: "Made-up pricing note", body: "Ten clinics asked about the page." },
      as("research"),
    );
    expect(note.output).toMatchObject({ created: true });
    const notes = await call(t, grok, "notes", { company: "us" }, as("research"));
    expect(notes.output.rows).toEqual([
      expect.objectContaining({
        id: note.output.id,
        title: "Made-up pricing note",
        body: "Ten clinics asked about the page.",
        by: "research",
        company: "us",
      }),
    ]);

    const onTask = await call(
      t,
      grok,
      "comment_create",
      { subjectKind: "task", subjectId: ids.usTask, body: "Made-up: the card can come off the board." },
      as("research"),
    );
    expect(onTask.output).toMatchObject({ commentId: expect.any(String) });
    const onHandoff = await call(
      t,
      grok,
      "comment_create",
      { subjectKind: "handoff", subjectId: handed, body: "Made-up: growth has the next step." },
      as("research"),
    );
    expect(onHandoff.output).toMatchObject({ commentId: expect.any(String) });
    const taskComments = await call(t, grok, "comments", { subjectKind: "task", subjectId: ids.usTask }, as("research"));
    expect(taskComments.output.rows).toEqual([
      expect.objectContaining({ body: "Made-up: the card can come off the board.", by: "research", subjectKind: "task" }),
    ]);

    const deal = await call(
      t,
      grok,
      "comment_create",
      { subjectKind: "deal", subjectId: ids.usDeal, body: "Made-up: asked for a demo." },
      as("globex_ai_sales"),
    );
    expect(deal.output).toMatchObject({ commentId: expect.any(String) });
    const dealComments = await owner.query(api.comments.list, { subjectKind: "deal", subjectId: ids.usDeal });
    expect(dealComments).toEqual([expect.objectContaining({ body: "Made-up: asked for a demo.", by: "globex_ai_sales" })]);

    expect(await boardIds(owner)).toContain(ids.usTask);
    const archived = await call(t, grok, "task_archive", { taskId: ids.usTask }, as("research"));
    expect(archived.output).toMatchObject({ taskId: ids.usTask, archived: true });
    expect(await boardIds(owner)).not.toContain(ids.usTask);
    const stored = await t.run((ctx) => ctx.db.get(ids.usTask));
    expect(stored).toMatchObject({ archivedAt: NOW, title: "Example us task" });
    const edit = await owner.mutation(api.tasks.update, { id: ids.usTask, title: "Made-up renamed" }).catch((error: unknown) => error);
    expect(edit).toBeInstanceOf(ConvexError);
    expect(JSON.parse((edit as ConvexError<string>).data)).toBe(TASK_ARCHIVED);

    const moved = await call(t, grok, "handoff_reassign", { handoffId: handed, to: "support", note: "Made-up: support owns it." }, as("research"));
    expect(moved.output).toMatchObject({ handoffId: handed, reassigned: true });
    const rows = (await call(t, grok, "handoffs", {}, as("research"))).output.rows as { id: string; to: string; history: { action: string; by: string }[] }[];
    expect(rows.find((row) => row.id === handed)).toMatchObject({
      to: "support",
      history: [expect.anything(), expect.objectContaining({ action: "reassign", by: "research" })],
    });
  });

  test("a bot comments on a deal only with write on sales, and only proposes what it cannot write", async () => {
    const { t, grok, ids } = await world();
    const deal = await call(
      t,
      grok,
      "comment_create",
      { subjectKind: "deal", subjectId: ids.usDeal, body: "Made-up: asked for a demo." },
      as("growth"),
    );
    expect(deal.said).toBe(BOT_WORDS.notAllowed);
    expect(deal.refusal).toEqual({ code: "not_permitted", tool: "comment_create", area: "sales", need: "write" });

    const note = await call(t, grok, "note_write", { company: "us", title: "Made-up", body: "Made-up body." }, as("growth"));
    expect(note.refusal).toMatchObject({ code: "not_permitted", tool: "note_write", area: "memory", need: "write" });

    // Growth writes the board, so a comment on a task is its own.
    const task = await call(
      t,
      grok,
      "comment_create",
      { subjectKind: "task", subjectId: ids.usTask, body: "Made-up: still on the board." },
      as("growth"),
    );
    expect(task.output).toMatchObject({ commentId: expect.any(String) });

    for (const [name, args] of [
      ["note_write", { company: "us", title: "Made-up", body: "Made-up body." }],
      ["comment_create", { subjectKind: "task", subjectId: ids.usTask, body: "Made-up." }],
      ["task_archive", { taskId: ids.usTask }],
      ["handoff_reassign", { handoffId: ids.usTask, to: "support" }],
    ] as const) {
      const reply = await call(t, grok, name, args, as("scribe"));
      expect(reply.refusal).toMatchObject({ code: "not_permitted", tool: name, need: "write" });
      expect(reply.output).toBeNull();
    }
  });

  test("the Mac chief of staff cannot write a note at once", async () => {
    const { t, mac } = await world();
    const reply = await call(
      t,
      mac,
      "note_write",
      { company: "us", title: "Made-up", body: "Made-up body." },
      { [AGENT_HEADER]: "chief_of_staff" },
    );
    expect(reply.said).toBe(OS_AGENT_WORDS.notAllowedTool("chief_of_staff"));
    expect(reply.output).toBeNull();
  });
});

describe("proposing what a bot cannot write", () => {
  test("a proposal-only bot proposes the four, and the owner's approval carries them out under the bot's name", async () => {
    const { t, owner, grok, ids } = await world();
    const handed = await handoff(t, grok);

    const noteId = await propose(t, grok, "scribe", {
      kind: "memory_note",
      dedupeKey: "scribe:memory_note:pricing",
      payload: { title: "Made-up pricing note", body: "Ten clinics asked about the page." },
    });
    const commentId = await propose(t, grok, "scribe", {
      kind: "comment",
      dedupeKey: "scribe:comment:deal",
      payload: { subjectKind: "deal", subjectId: ids.usDeal, body: "Made-up: asked for a demo." },
    });
    const archiveId = await propose(t, grok, "scribe", {
      company: "kz",
      kind: "task_archive",
      dedupeKey: "scribe:task_archive:kz",
      payload: { taskId: ids.kzTask },
    });
    const reassignId = await propose(t, grok, "scribe", {
      kind: "handoff_reassign",
      dedupeKey: "scribe:handoff_reassign:one",
      payload: { handoffId: handed, to: "support", note: "Made-up: support owns it." },
    });

    for (const id of [noteId, commentId, archiveId, reassignId]) {
      await owner.mutation(api.assistant.approve, { id: id as Id<"proposals"> });
    }

    const notes = await owner.query(api.notes.list, { company: "us" });
    expect(notes).toEqual([
      expect.objectContaining({ title: "Made-up pricing note", body: "Ten clinics asked about the page.", by: "scribe" }),
    ]);
    const comments = await owner.query(api.comments.list, { subjectKind: "deal", subjectId: ids.usDeal });
    expect(comments).toEqual([expect.objectContaining({ body: "Made-up: asked for a demo.", by: "scribe" })]);
    expect(await boardIds(owner)).not.toContain(ids.kzTask);
    const rows = (await call(t, grok, "handoffs", {}, as("research"))).output.rows as { id: string; to: string; history: { by: string }[] }[];
    const moved = rows.find((row) => row.id === handed);
    expect(moved).toMatchObject({ to: "support" });
    expect(moved!.history.at(-1)).toMatchObject({ by: "scribe" });
    expect((await t.run((ctx) => ctx.db.get(noteId as Id<"proposals">)))!.status).toBe("approved");
  });
});

describe("sweeping proposals", () => {
  test("a bot clears only its own, and the chief of staff clears every proposer's, each logged with a reason and no title", async () => {
    const { t, owner, mac, grok, ids } = await world();
    const older = await propose(t, grok, "growth", {
      kind: "task_archive",
      dedupeKey: "growth:task_archive:old",
      payload: { taskId: ids.usTask },
    });
    vi.setSystemTime(NOW + 1_000);
    const newer = await propose(t, grok, "growth", {
      kind: "task_archive",
      dedupeKey: "growth:task_archive:new",
      payload: { taskId: ids.usTask },
    });
    vi.setSystemTime(NOW + 2_000);
    const research = await propose(t, grok, "research", {
      kind: "task_archive",
      dedupeKey: "research:task_archive:same",
      payload: { taskId: ids.usTask },
    });
    // An older open row with research's key: propose itself refuses a second open one.
    await t.run(async (ctx) => {
      const row = await ctx.db.get(research as Id<"proposals">);
      if (row === null) throw new Error("missing");
      const { _id, _creationTime, ...rest } = row;
      await ctx.db.insert("proposals", { ...rest, createdAt: NOW - DAY });
    });

    const own = await call(t, grok, "proposal_sweep", {}, as("growth"));
    expect(own.output).toMatchObject({
      swept: 1,
      more: false,
      results: [{ id: older, keptId: newer, reason: "superseded" }],
    });
    expect(JSON.stringify(own.output)).not.toContain("Example");
    expect((await t.run((ctx) => ctx.db.get(research as Id<"proposals">)))!.status).toBe("open");

    const all = await call(t, mac, "proposal_sweep", { agent: "chief_of_staff" });
    expect(all.output.swept).toBe(2);
    expect(all.output.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keptId: research, reason: "duplicate" }),
        { id: newer, keptId: research, reason: "superseded" },
      ]),
    );
    expect((await t.run((ctx) => ctx.db.get(research as Id<"proposals">)))!.status).toBe("open");
    expect((await t.run((ctx) => ctx.db.get(older as Id<"proposals">)))).toMatchObject({
      status: "withdrawn",
      withdrawReason: "superseded",
      withdrawNote: SWEEP_NOTES.superseded,
      replacedBy: newer,
      withdrawnBy: "bot:growth",
    });

    const logs = await t.run((ctx) => ctx.db.query("proposalSweeps").collect());
    expect(logs.map((row) => row.reason).sort()).toEqual(["duplicate", "superseded", "superseded"]);
    expect(logs.map((row) => row.sweeper).sort()).toEqual(["bot:growth", "chief_of_staff", "chief_of_staff"]);
    for (const log of logs) {
      expect(Object.keys(log).sort()).toEqual(["_creationTime", "_id", "at", "keptId", "proposalId", "reason", "sweeper"]);
    }
    expect(JSON.stringify(logs)).not.toContain("Example");

    // The external chief of staff sweeps a proposal it did not file.
    vi.setSystemTime(NOW + 3_000);
    const left = await propose(t, grok, "growth", {
      kind: "task_archive",
      dedupeKey: "growth:task_archive:later",
      payload: { taskId: ids.sharedTask },
    });
    vi.setSystemTime(NOW + 4_000);
    await propose(t, grok, "growth", {
      kind: "task_archive",
      dedupeKey: "growth:task_archive:latest",
      payload: { taskId: ids.sharedTask },
    });
    await owner.mutation(api.bots.addExternalProfile, { id: "chief_of_staff" });
    const external = await call(t, grok, "proposal_sweep", {}, as("chief_of_staff"));
    expect(external.output.results).toEqual([expect.objectContaining({ id: left, reason: "superseded" })]);
    expect(external.output.results[0].keptId).not.toBe(left);
    const externalLog = (await t.run((ctx) => ctx.db.query("proposalSweeps").collect())).find((row) => row.proposalId === left);
    expect(externalLog).toMatchObject({ sweeper: "bot:chief_of_staff", reason: "superseded" });
  });

  test("the owner's own client is refused, and a company limits whose proposals are cleared", async () => {
    const { t, mac, grok, ids } = await world();
    const refused = await call(t, mac, "proposal_sweep", {});
    expect(refused.said).toBe(SWEEP_WORDS.who);
    expect(refused.output).toBeNull();

    const us = await propose(t, grok, "growth", {
      kind: "task_archive",
      dedupeKey: "growth:task_archive:us",
      payload: { taskId: ids.usTask },
    });
    vi.setSystemTime(NOW + 1_000);
    await propose(t, grok, "growth", {
      kind: "task_archive",
      dedupeKey: "growth:task_archive:us2",
      payload: { taskId: ids.usTask },
    });
    const kz = await propose(t, grok, "growth", {
      company: "kz",
      kind: "task_archive",
      dedupeKey: "growth:task_archive:kz",
      payload: { taskId: ids.kzTask },
    });
    vi.setSystemTime(NOW + 2_000);
    await propose(t, grok, "growth", {
      company: "kz",
      kind: "task_archive",
      dedupeKey: "growth:task_archive:kz2",
      payload: { taskId: ids.kzTask },
    });

    const onlyKz = await call(t, grok, "proposal_sweep", { company: "kz" }, as("growth"));
    expect(onlyKz.output.results).toEqual([expect.objectContaining({ id: kz, reason: "superseded" })]);
    expect((await t.run((ctx) => ctx.db.get(us as Id<"proposals">)))!.status).toBe("open");
  });
});
