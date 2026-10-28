import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { FeatureId } from "./features";

// Every switch, on, as main has them. A case turns one off and `afterEach`
// puts it back: the gates read the switches when asked, never at load.
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
vi.mock("./features", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./features")>()),
  // The made-up deployment's ids, as every test has them (convex/test.deployment.ts).
  ...(await import("./deployment.kit")).MADE_UP_DEPLOYMENT,
  FEATURES: switches,
}));

// The ids as the tests have them (the made-up deployment), and the real module.
const { FEATURES: _mocked, ...ids } = await import("./features");
const real = await vi.importActual<typeof import("./features")>("./features");
const gates = await import("./featureGates");
const { ownerAreas, effectiveAreas, AREAS } = await import("./roles");
const { TOOLS, toolsFor, toolFor, toolNamed, describeTool, toolsOn } = await import("./mcpTools");
const { osAgentInstructions, osAgentUserTemplate } = await import("./osAgentDefaults");
const {
  COMPANIES,
  COMPANY_NOT_IN_USE,
  categoryServes,
  companyIds,
  isCompanyId,
  isSubsidiaryCounterparty,
  manyCompanies,
  marketsOf,
  pageServes,
  sourceServes,
  tilesOf,
} = await import("./company");
const { COMPANY_IDENTITY } = await import("./identity");
const { SCOPE_CURRENCY } = await import("./metricRegistry");
const { AGENT_IDS } = await import("./agents");
const { companyArgRefusal } = await import("./mcpTools");
const { withSubsidiaryFunding, financeSummary } = await import("./finance");
const { startupActuals } = await import("./budget");
const { toSnapshots } = await import("../connectors/mercuryParse");
const { CURRENCY_NOT_OFFERED, MARKET_CURRENCY, offeredCurrencies, requireOfferedCurrency, startingCurrencyOf } =
  await import("./customerShape");

const off = (feature: FeatureId) => {
  switches[feature] = false;
};
afterEach(() => {
  for (const feature of Object.keys(switches) as FeatureId[]) switches[feature] = true;
});

// This deployment's own switches and ids are pinned in convex/lib/deployment.test.ts.
describe("every switch on", () => {
  test("with every switch on, every gate lets everything through", () => {
    expect(ownerAreas()).toBe(AREAS);
    for (const page of ["/support", "/product/kz/clinics/x", "/finance"]) expect(gates.pageOn(page)).toBe(true);
    for (const source of ["intercom", "posthog_globex", "vertical_agents", "posthog", "vercel"]) {
      expect(gates.sourceOn(source)).toBe(true);
    }
    expect(toolsOn().length).toBe(TOOLS.length);
    expect(toolNamed("support")?.name).toBe("support");
    expect(offeredCurrencies()).toEqual(["USD", "KZT"]);
  });
});

describe("withFeatures", () => {
  const block = "a\n<!-- feature:supportInbox -->\nb\nc\n<!-- /feature -->\nd\n";
  const inline = "one <!-- feature:startupInsights -->two <!-- /feature -->three";

  test("on, only the markers go: the text is what it was", () => {
    expect(gates.withFeatures(block)).toBe("a\nb\nc\nd\n");
    expect(gates.withFeatures(inline)).toBe("one two three");
  });

  test("off, what the markers hold goes too", () => {
    off("supportInbox");
    off("startupInsights");
    expect(gates.withFeatures(block)).toBe("a\nd\n");
    expect(gates.withFeatures(inline)).toBe("one three");
  });

  test("a marked part may hold another switch's: the inner goes with its switch, the outer with its own", () => {
    const nested = "a<!-- feature:secondCompany --> b (<!-- feature:verticalStartupAgents -->c, <!-- /feature -->d)<!-- /feature -->.";
    expect(gates.withFeatures(nested)).toBe("a b (c, d).");
    off("verticalStartupAgents");
    expect(gates.withFeatures(nested)).toBe("a b (d).");
    off("secondCompany");
    expect(gates.withFeatures(nested)).toBe("a.");
    const block = "x\n<!-- feature:secondCompany -->\ny <!-- feature:startupInsights -->z<!-- /feature -->\n<!-- /feature -->\nw\n";
    expect(gates.withFeatures(block)).toBe("x\nw\n");
  });

  test("every marker in the agents' docs and the tools' descriptions names a switch, and closes", () => {
    const dir = new URL("../../docs/agents/", import.meta.url);
    const texts = [
      ...readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => readFileSync(new URL(f, dir), "utf8")),
      ...toolsOn().map((tool) => tool.description),
    ];
    const known = Object.keys(real.FEATURES);
    for (const text of texts) {
      const opened = [...text.matchAll(/<!-- feature:(\w+) -->/g)].map((m) => m[1]);
      for (const feature of opened) expect(known).toContain(feature);
      expect(opened.length).toBe([...text.matchAll(/<!-- \/feature -->/g)].length);
      expect(gates.withFeatures(text)).not.toContain("<!--");
    }
  });
});

