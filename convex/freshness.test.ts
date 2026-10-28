import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { MIRROR_SOURCES } from "./lib/mirrorRules";
import schema from "./schema";
import {
  OWNER,
  memberEmail,
  modules,
  signInAsCofounder,
  signInAsEngineer,
  signInAsOwner,
  signInAsSales,
  signInWithAreas,
  type TestBackend,
} from "./test.setup";

// `freshness.forPage`: what each page's "Updated …" line is told, and that it
// is told only what the page's own data is gated to.

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const ALL_SOURCES = [
  "mercury",
  "cfo_workbook",
  "client_register",
  "financial_model",
  "posthog",
  "posthog_globex",
  "vercel",
  "vertical_startup",
  "apollo",
  "search_console",
  "visible",
  "kz_crm",
  "github",
  ...MIRROR_SOURCES,
];

/** Every source ran: some well, Mercury's last run failed after a good one. */
async function seed(t: TestBackend) {
  await t.run(async (ctx) => {
    for (const source of ALL_SOURCES) {
      await ctx.db.insert("sourceStatus", {
        source,
        state: source === "mercury" ? "error" : "ok",
        message: source === "mercury" ? "Set MERCURY_API_TOKEN on the Convex deployment." : undefined,
        lastRunAt: 200,
        lastOkAt: 100,
      });
    }
    // Typed in: Startup's MRR (finance), Globex's month-end cash (finance),
    // and LinkedIn followers (marketing, Startup).
    const typed = (key: string, scope: string, period: "month" | "day" | "week", periodStart: string, syncedAt: number) =>
      ctx.db.insert("metricSnapshots", { key, scope, period, periodStart, value: 7, source: "manual", syncedAt });
    await typed("mrr", "us", "month", "2026-09-01", 300);
    await typed("mrr", "us", "month", "2026-08-01", 350);
    await typed("cash", "kz", "day", "2026-09-30", 400);
    await typed("linkedin_followers", "company", "week", "2026-09-28", 500);
  });
}

type Client = Awaited<ReturnType<typeof signInAsOwner>>;
const ids = async (client: Client, page: string, company: "us" | "kz") =>
  (await client.query(api.freshness.forPage, { page, company })).map((row) => row.id);

describe("which sources a page is told of", () => {
  test("the owner: every source of the page, in the company in view", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const owner = await signInAsOwner(t);
    expect(await ids(owner, "finance", "us")).toEqual(["manual", "mercury", "financial_model"]);
    // PostHog brings Globex's AI token cost, a finance figure.
    expect(await ids(owner, "finance", "kz")).toEqual(["manual", "cfo_workbook", "posthog_globex"]);
    expect(await ids(owner, "product", "us")).toEqual(["posthog", "vercel", "vertical_startup"]);
    expect(await ids(owner, "sales", "kz")).toEqual(["kz_crm"]);
    expect(await ids(owner, "sales", "us")).toEqual([]);
    expect(await ids(owner, "board_linear", "us")).toEqual(["linear"]);
  });

  test("a failed run is a key, never the message it stored", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const rows = await (await signInAsOwner(t)).query(api.freshness.forPage, {
      page: "finance",
      company: "us",
    });
    const mercury = rows.find((row) => row.id === "mercury")!;
    expect(mercury).toMatchObject({ state: "error", failureKey: "failed", lastOkAt: 100, lastRunAt: 200 });
    expect(JSON.stringify(rows)).not.toContain("MERCURY_API_TOKEN");
    expect(mercury.cadence).toEqual({ kind: "daily", hourUtc: 6, minuteUtc: 0 });
  });

  test("typed-in figures are one row, timed by the newest entry the caller may see", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const owner = await signInAsOwner(t);
    const manual = async (page: string, company: "us" | "kz") =>
      (await owner.query(api.freshness.forPage, { page, company })).find((r) => r.id === "manual");
    expect(await manual("finance", "us")).toMatchObject({ label: "Typed-in figures", lastOkAt: 350 });
    expect(await manual("finance", "kz")).toMatchObject({ lastOkAt: 400 });
    expect(await manual("gtm", "us")).toMatchObject({ lastOkAt: 500 });
  });

  test("Today: the sources behind the company blocks the viewer can see, each gated by its own area", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    // An engineer: Product and Engineering's sources, never finance's or their mail's.
    expect(await ids(await signInAsEngineer(t), "today", "us")).toEqual(
      expect.not.arrayContaining(["mercury", "gmail", "google_calendar"]),
    );
    // Sales: sales, customers and go to market; no work tool without `today`.
    expect(await ids(await signInAsSales(t), "today", "kz")).toEqual(["client_register", "kz_crm"]);
    expect(await ids(await signInAsSales(t, ["us"]), "today", "us")).toEqual([
      "manual",
      "apollo",
      "search_console",
    ]);
  });

  test("Support: Intercom, for a holder of Support on Globex, and on Today for them too", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const holder = await signInWithAreas(t, "engineer", ["support"], ["kz"]);
    expect(await ids(holder, "support", "kz")).toEqual(["intercom"]);
    expect(await ids(holder, "today", "kz")).toEqual(["intercom"]);
    const sales = await signInAsSales(t, ["kz"]);
    expect(await ids(sales, "support", "kz")).toEqual([]);
    expect(await ids(sales, "today", "kz")).not.toContain("intercom");
  });

  test("an unknown page, or a company the caller is not on, is an empty list", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const cofounder = await signInAsCofounder(t, ["kz"]);
    expect(await ids(cofounder, "nothing", "kz")).toEqual([]);
    expect(await ids(cofounder, "finance", "us")).toEqual([]);
  });
});

