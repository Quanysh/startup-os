import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { APP_ID, NOW_MS, conversation, searchPage } from "./connectors/intercom.fixtures";
import { FEATURE_OFF } from "./lib/featureGates";
import type { FeatureId } from "./lib/features";
import { COMPANY_NOT_IN_USE } from "./lib/company";
import { CURRENCY_NOT_OFFERED } from "./lib/customerShape";
import { call, ownerWithToken, rpc } from "./mcp.kit";
import { NOT_ALLOWED } from "./lib/owner";
import { parseSearch, toRecord } from "./lib/supportParse";
import schema from "./schema";
import { OWNER, modules, signInAsMember, signInAsOwner, type TestBackend } from "./test.setup";

// Each switch of convex/lib/features.ts off, against the backend: what it
// takes away refuses, does nothing, or is left out. Every switch is on in
// main; a case turns one off and `afterEach` puts it back. Every token,
// address and figure here is made up.

const switches = vi.hoisted(() => ({
  secondCompany: true,
  subsidiaryFunding: true,
  kzProduct: true,
  supportInbox: true,
  verticalStartupAgents: true,
  startupInsights: true,
  verticalStartupProduct: true,
  kztCurrency: true,
}));
vi.mock("./lib/features", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/features")>()),
  // The made-up deployment's ids, as every test has them (convex/test.deployment.ts).
  ...(await import("./lib/deployment.kit")).MADE_UP_DEPLOYMENT,
  FEATURES: switches,
}));

const off = (feature: FeatureId) => {
  switches[feature] = false;
};

const INTERCOM_TOKEN = "fake-intercom-push-token-0123456789-abcdefg";
const AGENTS_TOKEN = "fake-agents-push-token-0123456789-abcdefgh";

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW_MS));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const feature of Object.keys(switches) as FeatureId[]) switches[feature] = true;
});

const post = (t: TestBackend, token: string, body: unknown) =>
  t.fetch("/ingest/v1", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

const intercomPush = () => ({
  version: 1,
  source: "intercom",
  batchId: "intercom-2026-10-17",
  observedAt: new Date(NOW_MS).toISOString(),
  appIdCode: APP_ID,
  records: [toRecord(parseSearch(searchPage([conversation({})])).conversations[0]!)],
});

const agentsPush = () => ({
  version: 1,
  source: "vertical_agents",
  batchId: "vertical-agents-2026-10-17",
  observedAt: new Date(NOW_MS).toISOString(),
  agentUsage: [
    {
      product: "vertical_startup",
      agentId: "made-up.agent",
      promptVersion: "1",
      provider: "ai_studio",
      model: "made-up-model",
      day: new Date(NOW_MS).toISOString().slice(0, 10),
      calls: 3,
      errors: 0,
      schemaFailures: 0,
      fallbacks: 0,
      refusals: 0,
      inputTokens: 100,
      outputTokens: 10,
    },
  ],
});

const sourceIds = async (owner: Awaited<ReturnType<typeof signInAsOwner>>) =>
  (await owner.query(api.sources.list, {})).map((source) => source.id);

describe("supportInbox off", () => {
  test("the owner holds no Support area, its page's query refuses, and Intercom's push is refused", async () => {
    vi.stubEnv("INGEST_TOKEN_INTERCOM", INTERCOM_TOKEN);
    vi.stubEnv("INGEST_TOKEN_VERTICAL_AGENTS", AGENTS_TOKEN);
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    expect((await owner.query(api.viewer.me, {}))?.areas).toContain("support");

    off("supportInbox");
    expect((await owner.query(api.viewer.me, {}))?.areas).not.toContain("support");
    await expect(owner.query(api.support.overview, {})).rejects.toThrow(NOT_ALLOWED);
    expect(await sourceIds(owner)).not.toContain("intercom");
    const response = await post(t, INTERCOM_TOKEN, intercomPush());
    expect(response.status).toBe(401);
    expect(await t.run((ctx) => ctx.db.query("supportConversations").collect())).toEqual([]);
  });
});

describe("kzProduct off", () => {
  test("Globex's app queries refuse, and its PostHog read does nothing", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    expect(await owner.query(api.kzProduct.history, {})).toEqual([]);

    off("kzProduct");
    await expect(owner.query(api.kzProduct.history, {})).rejects.toThrow(FEATURE_OFF);
    await expect(owner.query(api.kzProduct.appClinics, {})).rejects.toThrow(FEATURE_OFF);
    await expect(owner.query(api.kzProduct.breakdowns, { kind: "hour" })).rejects.toThrow(FEATURE_OFF);
    expect(await sourceIds(owner)).not.toContain("posthog_globex");
    await expect(owner.mutation(api.sources.runNow, { source: "posthog_globex" })).rejects.toThrow(NOT_ALLOWED);
    // The daily cron's handler: no run, no status, nothing written.
    expect(await t.action(internal.connectors.posthogGlobex.sync, {})).toBe("not_configured");
    expect(await t.run((ctx) => ctx.db.query("syncRuns").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("sourceStatus").collect())).toEqual([]);
  });
});

