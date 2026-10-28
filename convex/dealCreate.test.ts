import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ENTROPY, NOW, call, ownerWithToken, seed } from "./mcp.kit";
import { DEAL_CREATE_WORDS } from "./lib/agents";
import { DUPLICATE_WORDS } from "./lib/duplicates";
import { NEVER_AUTONOMOUS, isAutonomyEligible } from "./lib/trust";
import { NO_CONTACT_DETAILS } from "./lib/pipelineFields";
import schema from "./schema";
import { OWNER, modules, type TestBackend } from "./test.setup";

// Bot Loop v3, section C: a bot proposes a new deal (`deal_create`); the
// owner approves it on /approvals and the deal is made through the Sales
// page's own create function, said to be the proposer's, with its intel.
// A name already on the board (or already proposed) is refused as a possible
// duplicate by the shared near-duplicate check, which `force` passes; the name
// is asked again at the click. Every name is made up.

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
  const ids = await seed(t);
  const { owner } = await ownerWithToken(t, "act");
  const grok = await owner.mutation(api.assistant.createToken, { entropy: ENTROPY, scope: "act", name: "Grok app" });
  await owner.mutation(api.bots.addSuggested, {});
  return { t, ids, owner, grok: grok.token };
}

let made = 0;
const propose = (t: TestBackend, token: string, bot: string, company: "us" | "kz", payload: Record<string, unknown>) =>
  call(t, token, "propose", {
    agent: bot,
    company,
    kind: "deal_create",
    why: "Made-up why.",
    dedupeKey: `bot-${bot}:deal_create:made-up-${(made += 1)}`,
    payload,
  });

const proposals = (t: TestBackend) => t.run((ctx) => ctx.db.query("proposals").collect());
const deals = (t: TestBackend) => t.run((ctx) => ctx.db.query("deals").collect());

