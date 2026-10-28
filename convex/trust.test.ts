import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { PROPOSAL_KINDS } from "./lib/agents";
import { isLockedBotArea } from "./lib/botRules";
import {
  AUTONOMY_ELIGIBLE,
  KIND_AREA,
  NEVER_AUTONOMOUS,
  OFFER_AFTER,
  TRUST_WORDS,
  isAutonomyEligible,
} from "./lib/trust";
import { NOW, addSam, answer, call, ownerWithToken, seed } from "./mcp.kit";
import schema from "./schema";
import { OWNER, modules, type TestBackend } from "./test.setup";

// Earned autonomy (Revision 7 §4): trust per (proposer, kind), the offer after
// ten clean approvals, grants, auto-approval through the normal approve path,
// the Auto-approved feed and the never-list. Every title and name is made up.

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
  const { owner, token } = await ownerWithToken(t, "act");
  await addSam(t);
  return { t, ids, owner, token };
}
type World = Awaited<ReturnType<typeof world>>;

let made = 0;
const propose = async (w: World, kind: string, payload: unknown) =>
  (
    await answer(w.t, w.token, "propose", {
      agent: "engineering",
      company: "us",
      kind,
      reason: "Made-up reason.",
      dedupeKey: `engineering:${kind}:made-up-${(made += 1)}`,
      payload,
    })
  ).id as Id<"proposals">;
const newTask = (w: World) => propose(w, "task_create", { title: `Made-up task ${made}` });
const row = (t: TestBackend, id: Id<"proposals">) => t.run((ctx) => ctx.db.get(id));
const trustOf = (t: TestBackend, proposer: string, kind: string) =>
  t.run((ctx) =>
    ctx.db
      .query("botTrust")
      .withIndex("by_proposer_and_kind", (q) => q.eq("proposer", proposer).eq("kind", kind as never))
      .unique(),
  );

/** `count` clean approvals of new tasks by the engineering agent. */
async function approveClean(w: World, count: number) {
  for (let i = 0; i < count; i += 1) {
    const id = await newTask(w);
    await w.owner.mutation(api.assistant.approve, { id });
  }
}

describe("the never-list is the server's", () => {
  test("eligible and never cover every kind; only the four are eligible, none of a locked area", () => {
    expect([...AUTONOMY_ELIGIBLE].sort()).toEqual(["deal_next_step", "decision_record", "task_change", "task_create"]);
    expect([...AUTONOMY_ELIGIBLE, ...NEVER_AUTONOMOUS].sort()).toEqual([...PROPOSAL_KINDS].sort());
    for (const kind of PROPOSAL_KINDS) {
      expect(isAutonomyEligible(kind)).toBe((AUTONOMY_ELIGIBLE as readonly string[]).includes(kind));
    }
    for (const kind of AUTONOMY_ELIGIBLE) expect(isLockedBotArea(KIND_AREA[kind])).toBe(false);
    // A name that is no kind (a crafted one, or a future one) is never eligible.
    for (const kind of ["bot_permission", "deal_stage", "payment", "vendor_agreement", "goal_create", "draft"]) {
      expect(isAutonomyEligible(kind)).toBe(false);
    }
  });
});

describe("trust and the offer", () => {
  test("ten clean approvals make the offer; an edit resets the streak and is kept", async () => {
    const w = await world();
    await approveClean(w, OFFER_AFTER - 1);
    expect(await w.owner.query(api.trust.offers, {})).toEqual([]);
    expect(await trustOf(w.t, "engineering", "task_create")).toMatchObject({ streak: 9, approved: 9 });

    // An edit before approving: approved, but the streak starts again and the change is kept.
    const id = await newTask(w);
    await w.owner.mutation(api.assistant.approve, { id, edit: { title: "Made-up: owner's title" } });
    const reset = (await trustOf(w.t, "engineering", "task_create"))!;
    expect(reset).toMatchObject({ streak: 0, edited: 1, lastResetAt: NOW });
    // What was changed is the proposal's own `edits` (Approvals v2), which the trust row points at.
    expect(reset.lastEditedProposal).toBe(id);
    expect((await row(w.t, id))!.edits).toEqual([
      expect.objectContaining({ field: "title", after: "Made-up: owner's title" }),
    ]);

    await approveClean(w, OFFER_AFTER);
    const offers = await w.owner.query(api.trust.offers, {});
    expect(offers).toEqual([
      expect.objectContaining({ proposer: "engineering", kind: "task_create", streak: OFFER_AFTER }),
    ]);
  });

  test("a dismissal resets the streak", async () => {
    const w = await world();
    await approveClean(w, 4);
    const id = await newTask(w);
    await w.owner.mutation(api.assistant.dismiss, { id, reason: "Made-up: not now" });
    expect(await trustOf(w.t, "engineering", "task_create")).toMatchObject({ streak: 0, dismissed: 1, approved: 4 });
  });

  test("Not yet asks again only after ten more clean approvals", async () => {
    const w = await world();
    await approveClean(w, OFFER_AFTER);
    await w.owner.mutation(api.trust.notYet, { proposer: "engineering", kind: "task_create" });
    expect(await w.owner.query(api.trust.offers, {})).toEqual([]);
    await approveClean(w, OFFER_AFTER - 1);
    expect(await w.owner.query(api.trust.offers, {})).toEqual([]);
    await approveClean(w, 1);
    expect(await w.owner.query(api.trust.offers, {})).toHaveLength(1);
  });
});