describe("verticalStartupAgents off", () => {
  test("its push is refused, its project is not listed, and sending again refuses", async () => {
    vi.stubEnv("INGEST_TOKEN_VERTICAL_AGENTS", AGENTS_TOKEN);
    vi.stubEnv("INGEST_TOKEN_INTERCOM", INTERCOM_TOKEN);
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const today = new Date(NOW_MS).toISOString().slice(0, 10);
    expect((await post(t, AGENTS_TOKEN, agentsPush())).status).toBe(200);
    // Its usage with no project row (a deploy, then no push yet): listed on usage alone.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("agentProjects").collect()) await ctx.db.delete(row._id);
    });
    expect((await owner.query(api.agentProjects.list, { today })).map((p) => p.slug)).toContain("vertical-startup");

    off("verticalStartupAgents");
    expect((await post(t, AGENTS_TOKEN, agentsPush())).status).toBe(401);
    expect((await owner.query(api.agentProjects.list, { today })).map((p) => p.slug)).not.toContain("vertical-startup");
    await expect(owner.mutation(api.agentControl.resend, {})).rejects.toThrow(FEATURE_OFF);
    expect(await sourceIds(owner)).not.toContain("vertical_agents");
  });
});

describe("startupInsights off", () => {
  test("its two sources are not listed, not run and their crons do nothing", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    expect(await sourceIds(owner)).toEqual(expect.arrayContaining(["posthog", "vercel"]));

    off("startupInsights");
    const ids = await sourceIds(owner);
    expect(ids).not.toContain("posthog");
    expect(ids).not.toContain("vercel");
    expect(ids).toContain("mercury");
    await expect(owner.mutation(api.sources.runNow, { source: "posthog" })).rejects.toThrow(NOT_ALLOWED);
    expect(await t.action(internal.connectors.posthog.sync, {})).toBe("not_configured");
    expect(await t.action(internal.connectors.vercel.sync, {})).toBe("not_configured");
    expect(await t.run((ctx) => ctx.db.query("syncRuns").collect())).toEqual([]);
  });
});

describe("kztCurrency off", () => {
  const line = { name: "Example Cloud", category: "cloud", amount: 100_00, cadence: "monthly", startsOn: "2026-10" } as const;

  test("a cost line in tenge is refused, and one left to its company's currency is in dollars", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    off("kztCurrency");
    await expect(owner.mutation(api.costs.add, { company: "kz", ...line, currency: "KZT" })).rejects.toThrow(
      CURRENCY_NOT_OFFERED,
    );
    await owner.mutation(api.costs.add, { company: "kz", ...line });
    expect((await t.run((ctx) => ctx.db.query("costs").collect())).map((row) => row.currency)).toEqual(["USD"]);
  });
});

describe("secondCompany off: one company", () => {
  const line = { name: "Example Cloud", category: "cloud", amount: 100_00, cadence: "monthly", startsOn: "2026-10" } as const;

  test("the owner is on the first company alone", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    expect((await owner.query(api.viewer.me, {}))?.companies).toEqual(["us", "kz"]);
    off("secondCompany");
    expect((await owner.query(api.viewer.me, {}))?.companies).toEqual(["us"]);
  });

  test("a teammate kept on both is on the first alone, and one on the second alone is on none", async () => {
    const t = convexTest(schema, modules);
    const both = await signInAsMember(t, "cofounder", ["us", "kz"]);
    const second = await signInAsMember(t, "sales", ["kz"]);
    off("secondCompany");
    expect((await both.query(api.viewer.me, {}))?.companies).toEqual(["us"]);
    expect((await second.query(api.viewer.me, {}))?.companies ?? []).toEqual([]);
    await expect(second.mutation(api.costs.add, { company: "kz", ...line })).rejects.toThrow();
  });

  test("a write for the second company is refused in fixed words; one for the first is kept", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    off("secondCompany");
    await expect(owner.mutation(api.costs.add, { company: "kz", ...line })).rejects.toThrow(COMPANY_NOT_IN_USE);
    await expect(owner.mutation(api.costs.add, { company: "us", ...line, currency: "KZT" })).rejects.toThrow(
      CURRENCY_NOT_OFFERED,
    );
    await owner.mutation(api.costs.add, { company: "us", ...line });
    expect((await t.run((ctx) => ctx.db.query("costs").collect())).map((row) => [row.company, row.currency])).toEqual([
      ["us", "USD"],
    ]);
  });

  test("the second company's sources are not listed", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    off("secondCompany");
    const listed = await sourceIds(owner);
    for (const source of ["cfo_workbook", "client_register", "kz_crm", "intercom", "posthog_globex"]) {
      expect(listed).not.toContain(source);
    }
    expect(listed).toContain("mercury");
  });

  test("the agents' tools neither offer nor take the second company", async () => {
    const t = convexTest(schema, modules);
    const { token } = await ownerWithToken(t);
    off("secondCompany");
    const init = await rpc(t, token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "made-up-client", version: "0" },
    });
    expect(JSON.stringify(init.body)).not.toMatch(/\\"kz\\"|"kz"/);
    const listed = await rpc(t, token, "tools/list", {});
    expect(JSON.stringify(listed.body)).not.toMatch(/"kz"/);
    const refused = await call(t, token, "tasks", { company: "kz" });
    expect(refused.isError).toBe(true);
    expect(refused.said).toBe(COMPANY_NOT_IN_USE);
    expect((await call(t, token, "tasks", { company: "us" })).isError).toBe(false);
  });
});
