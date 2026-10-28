import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { OWNER, modules, signInWithAreas } from "./test.setup";

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// Made-up weekly figures of Globex's app: one count, three dollar sums and
// the paying clinics (paying clients, Finance's).
const KEYS = ["checks_started", "ai_cost_total", "module_ai_cost_search", "module_cost_per_result_search", "clinics_paid"];
const MONEY = KEYS.slice(1);

async function seed(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    for (const key of KEYS) {
      await ctx.db.insert("metricSnapshots", {
        key,
        scope: "kz_product",
        period: "week",
        periodStart: "2026-10-12",
        value: 10,
        ...(key === "checks_started" || key === "clinics_paid" ? null : { currency: "USD" }),
        source: "posthog_globex",
        syncedAt: 1,
      });
    }
  });
}

describe("Globex's AI spend is Finance's", () => {
  test("a teammate with Product alone is sent the app's counts but no dollar figure, in the history or the scorecard", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const product = await signInWithAreas(t, "engineer", ["product"]);
    const history = (await product.query(api.kzProduct.history, {})).map((h) => h.key);
    expect(history).toContain("checks_started");
    for (const key of MONEY) expect(history, key).not.toContain(key);
    const tiles = (await product.query(api.metrics.scorecard, {})).tiles.map((tile) => tile.key);
    for (const key of MONEY) expect(tiles, key).not.toContain(key);
  });

  test("with Finance too, the history carries the dollar figures", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const both = await signInWithAreas(t, "engineer", ["product", "finance"]);
    const history = (await both.query(api.kzProduct.history, {})).map((h) => h.key);
    expect(history).toEqual(expect.arrayContaining(KEYS));
  });
});