describe("a teammate without a page's area is told nothing of its sources", () => {
  test.each([
    ["finance", "us"],
    ["finance", "kz"],
    ["product", "us"],
    ["engineering", "kz"],
    ["fundraising", "us"],
    ["customers", "kz"],
    ["sales", "kz"],
    ["gtm", "us"],
    ["today", "us"],
    ["board_linear", "us"],
  ] as const)("%s, %s", async (page, company) => {
    const t = convexTest(schema, modules);
    await seed(t);
    // The scorecard alone opens Today and nothing its blocks sum up, and no one's own tools.
    const client = await signInWithAreas(t, "sales", ["scorecard"]);
    expect(await ids(client, page, company)).toEqual([]);
    expect(await ids(client, "today", company)).toEqual([]);
  });

  test("Product without Engineering is not told of GitHub, and the other way round", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const product = await signInWithAreas(t, "engineer", ["product"]);
    expect(await ids(product, "engineering", "us")).toEqual([]);
    const engineering = await signInWithAreas(t, "sales", ["engineering"], ["us"]);
    expect(await ids(engineering, "engineering", "us")).toEqual(["github"]);
    expect(await ids(engineering, "product", "us")).toEqual([]);
  });

  test("go to market without Product: PostHog's web figures are not theirs, so neither is PostHog", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const gtm = await signInWithAreas(t, "sales", ["gtm"], ["us"]);
    expect(await ids(gtm, "gtm", "us")).toEqual(["manual", "apollo", "search_console"]);
  });
});

describe("a Globex-only teammate never gets a Startup source", () => {
  test("whatever page they ask for, in either company", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const kzOnly = await signInAsCofounder(t, ["kz"]);
    const startup = ["mercury", "financial_model", "vercel", "vertical_startup", "apollo", "search_console", "visible"];
    for (const page of ["today", "finance", "product", "engineering", "gtm", "sales", "fundraising", "customers", "board_linear"]) {
      for (const company of ["us", "kz"] as const) {
        const got = await ids(kzOnly, page, company);
        for (const id of startup) expect([page, company, got.includes(id as never)]).toEqual([page, company, false]);
      }
    }
    // And their own company's are there.
    expect(await ids(kzOnly, "finance", "kz")).toEqual(["manual", "cfo_workbook", "posthog_globex"]);
  });

  test("and a Startup-only teammate never gets a Globex source", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const usOnly = await signInAsCofounder(t, ["us"]);
    for (const page of ["today", "finance", "product", "sales", "customers"]) {
      for (const company of ["us", "kz"] as const) {
        const got = await ids(usOnly, page, company);
        for (const id of ["cfo_workbook", "client_register", "kz_crm"]) {
          expect([page, company, got.includes(id as never)]).toEqual([page, company, false]);
        }
      }
    }
  });

  test("typed-in figures follow the company too", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const kzOnly = await signInAsCofounder(t, ["kz"]);
    const rows = await kzOnly.query(api.freshness.forPage, { page: "finance", company: "kz" });
    // Startup's typed MRR (350) is not theirs; Globex's typed cash (400) is.
    expect(rows.find((r) => r.id === "manual")?.lastOkAt).toBe(400);
  });
});

describe("Today: the caller's own work tools, and nobody else's", () => {
  const today = (client: Client) => client.query(api.freshness.forPage, { page: "today", company: "us" });

  async function teammateStatus(t: TestBackend, email: string, lastOkAt: number) {
    await t.run(async (ctx) => {
      const user = (await ctx.db.query("users").collect()).find((u) => u.email === email)!;
      await ctx.db.insert("personalSourceStatus", {
        owner: email,
        userId: user._id,
        source: "gmail",
        state: "ok",
        lastRunAt: lastOkAt,
        lastOkAt,
      });
    });
  }

  test("the owner is told of the deployment's own tools, judged by their schedule", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    // Today also sums up the company's blocks: the owner's own tools are among them.
    const rows = (await today(await signInAsOwner(t))).filter((r) =>
      (MIRROR_SOURCES as readonly string[]).includes(r.id),
    );
    expect(rows.map((r) => r.id)).toEqual(["gmail", "google_calendar", "linear", "fireflies"]);
    expect(rows.find((r) => r.id === "gmail")).toMatchObject({
      lastOkAt: 100,
      cadence: { kind: "every", minutes: 15 },
    });
  });

  test("a tool the owner switched off is not listed", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("workToolSettings", { off: ["fireflies"], investorDomains: [], customerDomains: [] });
    });
    expect((await today(await signInAsOwner(t))).map((r) => r.id)).not.toContain("fireflies");
  });

  test("a teammate is told of their own pushes, never the owner's or another teammate's", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const ada = await signInWithAreas(t, "sales", ["today"]);
    const sam = await signInWithAreas(t, "engineer", ["today"]);
    await teammateStatus(t, memberEmail("engineer"), 900);
    const adaRows = await today(ada);
    // Ada has pushed nothing: no read, whatever the owner's or Sam's tools say.
    expect(adaRows.map((r) => [r.id, r.lastOkAt])).toEqual(MIRROR_SOURCES.map((id) => [id, null]));
    expect(adaRows[0]!.cadence).toEqual({ kind: "pushed", everyDays: 1 });
    expect((await today(sam)).find((r) => r.id === "gmail")?.lastOkAt).toBe(900);
  });

  test("a row under the caller's address about another identity is nobody's", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const ada = await signInWithAreas(t, "sales", ["today"]);
    await t.run(async (ctx) => {
      const stranger = await ctx.db.insert("users", {});
      await ctx.db.insert("personalSourceStatus", {
        owner: memberEmail("sales"),
        userId: stranger,
        source: "gmail",
        state: "ok",
        lastRunAt: 700,
        lastOkAt: 700,
      });
    });
    expect((await today(ada)).find((r) => r.id === "gmail")?.lastOkAt).toBeNull();
  });
});
