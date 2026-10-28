import { describe, expect, test } from "vitest";
import { METRICS, SOURCE_IDS } from "@convex/lib/metricRegistry";
import { OBLIGATION_CATEGORIES } from "@convex/lib/obligationShape";
import {
  categoryServes,
  companyOfLinearTeam,
  linearTeamServes,
  companyOfMetric,
  marketsOf,
  pageServes,
  sourceServes,
  sourcesOf,
  tilesOf,
} from "./company";
import { productOf, productsOf } from "./metrics/products";

const tile = (key: string, scope: string) => ({ key, scope });

describe("which company a figure belongs to", () => {
  test.each([
    ["mrr", "us", "us"],
    ["mrr", "kz", "kz"],
    ["weekly_active_users", "startup_insights", "us"],
    ["practices", "vertical_startup", "us"],
    ["clinics_using", "kz_product", "kz"],
    // The rate exists to convert tenge.
    ["fx_usd_kzt", "company", "kz"],
    ["search_clicks", "company", "us"],
  ])("%s · %s is %s's", (key, scope, company) => {
    expect(companyOfMetric(key, scope)).toBe(company);
  });

  test("every figure in the registry lands in exactly one company's view", () => {
    const all = METRICS.flatMap((m) => Object.keys(m.sources).map((scope) => tile(m.key, scope)));
    const us = tilesOf("us", all);
    const kz = tilesOf("kz", all);
    expect(us.length + kz.length).toBe(all.length);
    expect(us.filter((t) => kz.includes(t))).toEqual([]);
    expect(kz.length).toBeGreaterThan(0);
  });

  test("a view never holds the other company's figures", () => {
    const all = [tile("mrr", "us"), tile("mrr", "kz"), tile("fx_usd_kzt", "company")];
    expect(tilesOf("us", all)).toEqual([tile("mrr", "us")]);
    expect(tilesOf("kz", all)).toEqual([tile("mrr", "kz"), tile("fx_usd_kzt", "company")]);
  });

  test("with no company chosen everything is in view", () => {
    const all = [tile("mrr", "us"), tile("mrr", "kz")];
    expect(tilesOf(null, all)).toEqual(all);
    expect(marketsOf(null)).toEqual(["us", "kz"]);
    expect(marketsOf("kz")).toEqual(["kz"]);
  });
});

describe("which company hears about a source", () => {
  test("a source that feeds one company is silent in the other", () => {
    expect(sourceServes("us", "mercury")).toBe(true);
    expect(sourceServes("kz", "mercury")).toBe(false);
    expect(sourceServes("kz", "cfo_workbook")).toBe(true);
    expect(sourceServes("us", "cfo_workbook")).toBe(false);
    // The plan is Startup's US business.
    expect(sourceServes("us", "financial_model")).toBe(true);
    expect(sourceServes("kz", "financial_model")).toBe(false);
  });

  test("manual entry, the work tools and the standup serve both", () => {
    for (const id of ["manual", "gmail", "google_calendar", "linear", "fireflies", "standup"]) {
      expect(sourceServes("us", id)).toBe(true);
      expect(sourceServes("kz", id)).toBe(true);
    }
  });

  test("every source serves at least one company", () => {
    for (const id of SOURCE_IDS) {
      expect(sourceServes("us", id) || sourceServes("kz", id)).toBe(true);
    }
  });

  test("source states are filtered the same way", () => {
    expect(Object.keys(sourcesOf("kz", { mercury: 1, cfo_workbook: 2, linear: 3 }))).toEqual([
      "cfo_workbook",
      "linear",
    ]);
  });
});

describe("obligations, pages and products", () => {
  test("HIPAA and SOC 2 are Startup's, data localisation and ISO 27001 are Globex's, the rest are in both", () => {
    const of = (company: "us" | "kz") =>
      OBLIGATION_CATEGORIES.filter((c) => categoryServes(company, c.id)).map((c) => c.id);
    expect(of("us")).toEqual(["hipaa", "soc2", "corporate_tax", "contracts"]);
    expect(of("kz")).toEqual(["kz_data", "iso27001", "corporate_tax", "contracts"]);
  });

  test("fundraising and go to market are Startup's pages", () => {
    for (const href of ["/fundraising", "/gtm"]) {
      expect(pageServes("us", href)).toBe(true);
      expect(pageServes("kz", href)).toBe(false);
      expect(pageServes(null, href)).toBe(true);
    }
    expect(pageServes("kz", "/finance")).toBe(true);
  });

  test("each company has its own products", () => {
    expect(productsOf("us").map((p) => p.id)).toEqual(["startup_insights", "vertical_startup"]);
    expect(productsOf("kz").map((p) => p.id)).toEqual(["kz_product"]);
    expect(productsOf(null)).toHaveLength(3);
  });

  test("a link to the other company's product opens this company's first", () => {
    expect(productOf("kz_product", "us")?.id).toBe("startup_insights");
    expect(productOf("vertical_startup", "kz")?.id).toBe("kz_product");
    expect(productOf("vertical_startup", "us")?.id).toBe("vertical_startup");
    expect(productOf(null)?.id).toBe("startup_insights");
  });
});

describe("Linear teams", () => {
  test("a team named after a company is that company's; any other is shared", () => {
    expect(companyOfLinearTeam("Second")).toBe("kz");
    expect(companyOfLinearTeam("Second team")).toBe("kz");
    expect(companyOfLinearTeam(" first ")).toBe("us");
    expect(companyOfLinearTeam("Operations")).toBeNull();
    expect(companyOfLinearTeam("")).toBeNull();
  });

  test("a company's view holds its own team and the shared ones", () => {
    expect(linearTeamServes(["kz"], "Second")).toBe(true);
    expect(linearTeamServes(["kz"], "First")).toBe(false);
    expect(linearTeamServes(["kz"], "Operations")).toBe(true);
    expect(linearTeamServes(["us", "kz"], "First")).toBe(true);
  });
});