describe("grants", () => {
  test("a grant before it is earned is refused", async () => {
    const w = await world();
    await approveClean(w, 3);
    await expect(
      w.owner.mutation(api.trust.grant, { proposer: "engineering", kind: "task_create" }),
    ).rejects.toThrow(TRUST_WORDS.notEarned);
  });

  test("a never-list kind is refused even with a streak written by hand, and a crafted grant does nothing", async () => {
    const w = await world();
    await w.t.run((ctx) =>
      ctx.db.insert("botTrust", {
        proposer: "engineering",
        kind: "draft",
        streak: 50,
        approved: 50,
        edited: 0,
        dismissed: 0,
        autoApproved: 0,
        offerAt: OFFER_AFTER,
        updatedAt: NOW,
      }),
    );
    expect(await w.owner.query(api.trust.offers, {})).toEqual([]);
    await expect(w.owner.mutation(api.trust.grant, { proposer: "engineering", kind: "draft" })).rejects.toThrow(
      TRUST_WORDS.neverEligible,
    );
    // A grant row put in by hand, not through `grant`: the draft still waits.
    const owner = (await w.t.run((ctx) => ctx.db.query("users").first()))!._id;
    for (const kind of ["draft", "goal_create"] as const) {
      await w.t.run((ctx) =>
        ctx.db.insert("autonomyGrants", { userId: owner, proposer: "engineering", kind, grantedAt: NOW }),
      );
    }
    const draft = await propose(w, "draft", { title: "Made-up draft", body: "Made-up body." });
    expect((await row(w.t, draft))!.status).toBe("open");
  });

  test("a granted kind is approved at once through the approve path, logged in the feed; revoking stops it", async () => {
    const w = await world();
    await approveClean(w, OFFER_AFTER);
    await w.owner.mutation(api.trust.grant, { proposer: "engineering", kind: "task_create" });
    expect(await w.owner.query(api.trust.offers, {})).toEqual([]);
    expect(await w.owner.query(api.trust.grants, {})).toEqual([
      expect.objectContaining({ proposer: "engineering", kind: "task_create", name: "Engineering manager" }),
    ]);

    const id = await propose(w, "task_create", { title: "Made-up: done without asking" });
    const auto = (await row(w.t, id))!;
    expect(auto).toMatchObject({ status: "auto_approved", decidedAt: NOW, editedBeforeApprove: false });
    const task = await w.t.run((ctx) => ctx.db.get((auto.result as { taskId: Id<"tasks"> }).taskId));
    expect(task).toMatchObject({ title: "Made-up: done without asking", origin: { source: "agent", agent: "engineering" } });
    // Not in the inbox; among what was decided, as approved automatically (/approvals' "Decided").
    expect((await w.owner.query(api.assistant.inbox, {})).map((r) => r.id)).not.toContain(id);
    const decided = await w.owner.query(api.assistant.decided, { since: 0 });
    expect(decided.filter((r) => r.status === "auto_approved")).toEqual([
      expect.objectContaining({ id, kind: "task_create", flagged: false }),
    ]);
    // Another kind of the same proposer is not covered.
    const step = await propose(w, "deal_next_step", { dealId: w.ids.usDeal, nextStep: "Made-up step" });
    expect((await row(w.t, step))!.status).toBe("open");

    await w.owner.mutation(api.trust.revoke, { proposer: "engineering", kind: "task_create" });
    expect(await w.owner.query(api.trust.grants, {})).toEqual([]);
    const after = await newTask(w);
    expect((await row(w.t, after))!.status).toBe("open");
  });

  test("flagging an auto-approved item revokes the grant and tells the proposer why", async () => {
    const w = await world();
    await approveClean(w, OFFER_AFTER);
    await w.owner.mutation(api.trust.grant, { proposer: "engineering", kind: "task_create" });
    const id = await newTask(w);
    await w.owner.mutation(api.trust.flag, { id, reason: "Made-up: wrong board" });
    expect(await w.owner.query(api.trust.grants, {})).toEqual([]);
    expect((await w.owner.query(api.assistant.decided, { since: 0 })).find((r) => r.id === id)).toMatchObject({
      status: "auto_approved",
      flagged: true,
      rejectReason: "Made-up: wrong board",
    });
    expect(await trustOf(w.t, "engineering", "task_create")).toMatchObject({ streak: 0, dismissed: 1 });
    const fed = (await answer(w.t, w.token, "proposals_feedback")).rows as Record<string, unknown>[];
    expect(fed.find((r) => r.status === "auto_approved")).toMatchObject({
      decision: "auto_approved",
      rejectReason: "Made-up: wrong board",
      dismissReason: "Made-up: wrong board",
    });
    // Only an auto-approved item can be flagged.
    const open = await newTask(w);
    expect((await row(w.t, open))!.status).toBe("open");
    await expect(w.owner.mutation(api.trust.flag, { id: open })).rejects.toThrow(TRUST_WORDS.notAuto);
  });

  test("an auto-approved proposal's key is a repeat like an approved one", async () => {
    const w = await world();
    await approveClean(w, OFFER_AFTER);
    await w.owner.mutation(api.trust.grant, { proposer: "engineering", kind: "task_create" });
    const args = {
      agent: "engineering",
      company: "us",
      kind: "task_create",
      reason: "r",
      dedupeKey: "engineering:task_create:made-up-repeat",
      payload: { title: "Made-up: once" },
    };
    await answer(w.t, w.token, "propose", args);
    expect((await call(w.t, w.token, "propose", args)).isError).toBe(true);
  });
});
