import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import { SEEDED_TABLES } from "./devSeed";
import { companyOfMetric } from "./lib/company";
import { LOCAL_OWNER_EMAIL } from "./lib/devLocal";
import type { FeatureId } from "./lib/features";
import schema from "./schema";
import { modules } from "./test.setup";

// The made-up data set in one-company mode: with the `secondCompany` switch
// of convex/lib/features.ts off, the seed writes nothing of the second
// company. Main has both; the case turns the switch off and `afterEach` puts
// it back. Everything here is made up.

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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-10-13T12:00:00Z"));
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");
  vi.stubEnv("CONVEX_SITE_URL", "http://127.0.0.1:3211");
  vi.stubEnv("OWNER_EMAILS", LOCAL_OWNER_EMAIL);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const feature of Object.keys(switches) as FeatureId[]) switches[feature] = true;
});

test("one company: the seed holds nothing of the second company", { timeout: 60_000 }, async () => {
  switches.secondCompany = false;
  const t = convexTest(schema, modules);
  const counts = await t.mutation(internal.devSeed.run, {});
  expect(counts.tasks).toBeGreaterThan(0);
  expect(counts.deals).toBeGreaterThan(0);
  for (const table of ["kzAppClinics", "customerUsage", "customerDoctors", "kzBreakdowns", "supportConversations"]) {
    expect(counts[table], table).toBeUndefined();
  }
  const rows = await t.run(async (ctx) => {
    const all: Record<string, unknown>[] = [];
    for (const table of SEEDED_TABLES) all.push(...(await ctx.db.query(table).collect()));
    return all;
  });
  for (const row of rows) {
    expect(row.company).not.toBe("kz");
    expect(row.market).not.toBe("kz");
    if (Array.isArray(row.companies)) expect(row.companies).not.toContain("kz");
    if (typeof row.key === "string" && typeof row.scope === "string") {
      expect(companyOfMetric(row.key, row.scope)).toBe("us");
    }
  }
});