describe("each switch off: its gate holds", () => {
  test("supportInbox: /support is no page, nobody holds the area, the tool does not exist", () => {
    off("supportInbox");
    expect(gates.pageOn("/support")).toBe(false);
    expect(gates.pageOn("/finance")).toBe(true);
    expect(ownerAreas()).not.toContain("support");
    expect(effectiveAreas("cofounder", ["support", "finance"])).toEqual(["finance"]);
    expect(gates.sourceOn("intercom")).toBe(false);
    expect(toolNamed("support")).toBeUndefined();
    expect(toolFor("support", false)).toBeUndefined();
    expect(toolsFor("act").map((tool) => tool.name)).not.toContain("support");
    expect(osAgentInstructions("chief_of_staff")).not.toContain("mcp__startup-os__support");
  });

  test("kzProduct: /product/kz and Globex's PostHog read are gone", () => {
    off("kzProduct");
    expect(gates.pageOn("/product/kz/clinics/org_1")).toBe(false);
    expect(gates.pageOn("/product")).toBe(true);
    expect(gates.productOn("kz_product")).toBe(false);
    expect(gates.sourceOn("posthog_globex")).toBe(false);
    expect(() => gates.requireFeature("kzProduct")).toThrow(gates.FEATURE_OFF);
  });

  test("verticalStartupAgents: its push is refused and the docs no longer name it", () => {
    off("verticalStartupAgents");
    expect(gates.sourceOn("vertical_agents")).toBe(false);
    expect(describeTool(toolNamed("agents")!).description).not.toContain("Vertical");
    expect(osAgentInstructions("engineering")).not.toContain("Vertical Startup");
    expect(() => gates.requireFeature("verticalStartupAgents")).toThrow(gates.FEATURE_OFF);
  });

  test("verticalStartupProduct: its /product tab and its health read are gone", () => {
    off("verticalStartupProduct");
    expect(gates.productOn("vertical_startup")).toBe(false);
    expect(gates.sourceOn("vertical_startup")).toBe(false);
    expect(gates.productOn("startup_insights")).toBe(true);
    expect(gates.sourceOn("vertical_agents")).toBe(true);
    expect(gates.sourceOn("mercury")).toBe(true);
  });

  test("startupInsights: its tab and its two sources are gone", () => {
    off("startupInsights");
    expect(gates.productOn("startup_insights")).toBe(false);
    expect(gates.productOn("vertical_startup")).toBe(true);
    expect(gates.sourceOn("posthog")).toBe(false);
    expect(gates.sourceOn("vercel")).toBe(false);
    expect(gates.sourceOn("mercury")).toBe(true);
  });

  test("subsidiaryFunding: no payment is the subsidiary's, and burn is each bank's own", () => {
    expect(isSubsidiaryCounterparty("TOO NORTHWIND")).toBe(true);
    off("subsidiaryFunding");
    expect(isSubsidiaryCounterparty("TOO NORTHWIND")).toBe(false);

    // Mercury writes no `cash_to_subsidiary`.
    const rows = toSnapshots({
      now: Date.UTC(2026, 9, 14),
      cashCents: 100_00,
      flows: [{ periodStart: "2026-09-01", inCents: 0, outCents: 500_00, toSubsidiaryCents: 200_00 }],
    });
    expect(rows.map((row) => row.key)).not.toContain("cash_to_subsidiary");

    // Globex's burn is its balances' own: nothing to wait for, nothing taken out.
    const burn = [{ periodStart: "2026-09-01", value: 1_000_000 }];
    expect(withSubsidiaryFunding(burn, null, null, null)).toEqual({ burn, gaps: [] });
    expect(financeSummary([], [], "2026-10-14", null, ["kz"]).funding).toBeNull();
    expect(financeSummary([], [], "2026-10-14", null, ["us"]).funding).toBeNull();

    // Startup's actual is Mercury's money out whole: no figure of what was sent is needed.
    const readAt = Date.UTC(2026, 9, 2);
    expect(startupActuals([{ periodStart: "2026-09-01", value: 500 }], [], "2026-10", readAt)).toEqual(
      new Map([["2026-09", 500_00]]),
    );

    // The finance agent is told nothing of a subsidiary.
    expect(osAgentInstructions("finance")).not.toMatch(/subsidiary/i);
    expect(describeTool(toolNamed("budget")!).description).not.toContain("cash_to_subsidiary");
  });

  test("kztCurrency: only dollars are offered, and a write in tenge is refused", () => {
    expect(startingCurrencyOf("kz")).toBe("KZT");
    off("kztCurrency");
    expect(offeredCurrencies()).toEqual(["USD"]);
    expect(startingCurrencyOf("kz")).toBe("USD");
    expect(() => requireOfferedCurrency("KZT")).toThrow(CURRENCY_NOT_OFFERED);
    expect(() => requireOfferedCurrency("USD")).not.toThrow();
    expect(() => requireOfferedCurrency(undefined)).not.toThrow();
  });
});

