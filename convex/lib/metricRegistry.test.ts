import { describe, expect, test } from "vitest";
import { SOURCES } from "../connectors/manifest";
import { KZ_DETAIL_FIGURES, KZ_MODULES } from "./kzProductDetail";
import {
  METRICS,
  currencyOf,
  getMetric,
  metricScopes,
  staleAfter,
  type MetricDef,
  type Scope,
} from "./metricRegistry";

describe("metric registry", () => {
  test("keys are unique", () => {
    const keys = METRICS.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("keys are snake_case", () => {
    for (const m of METRICS) expect(m.key).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  test("every metric has at least one scope with a source", () => {
    for (const m of METRICS) expect(Object.keys(m.sources).length).toBeGreaterThan(0);
  });

  test("home-scorecard positions do not collide", () => {
    const positions = METRICS.flatMap((m) => (m.home === undefined ? [] : [m.home]));
    expect(new Set(positions).size).toBe(positions.length);
  });

  test("every money metric has a currency for each of its scopes", () => {
    for (const metric of METRICS.filter((m) => m.unit === "currency")) {
      for (const scope of metricScopes(metric)) {
        expect(currencyOf(metric, scope), `${metric.key} · ${scope}`).toBeDefined();
      }
    }
  });

  test("a per-scope staleness override names a scope the metric has", () => {
    for (const metric of METRICS) {
      for (const scope of Object.keys(metric.staleAfterDaysByScope ?? {})) {
        expect(metricScopes(metric), metric.key).toContain(scope);
      }
    }
  });

  test("every source that owns a scorecard figure is wired up", () => {
    // Otherwise the scorecard can only name the source by its raw id.
    const wired = SOURCES.map((source) => source.id);
    for (const metric of METRICS.filter((m) => m.home !== undefined || m.watch)) {
      for (const scope of metricScopes(metric)) {
        expect(wired, `${metric.key} · ${scope}`).toContain(metric.sources[scope]);
      }
    }
  });

  test("every wired source says how it reads inside a sentence", () => {
    for (const source of SOURCES) {
      expect(source.named.trim(), source.id).not.toBe("");
      // The sentence supplies no article, so the name brings its own or needs none.
      expect(source.named, source.id).toBe(source.named.trim());
    }
    expect(Object.fromEntries(SOURCES.map((s) => [s.id, s.named]))).toEqual({
      manual: "manual entry",
      cfo_workbook: "the CFO workbook",
      client_register: "the client register",
      financial_model: "the financial model",
      mercury: "Mercury",
      posthog: "PostHog",
      posthog_globex: "PostHog",
      vercel: "Vercel",
      vertical_startup: "Vertical Startup",
      visible: "Visible",
      kz_crm: "the Kazakhstan CRM",
      search_console: "Search Console",
      apollo: "Apollo",
      gmail: "Gmail",
      google_calendar: "Google Calendar",
      linear: "Linear",
      fireflies: "Fireflies",
      standup: "the standup",
      github: "GitHub",
      vertical_agents: "Vertical Startup's agents",
      intercom: "Intercom",
      visible_contacts: "Visible",
      apollo_contacts: "Apollo",
      gmail_contacts: "Gmail",
      google_calendar_contacts: "Google Calendar",
      fireflies_contacts: "Fireflies",
      kz_crm_contacts: "the Kazakhstan CRM",
    });
  });

  test("only a source with more history to read offers a backfill", () => {
    // `backfill: false` hides the "Backfill" button and makes runNow refuse
    // one. Apollo reports totals to date, Vertical Startup sends all it keeps, and
    // the four work tools mirror what is current: none has a longer read.
    const offered = SOURCES.filter((s) => s.kind === "api" && s.backfill !== false).map((s) => s.id);
    expect(offered).toEqual(["mercury", "posthog", "posthog_globex", "vercel", "search_console"]);
    for (const id of ["vertical_startup", "apollo", "gmail", "google_calendar", "linear", "fireflies"]) {
      expect(SOURCES.find((s) => s.id === id)?.backfill, id).toBe(false);
    }
  });

  test("a sparse metric is never a tile and never watched", () => {
    // Its absence means "none happened", so it can be neither missing nor stale.
    for (const metric of METRICS.filter((m) => m.sparse)) {
      expect(metric.home, metric.key).toBeUndefined();
      expect(metric.watch, metric.key).toBeUndefined();
    }
  });

  test("each finance figure has the one source that owns it", () => {
    // Whole-object comparisons, so a scope added without a decision fails too.
    const sources = (key: string) => getMetric(key)?.sources;
    expect(sources("mrr")).toEqual({ us: "manual", kz: "cfo_workbook" });
    expect(sources("mrr_contracted")).toEqual({ kz: "cfo_workbook" });
    expect(sources("paying_clinics")).toEqual({ us: "manual", kz: "cfo_workbook" });
    expect(sources("clinics_active")).toEqual({ kz: "cfo_workbook" });
    expect(sources("receivables")).toEqual({ kz: "cfo_workbook" });
    expect(sources("logo_churn_monthly")).toEqual({ kz: "cfo_workbook" });
    expect(sources("fx_usd_kzt")).toEqual({ company: "cfo_workbook" });
    expect(sources("cash")).toEqual({ us: "mercury", kz: "manual" });
    expect(sources("cash_in")).toEqual({ us: "mercury" });
    expect(sources("cash_out")).toEqual({ us: "mercury" });
    expect(sources("cash_to_subsidiary")).toEqual({ us: "mercury" });
    expect(sources("financing_in")).toEqual({ us: "manual", kz: "manual" });
  });

  test("what Startup sends Globex is Startup's, monthly, from Mercury, and no figure of its own on a page", () => {
    expect(getMetric("cash_to_subsidiary")).toMatchObject({
      label: "Sent to Globex",
      section: "finance",
      unit: "currency",
      grain: "month",
      min: 0,
    });
    // A month with no row is not known (data from before it was counted), never a zero.
    expect(getMetric("cash_to_subsidiary")?.sparse).toBeUndefined();
    expect(getMetric("cash_to_subsidiary")?.home).toBeUndefined();
    expect(getMetric("cash_to_subsidiary")?.watch).toBeUndefined();
  });

  test("financing is sparse: a month without a row had none", () => {
    expect(getMetric("financing_in")?.sparse).toBe(true);
  });

  // ── Product health (Phase 3) ──────────────────────────────────────────────
  const source = (key: string, scope: Scope) => getMetric(key)?.sources[scope];
  const WEEKLY_PRODUCT = [
    "weekly_active_users",
    "searches",
    "web_visitors",
    "signups",
    "signups_activated",
    "site_pageviews",
    "deploys",
    "deploys_failed",
    "practices_active",
    "core_actions",
  ];

  test("each product figure has the one source that owns it", () => {
    expect(source("weekly_active_users", "startup_insights")).toBe("posthog");
    expect(source("weekly_active_users", "vertical_startup")).toBe("vertical_startup");
    expect(source("searches", "startup_insights")).toBe("posthog");
    expect(source("web_visitors", "startup_insights")).toBe("posthog");
    expect(source("signups", "startup_insights")).toBe("posthog");
    expect(source("signups_activated", "startup_insights")).toBe("posthog");
    expect(source("site_pageviews", "startup_insights")).toBe("vercel");
    expect(source("deploys", "startup_insights")).toBe("vercel");
    expect(source("deploys_failed", "startup_insights")).toBe("vercel");
    expect(source("practices_active", "vertical_startup")).toBe("vertical_startup");
    expect(source("core_actions", "vertical_startup")).toBe("vertical_startup");
    expect(source("practices", "vertical_startup")).toBe("vertical_startup");
    expect(source("clinics_using", "kz_product")).toBe("cfo_workbook");
  });

  test("product counts are stored per week, whole and never negative", () => {
    for (const key of WEEKLY_PRODUCT) {
      expect(getMetric(key), key).toMatchObject({
        section: "product",
        unit: "count",
        grain: "week",
        integer: true,
        min: 0,
      });
    }
    expect(getMetric("practices")).toMatchObject({ grain: "day", integer: true, min: 0 });
  });

  test("no product metric is sparse: a week with no row is unknown, not zero", () => {
    for (const metric of METRICS.filter((m) => m.section === "product")) {
      expect(metric.sparse, metric.key).toBeUndefined();
    }
  });

  // ── Marketing and go to market ───────────────────────────────────────────
  const marketingAndGtm = () =>
    METRICS.filter((m) => m.section === "marketing" || m.section === "gtm");

  test("each marketing and GTM figure has the one source that owns it", () => {
    const sources = (key: string) => getMetric(key)?.sources;
    expect(sources("search_clicks")).toEqual({ company: "search_console" });
    expect(sources("search_impressions")).toEqual({ company: "search_console" });
    expect(sources("search_position")).toEqual({ company: "search_console" });
    expect(sources("linkedin_followers")).toEqual({ company: "manual" });
    expect(sources("outbound_delivered")).toEqual({ us: "apollo" });
    expect(sources("outbound_opened")).toEqual({ us: "apollo" });
    expect(sources("outbound_replied")).toEqual({ us: "apollo" });
    expect(sources("meetings_booked")).toEqual({ company: "manual" });
  });

  test("Apollo's prospect, task and call figures: Startup's, from Apollo, on the go-to-market page", () => {
    const keys = [
      "apollo_contacts",
      "apollo_accounts",
      "apollo_tasks_open",
      "apollo_tasks_overdue",
      "apollo_contacts_added",
      "apollo_calls",
    ];
    for (const key of keys) {
      const metric = getMetric(key);
      expect(metric, key).toMatchObject({
        section: "gtm",
        unit: "count",
        grain: "week",
        sources: { us: "apollo" },
        min: 0,
        integer: true,
      });
      // A count with a digit too many must not become the figure on the page.
      expect(metric?.max, key).toBeGreaterThan(0);
      expect(metric?.label.trim(), key).not.toBe("");
      // None is a home tile or watched: the dashboard does not show them.
      expect(metric?.home, key).toBeUndefined();
      expect(metric?.watch, key).toBeUndefined();
    }
  });

  test("Apollo's levels are read daily into the week in progress; a week's own count is due once it ends", () => {
    for (const key of ["apollo_contacts", "apollo_accounts", "apollo_tasks_open", "apollo_tasks_overdue"]) {
      expect(getMetric(key)?.staleAfterDays, key).toBe(4);
    }
    for (const key of ["apollo_contacts_added", "apollo_calls"]) {
      expect(getMetric(key)?.staleAfterDays, key).toBe(10);
    }
    // Fewer tasks waiting is the good direction.
    expect(getMetric("apollo_tasks_open")?.better).toBe("down");
    expect(getMetric("apollo_tasks_overdue")?.better).toBe("down");
  });

  test("marketing and GTM figures are weekly, and none is sparse", () => {
    const metrics = marketingAndGtm();
    expect(metrics).toHaveLength(14);
    for (const metric of metrics) {
      expect(metric.grain, metric.key).toBe("week");
      expect(metric.sparse, metric.key).toBeUndefined();
    }
  });

  test("no marketing or GTM figure has a Kazakhstan scope", () => {
    // The two benchmark bands these pages show are US and EU data. With no
    // Kazakhstan scope here, neither can land on a Kazakhstan tile.
    for (const metric of marketingAndGtm()) {
      expect(metricScopes(metric), metric.key).not.toContain("kz");
      expect(metricScopes(metric), metric.key).not.toContain("kz_product");
    }
  });

  test("a marketing or GTM count that a typo could make believable has limits", () => {
    for (const metric of marketingAndGtm().filter((m) => m.unit === "count")) {
      expect(metric.min, metric.key).toBe(0);
      expect(metric.integer, metric.key).toBe(true);
    }
    expect(getMetric("search_position")).toMatchObject({ min: 1, max: 1000, better: "down" });
  });
});

describe("Globex's AI token cost", () => {
  test("a month's cost in US dollars and the clinics it was spent on, from PostHog, Finance's to show", () => {
    expect(getMetric("ai_token_cost")).toMatchObject({
      section: "finance",
      unit: "currency",
      currency: "USD",
      grain: "month",
      better: "down",
      sources: { kz_product: "posthog_globex" },
      min: 0,
    });
    expect(getMetric("ai_token_clinics")).toMatchObject({
      section: "finance",
      unit: "count",
      grain: "month",
      sources: { kz_product: "posthog_globex" },
      min: 0,
      integer: true,
    });
    // Neither is a tile on the home scorecard, nor watched: unit economics reads them.
    for (const key of ["ai_token_cost", "ai_token_clinics"]) {
      expect(getMetric(key)?.home, key).toBeUndefined();
      expect(getMetric(key)?.watch, key).toBeUndefined();
    }
  });

  test("money is in its metric's currency where one is set, else its scope's", () => {
    expect(currencyOf(getMetric("ai_token_cost")!, "kz_product")).toBe("USD");
    expect(currencyOf(getMetric("mrr")!, "kz")).toBe("KZT");
    expect(currencyOf(getMetric("mrr")!, "us")).toBe("USD");
    expect(currencyOf(getMetric("paying_clinics")!, "kz")).toBeUndefined();
  });
});

describe("Globex's weekly AI spend", () => {
  test("is Finance's figure, not Product's: the app's total, and each module's cost and cost a result", () => {
    const money = KZ_DETAIL_FIGURES.filter(
      (f) => f.key === "ai_cost_total" || f.key.startsWith("module_ai_cost_") || f.key.startsWith("module_cost_per_result_"),
    );
    expect(money.length).toBe(1 + 2 * KZ_MODULES.length);
    // Paying clinics that ran a check are paying clients, as `clinics_active` is: Finance's too.
    money.push(KZ_DETAIL_FIGURES.find((f) => f.key === "clinics_paid")!);
    for (const f of money) expect(getMetric(f.key)?.section, f.key).toBe("finance");
    for (const f of KZ_DETAIL_FIGURES) {
      if (money.includes(f)) continue;
      expect(getMetric(f.key)?.section, f.key).toBe("product");
    }
  });
});

describe("staleAfter", () => {
  const metric = {
    staleAfterDays: 35,
    staleAfterDaysByScope: { us: 3 },
  } as MetricDef;

  test("uses the scope's own limit when it has one", () => {
    expect(staleAfter(metric, "us")).toBe(3);
  });

  test("falls back to the metric's limit", () => {
    expect(staleAfter(metric, "kz")).toBe(35);
  });

  test("a synced daily balance goes stale in days, a typed monthly one in weeks", () => {
    const cash = getMetric("cash")!;
    expect(staleAfter(cash, "us")).toBe(3);
    expect(staleAfter(cash, "kz")).toBe(35);
  });
});
