import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { PROPOSAL_WORDS, WITHDRAW_WORDS, WRONG_WITHDRAW_BLOCKS_DAYS } from "./lib/agents";
import { DAY, ENTROPY, NOW, bearer, call, ownerWithToken } from "./mcp.kit";
import schema from "./schema";
import { OWNER, modules, type TestBackend } from "./test.setup";

// Proposal withdraw (spec §14, docs/assistant.md "Withdrawing a proposal"):
// a proposer takes back its own open proposal. Made-up names and titles throughout.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function setUp() {
  const t = convexTest(schema, modules);
  const { owner, token: mac } = await ownerWithToken(t, "act");
  const grok = await owner.mutation(api.assistant.createToken, { entropy: ENTROPY, scope: "act", name: "Grok app" });
  await owner.mutation(api.bots.addSuggested, {});
  return { t, owner, mac, grok: grok.token };
}

const proposalsOf = (t: TestBackend) => t.run((ctx) => ctx.db.query("proposals").collect());
const rowOf = (t: TestBackend, id: string) => t.run((ctx) => ctx.db.get(id as Id<"proposals">));

const proposal = (agent: string, dedupeKey: string, title: string, extra: Record<string, unknown> = {}) => ({
  agent,
  company: "us",
  kind: "task_create",
  why: "Made-up why.",
  dedupeKey,
  payload: { title },
  ...extra,
});

/** A proposal made through the endpoint: its id. */
async function made(t: TestBackend, token: string, args: Record<string, unknown>, headers?: Record<string, string>): Promise<string> {
  const reply = await call(t, token, "propose", args, headers);
  if (reply.output === null) throw new Error(`propose did not answer: ${reply.text}`);
  return reply.output.id as string;
}

