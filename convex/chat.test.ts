import { convexTest } from "convex-test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { BOT_OWN_TOOLS } from "./lib/botRules";
import type { Id } from "./_generated/dataModel";
import { AGENT_WORDS, MAX_CALLS_PER_WINDOW } from "./lib/agentRules";
import { PROPOSAL_WORDS } from "./lib/agents";
import {
  CHAT_CLAIM_MS,
  CHAT_DENIED_TOOLS,
  CHAT_FAILURES,
  CHAT_HISTORY_BYTES,
  CHAT_HISTORY_MESSAGES,
  CHAT_PAGES,
  CHAT_READ_TOOLS,
  CHAT_RETENTION_DAYS,
  CHAT_TOOLS,
  CHAT_WORDS,
  MAX_CHAT_ANSWER_LENGTH,
  MAX_CHAT_PROPOSALS,
  MAX_CHAT_QUESTIONS_PER_DAY,
  MAX_CHAT_QUESTION_LENGTH,
  MAX_CHAT_STEPS,
  MAX_RUNNER_CALLS_PER_WINDOW,
  MAX_THREAD_MESSAGES,
  MAX_THREAD_TITLE_LENGTH,
  RUNNER_FAILURES,
  RUNNER_FRESH_MS,
  RUNNER_TOOLS,
  STEP_LABELS,
  knownSteps,
  runnerIsThere,
} from "./lib/chatRules";
import { TOOLS, toolsFor } from "./lib/mcpTools";
import { DAY, NOW, TODAY, call, calls, ownerWithToken, rpc, seed } from "./mcp.kit";
import schema from "./schema";
import { OWNER, modules } from "./test.setup";
import { PAGE_AREAS } from "../src/lib/nav";

// The owner's live chat: a question waits in the OS, the runner on the
// owner's Mac claims it through three tools of POST /mcp/v1, and Claude Code
// there writes the answer. Nothing here calls a model, and no test does.
//
// Every question, answer and title is made up.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const RUNNER = "runner-aaaa-0001";
const OTHER = "runner-bbbb-0002";
const at = (ms: number) => vi.setSystemTime(NOW + ms);

async function world(scope: "read" | "act" = "act") {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  const { owner, token } = await ownerWithToken(t, scope);
  return { t, ids, owner, token };
}
type World = Awaited<ReturnType<typeof world>>;

const ask = (w: World, text = "Made-up question?", threadId?: Id<"chatThreads">) =>
  w.owner.mutation(api.chat.send, { company: "us", text, ...(threadId ? { threadId } : null) });
const next = (w: World, runner = RUNNER) => call(w.t, w.token, "chat_next", { runner });
const messagesOf = async (w: World, threadId: Id<"chatThreads">) =>
  (await w.owner.query(api.chat.messages, { threadId }))!.messages;
const answerOf = async (w: World, threadId: Id<"chatThreads">) => (await messagesOf(w, threadId)).at(-1)!;

/** Ask, claim, and hand back what the runner was given. */
async function claimed(w: World, text?: string) {
  const sent = await ask(w, text);
  const given = (await next(w)).output as { messageId: string; threadId: string };
  expect(given.messageId).toBe(sent.messageId);
  return sent;
}