describe("deal_create", () => {
  test("approved, a US deal is on /sales at its stage with its intel, said to be the bot's; feedback carries createdId", async () => {
    const { t, owner, grok } = await setUp();
    const asked = await propose(t, grok, "growth", "us", {
      name: "Made-up Specialty",
      stage: "demo",
      contact: "Dana Example, practice manager",
      amount: 24_000,
      region: "TX",
      physicians: 12,
      priority: "high",
      sources: ["Made-up research note"],
      intel: {
        summary: "A made-up practice that bills in house.",
        fit: 80,
        ehr: "Made-up EHR",
        billingModel: "in-house",
        signals: [{ date: "2026-10", kind: "hiring", text: "Hiring a made-up biller." }],
      },
      nextStep: "Book a made-up demo.",
    });
    expect(asked.output).toMatchObject({ proposed: true });
    const row = (await owner.query(api.assistant.inbox, {})).find((p) => p.kind === "deal_create")!;
    expect(row.effect!.changes).toEqual(expect.arrayContaining([{ field: "Name", before: null, after: "Made-up Specialty" }]));

    await owner.mutation(api.assistant.approve, { id: row.id as Id<"proposals"> });
    const board = await owner.query(api.deals.board, { market: "us" });
    const deal = board.demo.find((card) => card.name === "Made-up Specialty")!;
    expect(deal).toMatchObject({ mirrored: false, contact: "Dana Example, practice manager", amount: 24_000, priority: "high", physicians: 12 });
    const stored = await t.run((ctx) => ctx.db.get(deal.id));
    expect(stored).toMatchObject({ createdBy: "growth", nextStep: "Book a made-up demo." });
    const intel = await owner.query(api.dealIntel.get, { dealId: deal.id });
    expect(intel).toMatchObject({ summary: "A made-up practice that bills in house.", ehr: "Made-up EHR", billingModel: "in-house" });
    expect(intel!.fit).toEqual({ score: 80, reasons: [] });

    const feedback = await call(t, grok, "proposals_feedback", { agent: "growth" });
    expect(feedback.output.rows).toEqual([
      expect.objectContaining({ kind: "deal_create", decision: "approved", createdId: deal.id }),
    ]);
  });

  test("a Kazakhstan deal is made here, not mirrored (never synced to the CRM)", async () => {
    const { t, owner, grok } = await setUp();
    await propose(t, grok, "globex_ai_sales", "kz", { name: "Made-up Clinic Almaty", stage: "qualified" });
    const row = (await owner.query(api.assistant.inbox, {})).find((p) => p.kind === "deal_create")!;
    await owner.mutation(api.assistant.approve, { id: row.id as Id<"proposals"> });
    const board = await owner.query(api.deals.board, { market: "kz" });
    expect(board.qualified.find((card) => card.name === "Made-up Clinic Almaty")).toMatchObject({ mirrored: false, source: "manual" });
    // The page itself still makes no Kazakhstan deal.
    await expect(owner.mutation(api.deals.create, { market: "kz", name: "Made-up by hand" })).rejects.toThrow(
      "Kazakhstan deals come from the Kazakhstan CRM",
    );
  });

  test("the owner's edit applies first", async () => {
    const { t, owner, grok } = await setUp();
    await propose(t, grok, "growth", "us", { name: "Made-up Spine", nextStep: "Call." });
    const row = (await owner.query(api.assistant.inbox, {})).find((p) => p.kind === "deal_create")!;
    await owner.mutation(api.assistant.approve, {
      id: row.id as Id<"proposals">,
      edit: { name: "Made-up Spine Center", nextStep: "Call on Monday." },
    });
    const made = (await deals(t)).find((deal) => deal.name === "Made-up Spine Center");
    expect(made).toMatchObject({ nextStep: "Call on Monday.", stage: "lead" });
    const decided = (await proposals(t)).find((p) => p.kind === "deal_create")!;
    expect(decided.editedBeforeApprove).toBe(true);
  });

  test("a name already on the board, whatever its capitals and suffix, is a possible duplicate with the deal's id", async () => {
    const { t, ids, grok } = await setUp();
    // Through the shared near-duplicate check (convex/lib/duplicates.ts): its words, its matches.
    const dup = await propose(t, grok, "growth", "us", { name: "  example   US deal, LLC " });
    expect(dup.said).toBe(DUPLICATE_WORDS.possible);
    expect(dup.refusal).toEqual({
      code: "possible_duplicate",
      matches: [{ type: "deal", id: ids.usDeal, title: "Example US Deal", sim: 1 }],
    });
    // A mirrored Kazakhstan deal's name is one too.
    const kz = await propose(t, grok, "globex_ai_sales", "kz", { name: "Example KZ Deal" });
    expect(kz.refusal).toMatchObject({ code: "possible_duplicate", matches: [{ type: "deal", id: ids.kzDeal }] });
    expect(await proposals(t)).toEqual([]);
    // Each refused check is logged as deal_create's, with numbers only.
    const checks = await t.run((ctx) => ctx.db.query("duplicateChecks").collect());
    expect(checks.map((c) => [c.tool, c.decision, c.sim])).toEqual([
      ["deal_create", "refused", 1],
      ["deal_create", "refused", 1],
    ]);
  });

  test("a name already proposed and open is a possible duplicate of that proposal", async () => {
    const { t, grok } = await setUp();
    const first = await propose(t, grok, "growth", "us", { name: "Made-up Hand Clinic" });
    const id = first.output.id as string;
    const second = await propose(t, grok, "research", "us", { name: "made-up hand clinic" });
    // A bot is told it is a proposal and how near, never the proposal's id or title (botSecurity.test.ts).
    expect(second.refusal).toEqual({ code: "possible_duplicate", matches: [{ type: "proposal", sim: 1 }] });
    expect(second.text).not.toContain(id);
  });

  test("forced past a deal of that name, it stores duplicateOf and forceReason, and approving it still makes the deal", async () => {
    const { t, ids, owner, grok } = await setUp();
    const forced = await propose(t, grok, "growth", "us", {
      name: "Example US Deal",
    });
    expect(forced.refusal).toMatchObject({ code: "possible_duplicate" });
    const again = await call(t, grok, "propose", {
      agent: "growth",
      company: "us",
      kind: "deal_create",
      why: "Made-up why.",
      dedupeKey: "bot-growth:deal_create:made-up-forced",
      payload: { name: "Example US Deal" },
      force: true,
      forceReason: "A second practice of the same name, in another state.",
    });
    expect(again.output).toMatchObject({ proposed: true });
    const row = (await proposals(t)).find((p) => p.kind === "deal_create")!;
    expect(row).toMatchObject({ duplicateOf: [ids.usDeal], forceReason: "A second practice of the same name, in another state." });
    const checks = await t.run((ctx) => ctx.db.query("duplicateChecks").collect());
    expect(checks.at(-1)).toMatchObject({ tool: "deal_create", decision: "forced" });
    // The click's own recheck lets through the deal it was forced past.
    await owner.mutation(api.assistant.approve, { id: row._id });
    expect((await deals(t)).filter((deal) => deal.name === "Example US Deal")).toHaveLength(2);
  });

  test("the name is asked again at the click: a deal of that name made since is refused", async () => {
    const { t, owner, grok } = await setUp();
    await propose(t, grok, "growth", "us", { name: "Made-up Knee Center" });
    const row = (await owner.query(api.assistant.inbox, {})).find((p) => p.kind === "deal_create")!;
    const madeSince = await owner.mutation(api.deals.create, { market: "us", name: "Made-up Knee Center" });
    await expect(owner.mutation(api.assistant.approve, { id: row.id as Id<"proposals"> })).rejects.toThrow(
      DEAL_CREATE_WORDS.duplicateDeal(madeSince),
    );
    expect((await deals(t)).filter((deal) => deal.name === "Made-up Knee Center")).toHaveLength(1);
  });

  test("forced past one deal, a second of that name made since is still refused at the click", async () => {
    const { t, ids, owner, grok } = await setUp();
    await call(t, grok, "propose", {
      agent: "growth",
      company: "us",
      kind: "deal_create",
      why: "Made-up why.",
      dedupeKey: "bot-growth:deal_create:made-up-forced-2",
      payload: { name: "Example US Deal" },
      force: true,
      forceReason: "Another practice of that name.",
    });
    const row = (await proposals(t)).find((p) => p.kind === "deal_create")!;
    expect(row.duplicateOf).toEqual([ids.usDeal]);
    const madeSince = await owner.mutation(api.deals.create, { market: "us", name: "Example US Deal" });
    await expect(owner.mutation(api.assistant.approve, { id: row._id })).rejects.toThrow(DEAL_CREATE_WORDS.duplicateDeal(madeSince));
  });

  test("a contact with an email or phone, intel on a Kazakhstan deal and US-only details on one are refused", async () => {
    const { t, grok } = await setUp();
    expect((await propose(t, grok, "growth", "us", { name: "Made-up A", contact: "dana@example.com" })).said).toBe(NO_CONTACT_DETAILS);
    expect((await propose(t, grok, "growth", "us", { name: "Made-up B", contact: "Dana, +1 555 123 4567" })).said).toBe(
      NO_CONTACT_DETAILS,
    );
    expect((await propose(t, grok, "growth", "us", { name: "Made-up C", nextStep: "Mail dana@example.com" })).said).toBe(
      NO_CONTACT_DETAILS,
    );
    expect((await propose(t, grok, "globex_ai_sales", "kz", { name: "Made-up D", intel: { summary: "x" } })).said).toBe(
      DEAL_CREATE_WORDS.usOnly,
    );
    expect((await propose(t, grok, "globex_ai_sales", "kz", { name: "Made-up E", priority: "high" })).said).toBe(
      DEAL_CREATE_WORDS.usOnly,
    );
    expect((await propose(t, grok, "growth", "us", { name: "Made-up F", stage: "won" })).isError).toBe(true);
    expect(await proposals(t)).toEqual([]);
  });

  test("never autonomy-eligible", () => {
    expect(isAutonomyEligible("deal_create")).toBe(false);
    expect(NEVER_AUTONOMOUS).toContain("deal_create");
  });
});