async function atAddress(t: TestBackend, bot: string, token: string, name: string, args: unknown = {}) {
  const response = await t.fetch(`/mcp/v1/bot/${bot}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...bearer(token) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = (await response.json()) as { result?: { isError: boolean; content: { text: string }[]; structuredContent: Record<string, unknown> } };
  return body.result!;
}

describe("withdrawing one", () => {
  test("a bot withdraws its own open proposal: withdrawn, with its reason, gone from the inbox", async () => {
    const { t, owner, grok } = await setUp();
    const id = await made(t, grok, proposal("growth", "growth:task_create:one", "Made-up pricing page copy"));
    expect(await owner.query(api.assistant.inbox, {})).toHaveLength(1);

    const done = await call(t, grok, "proposal_withdraw", { agent: "growth", id, reason: "stale", note: "Made-up: done another way." });
    expect(done.output).toMatchObject({ id, withdrawn: true });
    const row = await rowOf(t, id);
    expect(row).toMatchObject({
      status: "withdrawn",
      withdrawReason: "stale",
      withdrawNote: "Made-up: done another way.",
      withdrawnBy: "bot:growth",
      decidedAt: NOW,
      withdrawnAt: NOW,
    });
    // Off the owner's inbox and its count at once (one query, read reactively), and listed as decided with its reason.
    const inbox = await owner.query(api.assistant.inbox, {});
    expect(inbox.map((row) => row.id)).not.toContain(id);
    expect((await owner.query(api.assistant.decided, { since: 0 })).find((row) => row.id === id)).toMatchObject({
      status: "withdrawn",
      withdrawReason: "stale",
      withdrawNote: "Made-up: done another way.",
    });
  });

  test("another bot's proposal is refused not_owner, and so is an id that does not exist (no probing)", async () => {
    const { t, grok } = await setUp();
    const id = await made(t, grok, proposal("growth", "growth:task_create:one", "Made-up pricing page copy"));
    const other = await call(t, grok, "proposal_withdraw", { agent: "research", id, reason: "duplicate" });
    expect(other.said).toBe(WITHDRAW_WORDS.notOwner);
    expect(other.refusal).toEqual({ code: "not_owner" });
    // A well-formed id of a row that is gone, and a malformed one: the same answer.
    const gone = id.slice(0, -2) + (id.endsWith("aa") ? "ab" : "aa");
    for (const unknown of [gone, "not-an-id"]) {
      const reply = await call(t, grok, "proposal_withdraw", { agent: "research", id: unknown, reason: "duplicate" });
      expect(reply.said).toBe(WITHDRAW_WORDS.notOwner);
      expect(reply.refusal).toEqual({ code: "not_owner" });
    }
    expect((await rowOf(t, id))!.status).toBe("open");
  });

  test("a proposal that is no longer open is refused not_open", async () => {
    const { t, owner, grok } = await setUp();
    const id = await made(t, grok, proposal("growth", "growth:task_create:one", "Made-up pricing page copy"));
    await owner.mutation(api.assistant.dismiss, { id: id as Id<"proposals">, code: "not_a_priority" });
    const reply = await call(t, grok, "proposal_withdraw", { agent: "growth", id, reason: "stale" });
    expect(reply.said).toBe(WITHDRAW_WORDS.notOpen);
    expect(reply.refusal).toEqual({ code: "not_open" });
    expect((await rowOf(t, id))!.status).toBe("dismissed");
  });

  test("a note with an email address or a phone number is refused; id and ids together are refused", async () => {
    const { t, grok } = await setUp();
    const id = await made(t, grok, proposal("growth", "growth:task_create:one", "Made-up pricing page copy"));
    const contact = await call(t, grok, "proposal_withdraw", { agent: "growth", id, reason: "other", note: "Ask jo@example.test" });
    expect(contact.refusal).toEqual({ code: "contact_detail" });
    const phone = await call(t, grok, "proposal_withdraw", { agent: "growth", id, reason: "other", note: "Call +1 415 555 0100" });
    expect(phone.refusal).toEqual({ code: "contact_detail" });
    const both = await call(t, grok, "proposal_withdraw", { agent: "growth", id, ids: [id], reason: "other" });
    expect(both.said).toBe(WITHDRAW_WORDS.oneOf);
    const neither = await call(t, grok, "proposal_withdraw", { agent: "growth", reason: "other" });
    expect(neither.said).toBe(WITHDRAW_WORDS.oneOf);
    expect((await rowOf(t, id))!.status).toBe("open");
  });

  test("replacedBy must be the caller's own proposal of the same company", async () => {
    const { t, grok } = await setUp();
    const old = await made(t, grok, proposal("growth", "growth:task_create:old", "Made-up pricing page copy"));
    const theirs = await made(t, grok, proposal("research", "research:task_create:x", "Made-up market scan of Almaty"));
    const kz = await made(t, grok, proposal("growth", "growth:task_create:kz", "Made-up Kazakh landing page", { company: "kz" }));
    const next = await made(t, grok, proposal("growth", "growth:task_create:new", "Made-up onboarding email sequence"));

    const notMine = await call(t, grok, "proposal_withdraw", { agent: "growth", id: old, reason: "superseded", replacedBy: theirs });
    expect(notMine.refusal).toEqual({ code: "not_owner" });
    expect(notMine.said).toBe(WITHDRAW_WORDS.replacedBy);
    const otherCompany = await call(t, grok, "proposal_withdraw", { agent: "growth", id: old, reason: "superseded", replacedBy: kz });
    expect(otherCompany.refusal).toEqual({ code: "bad_context" });
    const itself = await call(t, grok, "proposal_withdraw", { agent: "growth", id: old, reason: "superseded", replacedBy: old });
    expect(itself.refusal).toEqual({ code: "bad_context" });

    expect((await call(t, grok, "proposal_withdraw", { agent: "growth", id: old, reason: "superseded", replacedBy: next })).output).toMatchObject({
      withdrawn: true,
    });
    expect(await rowOf(t, old)).toMatchObject({ status: "withdrawn", replacedBy: next });
  });
});

describe("bulk", () => {
  test("ids: each item answered on its own; the call counts once", async () => {
    const { t, owner, grok } = await setUp();
    const a = await made(t, grok, proposal("growth", "growth:task_create:a", "Made-up pricing page copy"));
    const b = await made(t, grok, proposal("growth", "growth:task_create:b", "Made-up onboarding email sequence"));
    const decided = await made(t, grok, proposal("growth", "growth:task_create:c", "Made-up webinar on denials"));
    await owner.mutation(api.assistant.approve, { id: decided as Id<"proposals"> });
    const theirs = await made(t, grok, proposal("research", "research:task_create:x", "Made-up market scan of Almaty"));

    const reply = await call(t, grok, "proposal_withdraw", { agent: "growth", ids: [a, theirs, decided, b, "nope"], reason: "duplicate" });
    expect(reply.output).toMatchObject({
      withdrawn: 2,
      results: [
        { id: a, ok: true },
        { id: theirs, ok: false, code: "not_owner" },
        { id: decided, ok: false, code: "not_open" },
        { id: b, ok: true },
        { id: "nope", ok: false, code: "not_owner" },
      ],
    });
    const rows = await proposalsOf(t);
    expect(rows.filter((r) => r.status === "withdrawn").map((r) => r._id).sort()).toEqual([a, b].sort());
    expect(rows.find((r) => r._id === theirs)!.status).toBe("open");
    // One audit row for the call, however many items.
    const audit = await t.run((ctx) => ctx.db.query("agentCalls").collect());
    expect(audit.filter((row) => row.tool === "proposal_withdraw")).toHaveLength(1);
  });

  test("more than 50 ids is refused by the input", async () => {
    const { t, grok } = await setUp();
    const ids = Array.from({ length: 51 }, (_, i) => `x${i}`);
    const reply = await call(t, grok, "proposal_withdraw", { agent: "growth", ids, reason: "stale" });
    expect(reply.isError).toBe(true);
    expect(reply.output).toBeNull();
  });
});

describe("who may withdraw", () => {
  test("one of the four withdraws only its own rows, never a bot's filed under it; the owner's own client any", async () => {
    const { t, mac, grok } = await setUp();
    const macCos = await made(t, mac, proposal("chief_of_staff", "chief_of_staff:task_create:a", "Made-up board pack outline"));
    const macFinance = await made(t, mac, proposal("finance", "finance:task_create:b", "Made-up audit timeline review"));
    // A bot's proposal is filed under the chief of staff: still not the Mac agent's.
    const growth = await made(t, grok, proposal("growth", "growth:task_create:c", "Made-up pricing page copy"));

    const cosBulk = await call(t, mac, "proposal_withdraw", { agent: "chief_of_staff", ids: [macCos, macFinance, growth], reason: "stale" });
    expect(cosBulk.output.results).toEqual([
      { id: macCos, ok: true },
      { id: macFinance, ok: false, code: "not_owner" },
      { id: growth, ok: false, code: "not_owner" },
    ]);
    expect((await rowOf(t, macCos))!.withdrawnBy).toBe("chief_of_staff");

    // The owner's own client, naming no agent, may withdraw any.
    const any = await call(t, mac, "proposal_withdraw", { ids: [macFinance, growth], reason: "other" });
    expect(any.output).toMatchObject({ withdrawn: 2 });
    expect((await rowOf(t, growth))!.withdrawnBy).toBe("owner");
  });

  test("the external chief of staff cannot withdraw the Mac chief of staff's rows, nor the other way round", async () => {
    const { t, owner, mac, grok } = await setUp();
    await owner.mutation(api.bots.addExternalProfile, { id: "chief_of_staff" });
    const macRow = await made(t, mac, proposal("chief_of_staff", "chief_of_staff:task_create:mac", "Made-up board pack outline"));
    const external = await atAddress(t, "chief_of_staff", grok, "propose", {
      company: "us",
      kind: "task_create",
      why: "Made-up why.",
      dedupeKey: "chief_of_staff:task_create:ext",
      payload: { title: "Made-up hiring plan for Almaty" },
    });
    const externalRow = external.structuredContent.id as string;
    expect(await rowOf(t, externalRow)).toMatchObject({ bot: "chief_of_staff" });

    // The external profile (named through the Grok client) and the Mac's agent each see the other's as not theirs.
    const byExternal = await call(t, grok, "proposal_withdraw", { agent: "chief_of_staff", id: macRow, reason: "stale" });
    expect(byExternal.refusal).toEqual({ code: "not_owner" });
    const byMac = await call(t, mac, "proposal_withdraw", { agent: "chief_of_staff", id: externalRow, reason: "stale" });
    expect(byMac.refusal).toEqual({ code: "not_owner" });

    // Each its own.
    expect((await call(t, grok, "proposal_withdraw", { agent: "chief_of_staff", id: externalRow, reason: "stale" })).output).toMatchObject({
      withdrawn: true,
    });
    expect((await rowOf(t, externalRow))!.withdrawnBy).toBe("bot:chief_of_staff");
    expect((await call(t, mac, "proposal_withdraw", { agent: "chief_of_staff", id: macRow, reason: "stale" })).output).toMatchObject({
      withdrawn: true,
    });
  });

  test("a bot with no write anywhere is refused as for propose", async () => {
    const { t, owner, grok } = await setUp();
    const id = await made(t, grok, proposal("growth", "growth:task_create:one", "Made-up pricing page copy"));
    const row = (await owner.query(api.bots.list, { today: "2026-10-14" })).bots.find((b) => b.botId === "growth")!;
    await owner.mutation(api.bots.update, { id: row.id, permissions: [{ area: "board", level: "read" }] });
    const reply = await call(t, grok, "proposal_withdraw", { agent: "growth", id, reason: "stale" });
    expect(reply.refusal).toMatchObject({ code: "not_permitted", tool: "proposal_withdraw" });
    expect((await rowOf(t, id))!.status).toBe("open");
  });
});

describe("the key", () => {
  test("a withdrawn key is released at once; one withdrawn as wrong is held for 7 days", async () => {
    const { t, grok } = await setUp();
    const key = "growth:task_create:copy";
    const first = await made(t, grok, proposal("growth", key, "Made-up pricing page copy"));
    await call(t, grok, "proposal_withdraw", { agent: "growth", id: first, reason: "duplicate" });
    // Released: the same key again is fine.
    const second = await made(t, grok, proposal("growth", key, "Made-up pricing page copy"));
    await call(t, grok, "proposal_withdraw", { agent: "growth", id: second, reason: "wrong" });
    const held = await call(t, grok, "propose", proposal("growth", key, "Made-up pricing page copy"));
    expect(held.said).toBe(PROPOSAL_WORDS.repeatWithdrawnWrong);
    expect(held.refusal).toEqual({ code: "repeat" });
    vi.setSystemTime(NOW + (WRONG_WITHDRAW_BLOCKS_DAYS + 1) * DAY);
    expect((await call(t, grok, "propose", proposal("growth", key, "Made-up pricing page copy"))).output).toMatchObject({ proposed: true });
  });
});

describe("what the bot and the owner are told", () => {
  test("proposals_feedback and my_inbox list a withdrawn proposal with its reason, note and replacement", async () => {
    const { t, grok } = await setUp();
    const old = await made(t, grok, proposal("growth", "growth:task_create:old", "Made-up pricing page copy"));
    const next = await made(t, grok, proposal("growth", "growth:task_create:new", "Made-up onboarding email sequence"));
    await call(t, grok, "proposal_withdraw", { agent: "growth", id: old, reason: "superseded", note: "Made-up: merged.", replacedBy: next });

    const feedback = (await call(t, grok, "proposals_feedback", { agent: "growth" })).output;
    expect(feedback.rows).toEqual([
      expect.objectContaining({
        status: "withdrawn",
        decision: "withdrawn",
        withdrawReason: "superseded",
        withdrawNote: "Made-up: merged.",
        replacedBy: next,
        rejection: null,
      }),
    ]);
    expect(feedback.withdrawnKinds).toEqual({ task_create: 1 });
    expect(feedback.rejectedKinds).toEqual({});

    const inbox = (await call(t, grok, "my_inbox", { agent: "growth" })).output;
    expect(inbox.decided).toEqual([
      expect.objectContaining({ id: old, status: "withdrawn", withdrawReason: "superseded", withdrawNote: "Made-up: merged.", replacedBy: next }),
    ]);
  });

  test("the approval rate leaves a withdrawal out; trust neither counts it nor starts the streak again", async () => {
    const { t, owner, grok } = await setUp();
    const approved = await made(t, grok, proposal("growth", "growth:task_create:a", "Made-up pricing page copy"));
    const rejected = await made(t, grok, proposal("growth", "growth:task_create:b", "Made-up onboarding email sequence"));
    const withdrawn = await made(t, grok, proposal("growth", "growth:task_create:c", "Made-up webinar on denials"));
    await owner.mutation(api.assistant.approve, { id: approved as Id<"proposals"> });
    await call(t, grok, "proposal_withdraw", { agent: "growth", id: withdrawn, reason: "stale" });
    const before = await t.run((ctx) => ctx.db.query("botTrust").collect());
    expect(before).toEqual([expect.objectContaining({ proposer: "growth", streak: 1, approved: 1, dismissed: 0 })]);
    await owner.mutation(api.assistant.dismiss, { id: rejected as Id<"proposals">, code: "wrong_data" });

    const stats = await owner.query(api.bots.weeklyStats, { since: NOW - 7 * DAY });
    expect(stats.find((s) => s.key === "bot:growth")).toMatchObject({ decided: 2, approved: 1, rejected: 1, withdrawn: 1, approvalRate: 0.5 });
    const week = await owner.query(api.bots.telemetry, { today: "2026-10-14" });
    expect(week.find((row) => row.botId === "growth")).toMatchObject({ approvalRate: 0.5 });
  });

  test("the expiry sweep leaves a withdrawn row withdrawn", async () => {
    const { t, grok } = await setUp();
    const id = await made(t, grok, proposal("growth", "growth:task_create:one", "Made-up pricing page copy"));
    await call(t, grok, "proposal_withdraw", { agent: "growth", id, reason: "stale" });
    vi.setSystemTime(NOW + 8 * DAY);
    await t.mutation(internal.assistant.sweep, {});
    expect((await rowOf(t, id))!.status).toBe("withdrawn");
  });
});

describe("withdrawHint", () => {
  test("a possible duplicate names the caller's own matching open proposals, never another proposer's", async () => {
    const { t, grok } = await setUp();
    const mine = await made(t, grok, proposal("growth", "growth:task_create:cap", "Cap transfers to Globex"));
    const theirs = await made(
      t,
      grok,
      proposal("research", "research:task_create:cap", "Cap transfers to Globex now", { force: true, forceReason: "Made-up: research angle" }),
    );
    const near = await call(t, grok, "propose", proposal("growth", "growth:task_create:cap2", "Cap the transfers to Globex"));
    expect(near.refusal).toMatchObject({ code: "possible_duplicate", withdrawHint: [mine] });
    expect(JSON.stringify(near.refusal)).not.toContain(theirs);
    // The other proposer is told only its own.
    const theirsNear = await call(t, grok, "propose", proposal("research", "research:task_create:cap3", "Cap the transfers to Globex"));
    expect(theirsNear.refusal).toMatchObject({ code: "possible_duplicate", withdrawHint: [theirs] });
    expect(JSON.stringify(theirsNear.refusal)).not.toContain(mine);
    // Withdraw and refile in one step.
    await call(t, grok, "proposal_withdraw", { agent: "growth", id: mine, reason: "superseded" });
    expect((await call(t, grok, "propose", proposal("growth", "growth:task_create:cap2", "Cap the transfers to Globex", {
      force: true,
      forceReason: "Made-up: replaces my earlier card",
    }))).output).toMatchObject({ proposed: true });
  });
});