describe("asking, and the answer arriving", () => {
  test("a question makes a conversation named after it, with the question and a queued answer", async () => {
    const w = await world();
    const sent = await ask(w, "Made-up question: what needs attention?\nSecond line.");
    expect(await w.owner.query(api.chat.threads, {})).toEqual([
      {
        id: sent.threadId,
        title: "Made-up question: what needs attention?",
        company: "us",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const listed = await w.owner.query(api.chat.messages, { threadId: sent.threadId });
    expect(listed!.thread).toEqual({ id: sent.threadId, title: "Made-up question: what needs attention?", company: "us" });
    expect(listed!.messages.map(({ role, text, status }) => ({ role, text, status }))).toEqual([
      { role: "user", text: "Made-up question: what needs attention?\nSecond line.", status: "done" },
      { role: "assistant", text: "", status: "queued" },
    ]);
    expect(listed!.messages[1]!.id).toBe(sent.messageId);
  });

  test("the runner claims it, fills it in, and finishes it", async () => {
    const w = await world();
    const sent = await ask(w, "Made-up question?");

    const given = await next(w);
    expect(given.output).toEqual({
      messageId: sent.messageId,
      threadId: sent.threadId,
      company: "us",
      question: "Made-up question?",
      history: [],
      today: TODAY,
      truncated: false,
    });
    expect((await answerOf(w, sent.threadId)).status).toBe("working");
    expect((await answerOf(w, sent.threadId)).startedAt).toBe(NOW);

    at(1_000);
    const first = await call(w.t, w.token, "chat_progress", {
      messageId: sent.messageId,
      runner: RUNNER,
      text: "Made-up partial",
      steps: ["tasks"],
    });
    expect(first.isError).toBe(false);
    expect(await answerOf(w, sent.threadId)).toMatchObject({
      status: "working",
      text: "Made-up partial",
      steps: ["tasks"],
    });

    at(2_000);
    await call(w.t, w.token, "chat_progress", {
      messageId: sent.messageId,
      runner: RUNNER,
      text: "Made-up partial answer\nwith a second line",
      steps: ["tasks", "deals"],
    });
    expect((await answerOf(w, sent.threadId)).text).toBe("Made-up partial answer\nwith a second line");

    at(3_000);
    const done = await call(w.t, w.token, "chat_finish", {
      messageId: sent.messageId,
      runner: RUNNER,
      text: "Made-up answer.\n\nIt is on /board.",
      steps: ["tasks", "deals"],
    });
    expect(done.isError).toBe(false);
    expect(await answerOf(w, sent.threadId)).toMatchObject({
      status: "done",
      text: "Made-up answer.\n\nIt is on /board.",
      steps: ["tasks", "deals"],
      failure: null,
      finishedAt: NOW + 3_000,
      proposals: [],
    });
    // The conversation moved to the top by the answer.
    expect((await w.owner.query(api.chat.threads, {}))[0]!.updatedAt).toBe(NOW + 3_000);
    // Nothing waits any more.
    expect((await next(w)).output).toEqual({ none: true, truncated: false });
  });

  test("a failure is one of a closed list of sentences, and the question is kept", async () => {
    const w = await world();
    for (const failed of RUNNER_FAILURES) {
      const sent = await claimed(w, `Made-up question about ${failed}?`);
      await call(w.t, w.token, "chat_progress", { messageId: sent.messageId, runner: RUNNER, text: "Made-up partial" });
      const done = await call(w.t, w.token, "chat_finish", { messageId: sent.messageId, runner: RUNNER, text: "", failed });
      expect(done.isError).toBe(false);
      const [question, answer] = await messagesOf(w, sent.threadId);
      expect(question!.text).toBe(`Made-up question about ${failed}?`);
      // The text is what the runner sends last, nothing included.
      expect(answer!.text).toBe("");
      expect([answer!.status, answer!.failure]).toEqual(["failed", CHAT_FAILURES[failed]]);
    }
    // Not the owner's "Stopped." nor the server's own, and no sentence of the runner's choosing.
    const sent = await claimed(w);
    for (const failed of ["stopped", "gaveUp", "The Mac says sosa_secret"]) {
      const refused = await call(w.t, w.token, "chat_finish", { messageId: sent.messageId, runner: RUNNER, text: "", failed });
      expect(refused.said).toMatch(/^The arguments are not valid\. failed:/);
      expect(refused.text).not.toContain("sosa_secret");
    }
    expect((await answerOf(w, sent.threadId)).status).toBe("working");
  });

  test("an answer needs text unless it failed", async () => {
    const w = await world();
    const sent = await claimed(w);
    const refused = await call(w.t, w.token, "chat_finish", { messageId: sent.messageId, runner: RUNNER, text: " \n " });
    expect(refused.said).toBe(CHAT_WORDS.emptyAnswer);
    expect((await answerOf(w, sent.threadId)).status).toBe("working");
  });

  test("the next question of a conversation is given what was said before, oldest first", async () => {
    const w = await world();
    const first = await claimed(w, "Made-up first question?");
    await call(w.t, w.token, "chat_finish", { messageId: first.messageId, runner: RUNNER, text: "Made-up first answer." });
    at(60_000);
    await ask(w, "Made-up second question?", first.threadId);
    const given = (await next(w)).output;
    expect(given.question).toBe("Made-up second question?");
    expect(given.history).toEqual([
      { role: "user", text: "Made-up first question?" },
      { role: "assistant", text: "Made-up first answer." },
    ]);
  });

  test("an answer that failed or was stopped is not part of what was said: its question still is", async () => {
    const w = await world();
    const first = await claimed(w, "Made-up first question?");
    await call(w.t, w.token, "chat_progress", { messageId: first.messageId, runner: RUNNER, text: "Made-up half an answer" });
    await w.owner.mutation(api.chat.stop, { messageId: first.messageId });
    await ask(w, "Made-up second question?", first.threadId);
    expect((await next(w)).output.history).toEqual([{ role: "user", text: "Made-up first question?" }]);
  });

  test("the history is the last twenty messages and at most eight kilobytes, and a failed answer is not in it", async () => {
    const w = await world();
    const { threadId } = await ask(w, "Made-up opening question?");
    await w.t.run(async (ctx) => {
      const open = await ctx.db.query("chatMessages").collect();
      await ctx.db.patch(open[1]!._id, { status: "failed", failure: "wrong", text: "half an answer" });
      for (let index = 0; index < 15; index += 1) {
        const base = { threadId, steps: [], proposalIds: [], askedAt: NOW + index };
        await ctx.db.insert("chatMessages", { ...base, role: "user", status: "done", text: `question ${index} ${"q".repeat(300)}` });
        await ctx.db.insert("chatMessages", { ...base, role: "assistant", status: "done", text: `answer ${index} ${"a".repeat(500)}` });
      }
    });
    at(60_000);
    await ask(w, "Made-up latest question?", threadId);
    const given = (await next(w)).output as { history: { role: string; text: string }[]; truncated: boolean };
    expect(given.truncated).toBe(false);
    expect(given.history.length).toBeLessThanOrEqual(CHAT_HISTORY_MESSAGES);
    expect(new TextEncoder().encode(JSON.stringify(given.history)).length).toBeLessThanOrEqual(CHAT_HISTORY_BYTES);
    // The newest are the ones kept, in the order they were said.
    expect(given.history.at(-1)!.text).toMatch(/^answer 14 /);
    expect(given.history.at(-2)!.text).toMatch(/^question 14 /);
    expect(given.history.length).toBeGreaterThan(8);
    expect(JSON.stringify(given.history)).not.toContain("half an answer");
  });
});

describe("one answer at a time in a conversation", () => {
  test("a second question is refused while the first is queued or being answered, and taken once it is done", async () => {
    const w = await world();
    const sent = await ask(w);
    await expect(ask(w, "Another?", sent.threadId)).rejects.toThrow(CHAT_WORDS.busy);
    await next(w);
    await expect(ask(w, "Another?", sent.threadId)).rejects.toThrow(CHAT_WORDS.busy);
    await call(w.t, w.token, "chat_finish", { messageId: sent.messageId, runner: RUNNER, text: "Made-up answer." });
    await ask(w, "Another?", sent.threadId);
    expect((await messagesOf(w, sent.threadId)).map((message) => message.status)).toEqual(["done", "done", "done", "queued"]);
  });

  test("another conversation is not held up, and the runner is given the oldest first", async () => {
    const w = await world();
    const first = await ask(w, "Made-up first?");
    at(1_000);
    const second = await ask(w, "Made-up second?");
    expect(second.threadId).not.toBe(first.threadId);
    expect((await next(w)).output.messageId).toBe(first.messageId);
    expect((await next(w)).output.messageId).toBe(second.messageId);
  });
});

describe("what is asked is held to its limits", () => {
  test("no text, too much text, and a conversation that is gone are refused in fixed words", async () => {
    const w = await world();
    await expect(ask(w, "  \n ")).rejects.toThrow(CHAT_WORDS.empty);
    await expect(ask(w, "q".repeat(MAX_CHAT_QUESTION_LENGTH + 1))).rejects.toThrow(CHAT_WORDS.tooLong);
    await ask(w, "q".repeat(MAX_CHAT_QUESTION_LENGTH));
    const sent = await ask(w);
    await w.owner.mutation(api.chat.remove, { threadId: sent.threadId });
    await expect(ask(w, "Again?", sent.threadId)).rejects.toThrow(CHAT_WORDS.threadGone);
  });

  test("a question is stored cleaned: nothing invisible, its lines kept, markup as the characters it is", async () => {
    const w = await world();
    const sent = await ask(w, "  Made​-up\u0007 ‮question?\r\n\r\n\r\n<b>second</b> [x](http://example.test)  ");
    const [question] = await messagesOf(w, sent.threadId);
    expect(question!.text).toBe("Made-up question?\n\n<b>second</b> [x](http://example.test)");
  });

  test(`at most ${MAX_CHAT_QUESTIONS_PER_DAY} questions a UTC day`, async () => {
    const w = await world();
    const { threadId } = await ask(w);
    await w.t.run(async (ctx) => {
      for (let index = 1; index < MAX_CHAT_QUESTIONS_PER_DAY; index += 1) {
        await ctx.db.insert("chatMessages", { threadId, role: "user", status: "done", text: "q", steps: [], proposalIds: [], askedAt: NOW });
      }
    });
    await expect(ask(w, "One too many?")).rejects.toThrow(CHAT_WORDS.tooManyToday);
    // Tomorrow has room again.
    at(DAY);
    await ask(w, "Tomorrow's?");
  });

  test("a conversation holds so many messages and then says to start a new one", async () => {
    const w = await world();
    const { threadId, messageId } = await ask(w);
    await w.t.run(async (ctx) => {
      await ctx.db.patch(messageId, { status: "done", text: "a" });
      for (let index = 2; index < MAX_THREAD_MESSAGES; index += 1) {
        await ctx.db.insert("chatMessages", { threadId, role: "assistant", status: "done", text: "a", steps: [], proposalIds: [], askedAt: 1 });
      }
    });
    await expect(ask(w, "More?", threadId)).rejects.toThrow(CHAT_WORDS.full);
  });
});

describe("what the runner writes is data", () => {
  test("an answer is cleaned and its lines kept; one over the limit is refused, never cut", async () => {
    const w = await world();
    const sent = await claimed(w);
    await call(w.t, w.token, "chat_progress", {
      messageId: sent.messageId,
      runner: RUNNER,
      text: "Made​-up ‮line\u0000 one\r\n\n\n\n<script>alert(1)</script>  ",
    });
    expect((await answerOf(w, sent.threadId)).text).toBe("Made-up line one\n\n<script>alert(1)</script>");

    for (const tool of ["chat_progress", "chat_finish"]) {
      const over = await call(w.t, w.token, tool, {
        messageId: sent.messageId,
        runner: RUNNER,
        text: "a".repeat(MAX_CHAT_ANSWER_LENGTH + 1),
      });
      expect(over.said).toBe("The arguments are not valid. text: is too long or too large.");
    }
    expect((await answerOf(w, sent.threadId)).text).toBe("Made-up line one\n\n<script>alert(1)</script>");
    const whole = await call(w.t, w.token, "chat_finish", {
      messageId: sent.messageId,
      runner: RUNNER,
      text: "a".repeat(MAX_CHAT_ANSWER_LENGTH),
    });
    expect(whole.isError).toBe(false);
  });

  test("steps are tool names the answering model has: any other name is dropped, and the latest thirty are kept", async () => {
    const w = await world();
    const sent = await claimed(w);
    await call(w.t, w.token, "chat_progress", {
      messageId: sent.messageId,
      runner: RUNNER,
      steps: ["tasks", "rm -rf /", "task_create", "chat_next", "<b>deals</b>", "propose", "deals"],
    });
    expect((await answerOf(w, sent.threadId)).steps).toEqual(["tasks", "propose", "deals"]);

    const many = [...Array.from({ length: MAX_CHAT_STEPS + 5 }, () => "metrics"), "goals"];
    await call(w.t, w.token, "chat_finish", { messageId: sent.messageId, runner: RUNNER, text: "Made-up.", steps: many });
    const { steps } = await answerOf(w, sent.threadId);
    expect(steps).toHaveLength(MAX_CHAT_STEPS);
    expect(steps.at(-1)).toBe("goals");
    expect(knownSteps(["nope", 3, null, "tasks"])).toEqual(["tasks"]);
  });

  test("a runner id is a plain token, and a message id that is not one is the same refusal as one that is gone", async () => {
    const w = await world();
    const bad = await call(w.t, w.token, "chat_next", { runner: "Not A Runner!" });
    expect(bad.said).toBe("The arguments are not valid. runner: is not written the way this field is.");
    const gone = await call(w.t, w.token, "chat_progress", { messageId: "not-an-id", runner: RUNNER, text: "x" });
    expect(gone.said).toBe(CHAT_WORDS.abandon);
  });
});

describe("a claim that runs out", () => {
  test("is taken once more, by whichever runner asks, and the first runner is told to abandon it", async () => {
    const w = await world();
    const sent = await claimed(w);
    await call(w.t, w.token, "chat_progress", { messageId: sent.messageId, runner: RUNNER, text: "Made-up half", steps: ["tasks"] });

    // Still the first runner's a moment before the claim ends.
    at(CHAT_CLAIM_MS - 1);
    expect((await next(w, OTHER)).output).toEqual({ none: true, truncated: false });

    at(CHAT_CLAIM_MS + 1);
    const again = await next(w, OTHER);
    expect(again.output.messageId).toBe(sent.messageId);
    // It starts again from nothing.
    expect(await answerOf(w, sent.threadId)).toMatchObject({ status: "working", text: "", steps: [] });

    for (const tool of ["chat_progress", "chat_finish"]) {
      const late = await call(w.t, w.token, tool, { messageId: sent.messageId, runner: RUNNER, text: "Made-up late" });
      expect(late.said).toBe(CHAT_WORDS.abandon);
    }
    const done = await call(w.t, w.token, "chat_finish", { messageId: sent.messageId, runner: OTHER, text: "Made-up answer." });
    expect(done.isError).toBe(false);
    expect((await answerOf(w, sent.threadId)).text).toBe("Made-up answer.");
  });

  test("progress extends a claim", async () => {
    const w = await world();
    const sent = await claimed(w);
    at(CHAT_CLAIM_MS - 1_000);
    await call(w.t, w.token, "chat_progress", { messageId: sent.messageId, runner: RUNNER, text: "Made-up" });
    at(CHAT_CLAIM_MS + 1_000);
    expect((await next(w, OTHER)).output).toEqual({ none: true, truncated: false });
  });

  test("a second time, the answer is marked failed by the next check-in", async () => {
    const w = await world();
    const sent = await claimed(w);
    at(CHAT_CLAIM_MS + 1);
    expect((await next(w, OTHER)).output.messageId).toBe(sent.messageId);
    at(2 * CHAT_CLAIM_MS + 2);
    expect((await next(w)).output).toEqual({ none: true, truncated: false });
    expect(await answerOf(w, sent.threadId)).toMatchObject({
      status: "failed",
      failure: "Your Mac stopped answering part-way.",
      finishedAt: NOW + 2 * CHAT_CLAIM_MS + 2,
    });
    // And the conversation takes a new question.
    await ask(w, "Again?", sent.threadId);
  });

  test("or by the daily sweep, which leaves alone a claim that is live or has a try left", async () => {
    const w = await world();
    const twice = await claimed(w, "Made-up twice?");
    at(CHAT_CLAIM_MS + 1);
    await next(w, OTHER);
    at(CHAT_CLAIM_MS + 2);
    // Claimed twice, but the second claim is still live: not the sweep's yet.
    await w.t.mutation(internal.assistant.sweep, {});
    expect((await answerOf(w, twice.threadId)).status).toBe("working");
    const once = await ask(w, "Made-up once?");
    await next(w);
    const live = await ask(w, "Made-up live?");
    at(2 * CHAT_CLAIM_MS + 3);
    // `once` has run out for the first time; `live` was never claimed.
    await w.t.mutation(internal.assistant.sweep, {});
    expect((await answerOf(w, twice.threadId)).failure).toBe(CHAT_FAILURES.gaveUp);
    expect((await answerOf(w, once.threadId)).status).toBe("working");
    expect((await answerOf(w, live.threadId)).status).toBe("queued");
  });
});

describe("stopping", () => {
  test("an answer stopped part-way says so, keeps what it had, and refuses the runner from then on", async () => {
    const w = await world();
    const sent = await claimed(w);
    await call(w.t, w.token, "chat_progress", { messageId: sent.messageId, runner: RUNNER, text: "Made-up half" });
    at(5_000);
    await w.owner.mutation(api.chat.stop, { messageId: sent.messageId });
    expect(await answerOf(w, sent.threadId)).toMatchObject({
      status: "failed",
      failure: "Stopped.",
      text: "Made-up half",
      finishedAt: NOW + 5_000,
    });
    const progress = await call(w.t, w.token, "chat_progress", { messageId: sent.messageId, runner: RUNNER, text: "Made-up more" });
    expect(progress.said).toBe(CHAT_WORDS.abandon);
    expect(progress.said).toMatch(/Abandon it/);
    const finish = await call(w.t, w.token, "chat_finish", { messageId: sent.messageId, runner: RUNNER, text: "Made-up whole" });
    expect(finish.said).toBe(CHAT_WORDS.abandon);
    expect(await answerOf(w, sent.threadId)).toMatchObject({ status: "failed", text: "Made-up half" });
    // The conversation is free again.
    await ask(w, "Another?", sent.threadId);
  });

  test("a question stopped before it was claimed is never given to the runner", async () => {
    const w = await world();
    const sent = await ask(w);
    await w.owner.mutation(api.chat.stop, { messageId: sent.messageId });
    expect((await next(w)).output).toEqual({ none: true, truncated: false });
    expect((await answerOf(w, sent.threadId)).failure).toBe("Stopped.");
  });

  test("stopping a finished answer changes nothing, and a message that is gone is said to be", async () => {
    const w = await world();
    const sent = await claimed(w);
    await call(w.t, w.token, "chat_finish", { messageId: sent.messageId, runner: RUNNER, text: "Made-up answer." });
    await w.owner.mutation(api.chat.stop, { messageId: sent.messageId });
    expect(await answerOf(w, sent.threadId)).toMatchObject({ status: "done", failure: null });
    await w.owner.mutation(api.chat.remove, { threadId: sent.threadId });
    await expect(w.owner.mutation(api.chat.stop, { messageId: sent.messageId })).rejects.toThrow(CHAT_WORDS.messageGone);
  });
});

describe("a proposal made while answering", () => {
  const proposal = (key: string, extra: Record<string, unknown> = {}) => ({
    agent: "chief_of_staff",
    company: "us",
    kind: "task_create",
    reason: "Made-up reason.",
    dedupeKey: `chief_of_staff:task_create:${key}`,
    payload: { title: `Made-up task ${key}` },
    ...extra,
  });

  test("is linked to the answer, shows under it as a card, and is carried out only by the owner's click", async () => {
    const w = await world();
    const sent = await claimed(w);
    const made = await call(w.t, w.token, "propose", proposal("one", { chatMessageId: sent.messageId }));
    expect(made.output).toMatchObject({ proposed: true });
    await call(w.t, w.token, "chat_finish", { messageId: sent.messageId, runner: RUNNER, text: "I have put a card below for you to approve." });

    const [card] = (await answerOf(w, sent.threadId)).proposals;
    expect(card).toMatchObject({
      id: made.output.id,
      agent: "chief_of_staff",
      kind: "task_create",
      company: "us",
      reason: "Made-up reason.",
      payload: { title: "Made-up task one" },
      status: "open",
      about: { task: null, deal: null, assignee: null },
    });
    // Nothing happened yet.
    const titles = async () => (await w.owner.query(api.tasks.board, {})).backlog.map((task) => task.title);
    expect(await titles()).not.toContain("Made-up task one");
    // It is also among the approvals, like any other.
    const listed = await w.owner.query(api.assistant.inbox, {});
    expect(listed.map((row) => row.id)).toEqual([made.output.id]);

    await w.owner.mutation(api.assistant.approve, { id: card!.id });
    expect(await titles()).toContain("Made-up task one");
    expect((await answerOf(w, sent.threadId)).proposals[0]).toMatchObject({ status: "approved", result: { taskId: expect.any(String) } });
  });

  test("is refused, and nothing proposed, for a message that is not being answered", async () => {
    const w = await world();
    const sent = await ask(w);
    const proposals = () => w.t.run((ctx) => ctx.db.query("proposals").collect());
    const [question] = await messagesOf(w, sent.threadId);

    // Queued, the owner's own question, not an id, and finished.
    for (const chatMessageId of [sent.messageId, question!.id, "not-an-id"]) {
      const refused = await call(w.t, w.token, "propose", proposal("early", { chatMessageId }));
      expect(refused.said).toBe(CHAT_WORDS.notAnswering);
    }
    await next(w);
    await call(w.t, w.token, "chat_finish", { messageId: sent.messageId, runner: RUNNER, text: "Made-up answer." });
    const late = await call(w.t, w.token, "propose", proposal("late", { chatMessageId: sent.messageId }));
    expect(late.said).toBe(CHAT_WORDS.notAnswering);
    expect(await proposals()).toEqual([]);
    expect((await answerOf(w, sent.threadId)).proposals).toEqual([]);
  });

  test("one the server refuses is not linked, and one without a chatMessageId is as it always was", async () => {
    const w = await world();
    const sent = await claimed(w);
    await call(w.t, w.token, "propose", proposal("same", { chatMessageId: sent.messageId }));
    const repeat = await call(w.t, w.token, "propose", proposal("same", { chatMessageId: sent.messageId }));
    expect(repeat.said).toBe(PROPOSAL_WORDS.repeatOpen);
    const plain = await call(w.t, w.token, "propose", proposal("plain"));
    expect(plain.output).toMatchObject({ proposed: true });
    expect((await answerOf(w, sent.threadId)).proposals.map((card) => card.payload)).toEqual([{ title: "Made-up task same" }]);
  });

  test(`at most ${MAX_CHAT_PROPOSALS} under one answer`, async () => {
    const w = await world();
    const sent = await claimed(w);
    for (let index = 0; index < MAX_CHAT_PROPOSALS; index += 1) {
      const made = await call(w.t, w.token, "propose", proposal(`n${index}`, { chatMessageId: sent.messageId }));
      expect(made.isError).toBe(false);
    }
    const over = await call(w.t, w.token, "propose", proposal("over", { chatMessageId: sent.messageId }));
    expect(over.said).toBe(CHAT_WORDS.tooManyProposals);
    expect(await w.t.run(async (ctx) => (await ctx.db.query("proposals").collect()).length)).toBe(MAX_CHAT_PROPOSALS);
  });

  test("a proposal that was deleted since is left out of the conversation", async () => {
    const w = await world();
    const sent = await claimed(w);
    const made = await call(w.t, w.token, "propose", proposal("gone", { chatMessageId: sent.messageId }));
    await w.t.run((ctx) => ctx.db.delete(made.output.id as Id<"proposals">));
    expect((await answerOf(w, sent.threadId)).proposals).toEqual([]);
  });
});

describe("which tools the answering Claude has", () => {
  // A bot's own read (`my_inbox`) refuses the chat: it is denied by name.
  const reads = TOOLS.filter((tool) => tool.kind === "read" && !(BOT_OWN_TOOLS as readonly string[]).includes(tool.name)).map(
    (tool) => tool.name,
  );
  const runner = TOOLS.filter((tool) => tool.audience === "runner").map((tool) => tool.name);

  test("every read tool and `propose`, and nothing else", () => {
    expect([...CHAT_READ_TOOLS]).toEqual(reads);
    expect([...CHAT_TOOLS]).toEqual([...reads, "propose"]);
    const acts = CHAT_TOOLS.filter((name) => TOOLS.find((tool) => tool.name === name)!.kind === "act");
    expect(acts).toEqual(["propose"]);
  });

  test("the runner's own six are the runner's alone: marked so, in neither the model's list nor `tools/list`", async () => {
    expect(runner).toEqual([...RUNNER_TOOLS]);
    for (const name of RUNNER_TOOLS) expect(CHAT_TOOLS as readonly string[]).not.toContain(name);
    expect(toolsFor("act").map((tool) => tool.name)).not.toEqual(expect.arrayContaining([...RUNNER_TOOLS]));
    const w = await world();
    const listed = (await rpc(w.t, w.token, "tools/list")).body.result!.tools as { name: string }[];
    expect(listed.map((tool) => tool.name)).toEqual(TOOLS.filter((tool) => tool.audience !== "runner").map((tool) => tool.name));
    expect(listed.length).toBe(TOOLS.length - RUNNER_TOOLS.length);
    expect(RUNNER_TOOLS.length).toBe(6);
  });

  test("every other tool is denied by name: the two lists are the whole registry", () => {
    expect([...CHAT_TOOLS, ...CHAT_DENIED_TOOLS].sort()).toEqual(TOOLS.map((tool) => tool.name).sort());
    for (const name of ["task_create", "task_update", "task_move", "deal_update", "investor_update", "investor_create", "customer_update", "partner_upsert", "partner_move", "brief_write"]) {
      expect(CHAT_DENIED_TOOLS as readonly string[]).toContain(name);
    }
  });

  test("each has a label for its step, and the pages an answer may link to are the app's own", () => {
    expect(Object.keys(STEP_LABELS).sort()).toEqual([...CHAT_TOOLS].sort());
    expect(STEP_LABELS.tasks).toBe("Read tasks");
    expect(STEP_LABELS.deals).toBe("Read deals");
    for (const page of CHAT_PAGES) expect(PAGE_AREAS[page], page).toBeDefined();
    // Never payroll or a settings page.
    expect(CHAT_PAGES.join(" ")).not.toMatch(/payroll|settings|today/);
  });
});

describe("the runner's limits and its audit", () => {
  test("checking in every three seconds for ten minutes is never limited, and uses none of the model's calls", async () => {
    const w = await world();
    for (let poll = 0; poll < 200; poll += 1) {
      at(poll * 3_000);
      const reply = await next(w);
      expect(reply.error, `poll ${poll}`).toBeNull();
    }
    const token = await w.t.run(async (ctx) => (await ctx.db.query("agentTokens").first())!);
    expect([token.calls, token.acts]).toEqual([undefined, undefined]);
    expect(token.runnerCalls).toBe(200);
    // The model still has all of its own.
    for (let index = 0; index < MAX_CALLS_PER_WINDOW; index += 1) {
      expect((await call(w.t, w.token, "goals", {})).error).toBeNull();
    }
    expect((await call(w.t, w.token, "goals", {})).error?.message).toBe(AGENT_WORDS.limited);
    // And being out of them does not stop the runner.
    expect((await next(w)).error).toBeNull();
  });

  test(`the runner has a window of its own: ${MAX_RUNNER_CALLS_PER_WINDOW} calls in ten minutes`, async () => {
    const w = await world();
    await next(w);
    await w.t.run(async (ctx) => {
      const token = (await ctx.db.query("agentTokens").first())!;
      await ctx.db.patch(token._id, { runnerCalls: MAX_RUNNER_CALLS_PER_WINDOW });
    });
    const over = await next(w);
    expect(over.error).toEqual({ code: -32000, message: AGENT_WORDS.runnerLimited });
    await next(w);
    // Written down once a window.
    expect((await calls(w.t)).filter((row) => row.outcome === "refused")).toEqual([
      { tool: "chat_next", kind: "act", outcome: "refused" },
    ]);
    at(10 * 60_000 + 1);
    expect((await next(w)).error).toBeNull();
  });

  test("an empty check-in and a progress report leave no audit row; a claim and a finish leave one each", async () => {
    const w = await world();
    await next(w);
    await next(w);
    expect(await calls(w.t)).toEqual([]);
    const sent = await claimed(w);
    await call(w.t, w.token, "chat_progress", { messageId: sent.messageId, runner: RUNNER, text: "Made-up" });
    await call(w.t, w.token, "chat_finish", { messageId: sent.messageId, runner: RUNNER, text: "Made-up answer." });
    expect(await calls(w.t)).toEqual([
      { tool: "chat_next", kind: "act", outcome: "ok" },
      { tool: "chat_finish", kind: "act", outcome: "ok" },
    ]);
    // A row is a name, a kind, a time and an outcome: nothing of the question or the answer.
    const rows = await w.t.run((ctx) => ctx.db.query("agentCalls").collect());
    expect(JSON.stringify(rows)).not.toMatch(/Made-up/);
  });

  test("a client that is not the Mac's cannot run the chat: to it the runner's tools do not exist", async () => {
    const w = await world("read");
    const refused = await next(w);
    expect(refused.error?.message).toBe(AGENT_WORDS.unknownTool);
    expect(await w.owner.query(api.chat.runner, {})).toEqual({ checkedInAt: null, everyMs: null });
  });

  test("the one token of before, read only, is the Mac's but still cannot act", async () => {
    const w = await world("act");
    await w.t.run(async (ctx) => {
      const row = (await ctx.db.query("agentTokens").first())!;
      await ctx.db.replace(row._id, { userId: row.userId, tokenHash: row.tokenHash, scope: "read", createdAt: row.createdAt });
    });
    const refused = await next(w);
    expect(refused.said).toBe(AGENT_WORDS.readOnly);
    expect(await w.owner.query(api.chat.runner, {})).toEqual({ checkedInAt: null, everyMs: null });
  });
});

describe("whether the Mac is there", () => {
  test("a check-in is written down with the interval the runner says it keeps", async () => {
    const w = await world();
    expect(await w.owner.query(api.chat.runner, {})).toEqual({ checkedInAt: null, everyMs: null });
    await next(w);
    expect(await w.owner.query(api.chat.runner, {})).toEqual({ checkedInAt: NOW, everyMs: 3_000 });
    at(40_000);
    await call(w.t, w.token, "chat_next", { runner: RUNNER, everyMs: 60_000 });
    expect(await w.owner.query(api.chat.runner, {})).toEqual({ checkedInAt: NOW + 40_000, everyMs: 60_000 });
    expect(await w.t.run(async (ctx) => (await ctx.db.query("chatRunner").collect()).length)).toBe(1);
  });

  test("it is there while its last check-in is within its own interval and thirty seconds", () => {
    expect(runnerIsThere({ checkedInAt: null, everyMs: null }, NOW)).toBe(false);
    const quick = { checkedInAt: NOW, everyMs: 3_000 };
    expect(runnerIsThere(quick, NOW + 3_000 + RUNNER_FRESH_MS)).toBe(true);
    expect(runnerIsThere(quick, NOW + 3_000 + RUNNER_FRESH_MS + 1)).toBe(false);
    // Idle for an hour, it checks every minute, and is still there between checks.
    const idle = { checkedInAt: NOW, everyMs: 60_000 };
    expect(runnerIsThere(idle, NOW + 80_000)).toBe(true);
    expect(runnerIsThere(idle, NOW + 91_000)).toBe(false);
    // An interval it could not have is not believed.
    expect(runnerIsThere({ checkedInAt: NOW, everyMs: 10 ** 9 }, NOW + 200_000)).toBe(false);
  });
});

describe("conversations", () => {
  test("are listed newest first, renamed in clean words, and removed with their messages", async () => {
    const w = await world();
    const first = await ask(w, "Made-up first?");
    at(1_000);
    const second = await ask(w, "Made-up second?");
    expect((await w.owner.query(api.chat.threads, {})).map((thread) => thread.id)).toEqual([second.threadId, first.threadId]);

    await w.owner.mutation(api.chat.rename, { threadId: first.threadId, title: "  Made​-up   <i>name</i> " });
    expect((await w.owner.query(api.chat.threads, {}))[1]!.title).toBe("Made-up <i>name</i>");
    await expect(w.owner.mutation(api.chat.rename, { threadId: first.threadId, title: " ​ " })).rejects.toThrow(CHAT_WORDS.noTitle);
    await expect(
      w.owner.mutation(api.chat.rename, { threadId: first.threadId, title: "n".repeat(MAX_THREAD_TITLE_LENGTH + 1) }),
    ).rejects.toThrow(CHAT_WORDS.titleTooLong);

    await w.owner.mutation(api.chat.remove, { threadId: first.threadId });
    expect((await w.owner.query(api.chat.threads, {})).map((thread) => thread.id)).toEqual([second.threadId]);
    expect(await w.owner.query(api.chat.messages, { threadId: first.threadId })).toBeNull();
    const left = await w.t.run((ctx) => ctx.db.query("chatMessages").collect());
    expect(left.every((message) => message.threadId === second.threadId)).toBe(true);
    await expect(w.owner.mutation(api.chat.rename, { threadId: first.threadId, title: "x" })).rejects.toThrow(CHAT_WORDS.threadGone);
    // Removing one that is gone is not an error.
    await w.owner.mutation(api.chat.remove, { threadId: first.threadId });
    // The queued answer of a removed conversation is nobody's to claim.
    expect((await next(w)).output.messageId).toBe(second.messageId);
    expect((await next(w)).output).toEqual({ none: true, truncated: false });
  });

  test("one nobody has added to for ninety days is deleted by the sweep", async () => {
    const w = await world();
    const old = await claimed(w, "Made-up old?");
    await call(w.t, w.token, "chat_finish", { messageId: old.messageId, runner: RUNNER, text: "Made-up answer." });
    at(CHAT_RETENTION_DAYS * DAY - 1_000);
    const recent = await ask(w, "Made-up recent?");
    at(CHAT_RETENTION_DAYS * DAY + 1_000);
    await w.t.mutation(internal.assistant.sweep, {});
    expect((await w.owner.query(api.chat.threads, {})).map((thread) => thread.id)).toEqual([recent.threadId]);
    expect(await w.t.run(async (ctx) => (await ctx.db.query("chatMessages").collect()).length)).toBe(2);
  });
});

describe("how it is written", () => {
  const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

  test("nothing logs, the rules are pure, and a query never reads the clock", () => {
    for (const path of ["./chat.ts", "./lib/chat.ts", "./lib/chatRules.ts"]) {
      expect(source(path), path).not.toMatch(/console\./);
      expect(source(path), path).not.toMatch(/process\.env|fetch\(/);
    }
    expect(source("./lib/chat.ts")).not.toMatch(/Date\.now\(\)/);
    expect(source("./lib/chatRules.ts")).not.toMatch(/Date\.now\(\)|from "\.\.\/_generated/);
    // In the owner's functions the clock is read by mutations alone.
    const queries = [...source("./chat.ts").matchAll(/ownerQuery\(\{[\s\S]*?\n\}\);/g)].map((match) => match[0]);
    expect(queries.length).toBe(3);
    for (const query of queries) expect(query).not.toMatch(/Date\.now\(\)/);
  });

  test("no model key and no call to a model anywhere on the server", () => {
    for (const path of ["./chat.ts", "./lib/chat.ts", "./lib/chatRules.ts", "./lib/mcpTools.ts", "./mcp.ts", "./assistant.ts"]) {
      expect(source(path), path).not.toMatch(/ANTHROPIC_API_KEY|api\.anthropic\.com|x-api-key/i);
    }
  });
});

describe("the Mac's client's 'last used', as the connection page shows it", () => {
  test("a check-in by the Mac's runner counts as use, though it stamps no token row", async () => {
    const w = await world();
    const mac = async () => (await w.owner.query(api.assistant.clients, {})).find((row) => row.runner)!;
    expect((await mac()).lastUsedAt).toBeNull();
    at(7_000);
    await next(w);
    expect((await mac()).lastUsedAt).toBe(NOW + 7_000);
    // Another client's use is its own: the runner's check-in is not said of it.
    await w.owner.mutation(api.assistant.createToken, {
      entropy: "fake-browser-entropy-0123456789-abcdefghijklmn",
      scope: "read",
      name: "Grok bot",
    });
    const grok = (await w.owner.query(api.assistant.clients, {})).find((row) => !row.runner)!;
    expect(grok.lastUsedAt).toBeNull();
  });

  test("a check-in from before the token was made does not: that was another token's", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      await ctx.db.insert("chatRunner", { checkedInAt: NOW - 60_000, everyMs: 3_000 });
    });
    expect((await w.owner.query(api.assistant.clients, {}))[0]!.lastUsedAt).toBeNull();
  });
});