/** Words of the second company, as main names it: none may reach an agent in one-company mode. */
const SECOND_COMPANY_WORDS = /\bkz\b|Globex|Kazakhstan|Globex|\bKZT\b|tenge|tiyn|₸|fx_usd_kzt|both compan|either company/i;
/** The GPU's label is this deployment's outside id (features.ts), which a fork sets: not the second company. */
const withoutGpu = (text: string) => text.replaceAll(ids.GPU.label, "the GPU");

describe("each company's currency is its identity's", () => {
  test("Startup in dollars, Globex in tenge, wherever the code asks", () => {
    expect(COMPANY_IDENTITY.us.currency).toBe("USD");
    expect(COMPANY_IDENTITY.kz.currency).toBe("KZT");
    for (const id of ["us", "kz"] as const) {
      expect(COMPANIES[id].currency).toBe(COMPANY_IDENTITY[id].currency);
      expect(MARKET_CURRENCY[id]).toBe(COMPANY_IDENTITY[id].currency);
      expect(SCOPE_CURRENCY[id]).toBe(COMPANY_IDENTITY[id].currency);
    }
  });
});

describe("one company: the second switched off", () => {
  test("main has both companies", () => {
    expect(companyIds()).toEqual(["us", "kz"]);
    expect(manyCompanies()).toBe(true);
    expect(isCompanyId("kz")).toBe(true);
  });

  test("the OS is run for the first alone", () => {
    off("secondCompany");
    expect(companyIds()).toEqual(["us"]);
    expect(manyCompanies()).toBe(false);
    expect(isCompanyId("us")).toBe(true);
    expect(isCompanyId("kz")).toBe(false);
    expect(marketsOf(null)).toEqual(["us"]);
  });

  test("the second company's own switches go with it, and with them its pages, area, sources, tool and tab", () => {
    off("secondCompany");
    for (const feature of ["subsidiaryFunding", "kzProduct", "supportInbox"] as const) {
      expect(gates.featureOn(feature)).toBe(false);
    }
    for (const feature of ["verticalStartupAgents", "startupInsights", "verticalStartupProduct", "kztCurrency"] as const) {
      expect(gates.featureOn(feature)).toBe(true);
    }
    expect(gates.pageOn("/support")).toBe(false);
    expect(gates.pageOn("/product/kz")).toBe(false);
    expect(gates.pageOn("/finance")).toBe(true);
    expect(ownerAreas()).not.toContain("support");
    expect(toolNamed("support")).toBeUndefined();
    expect(gates.productOn("kz_product")).toBe(false);
    for (const source of ["cfo_workbook", "client_register", "kz_crm", "intercom", "posthog_globex"]) {
      expect(gates.sourceOn(source)).toBe(false);
    }
    expect(gates.sourceOn("mercury")).toBe(true);
    expect(isSubsidiaryCounterparty("TOO NORTHWIND")).toBe(false);
  });

  test("with no company chosen, nothing of the second is in view", () => {
    off("secondCompany");
    expect(pageServes(null, "/support")).toBe(false);
    expect(pageServes(null, "/fundraising")).toBe(true);
    expect(sourceServes(null, "kz_crm")).toBe(false);
    expect(sourceServes(null, "mercury")).toBe(true);
    expect(categoryServes(null, "iso27001")).toBe(false);
    expect(categoryServes(null, "hipaa")).toBe(true);
    const tiles = [
      { key: "cash", scope: "us" },
      { key: "cash", scope: "kz" },
      { key: "fx_usd_kzt", scope: "company" },
    ];
    expect(tilesOf(null, tiles)).toEqual([{ key: "cash", scope: "us" }]);
  });

  test("only the companies' own currencies are offered: no tenge", () => {
    expect(offeredCurrencies()).toEqual(["USD", "KZT"]);
    off("secondCompany");
    expect(offeredCurrencies()).toEqual(["USD"]);
    expect(startingCurrencyOf("us")).toBe("USD");
    expect(() => requireOfferedCurrency("KZT")).toThrow(CURRENCY_NOT_OFFERED);
  });

  test("the agents' tools name no second company, offer none, and refuse one", () => {
    expect(describeTool(toolNamed("tasks")!).inputSchema).toMatchObject({
      properties: { company: { enum: ["us", "kz"] } },
    });
    expect(companyArgRefusal({ company: "kz" })).toBeNull();
    off("secondCompany");
    for (const tool of toolsOn()) {
      const listed = withoutGpu(JSON.stringify(describeTool(tool)));
      expect(listed, tool.name).not.toMatch(SECOND_COMPANY_WORDS);
    }
    expect(describeTool(toolNamed("tasks")!).inputSchema).toMatchObject({
      properties: { company: { enum: ["us"] } },
    });
    expect(companyArgRefusal({ company: "kz" })).toBe(COMPANY_NOT_IN_USE);
    expect(companyArgRefusal({ market: "kz" })).toBe(COMPANY_NOT_IN_USE);
    expect(companyArgRefusal({ company: "us" })).toBeNull();
    expect(companyArgRefusal({})).toBeNull();
  });

  test("the agents' docs say nothing of a second company", () => {
    off("secondCompany");
    for (const agent of AGENT_IDS) expect(osAgentInstructions(agent), agent).not.toMatch(SECOND_COMPANY_WORDS);
    expect(osAgentUserTemplate()).toBe("Do this run now, as your instructions say. Finish with the final answer they describe.");
    const chat = readFileSync(new URL("../../docs/agents/chat.md", import.meta.url), "utf8");
    expect(gates.withFeatures(chat)).not.toMatch(SECOND_COMPANY_WORDS);
  });
});
