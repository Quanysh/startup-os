import { describe, expect, test } from "vitest";
import { sourceServes } from "@convex/lib/company";
import { SOURCES } from "@convex/connectors/manifest";
import { FRESHNESS_PAGES, PAGE_SOURCES, pageSources } from "./page-sources";

describe("the sources each page draws on", () => {
  test.each([
    ["finance", "us", ["manual", "mercury", "financial_model"]],
    // PostHog: Globex's app's AI token cost (unit economics' COGS).
    ["finance", "kz", ["manual", "cfo_workbook", "posthog_globex"]],
    ["product", "us", ["posthog", "vercel", "vertical_startup"]],
    ["product", "kz", ["cfo_workbook", "posthog_globex"]],
    ["engineering", "us", ["github"]],
    ["engineering", "kz", ["github"]],
    ["gtm", "us", ["manual", "posthog", "apollo", "search_console"]],
    ["gtm", "kz", []],
    // Startup's deals are typed in on the page itself: no source.
    ["sales", "us", []],
    ["sales", "kz", ["kz_crm"]],
    ["fundraising", "us", ["visible"]],
    ["fundraising", "kz", []],
    ["customers", "us", []],
    ["customers", "kz", ["client_register"]],
    // Globex's Intercom inbox.
    ["support", "us", []],
    ["support", "kz", ["intercom"]],
    ["board_linear", "us", ["linear"]],
    ["board_linear", "kz", ["linear"]],
    // Today: the company blocks' sources, and the viewer's own four work tools.
    [
      "today",
      "us",
      [
        "manual",
        "mercury",
        "financial_model",
        "posthog",
        "vercel",
        "vertical_startup",
        "apollo",
        "search_console",
        "visible",
        "gmail",
        "google_calendar",
        "linear",
        "fireflies",
        "github",
      ],
    ],
    [
      "today",
      "kz",
      // Intercom: Support's waits are rows of "Needs you".
      ["manual", "cfo_workbook", "client_register", "posthog_globex", "kz_crm", "gmail", "google_calendar", "linear", "fireflies", "github", "intercom"],
    ],
  ] as const)("%s in %s's view", (page, company, expected) => {
    expect(pageSources(page, company)).toEqual(expected);
  });

  test("a company's view never draws on a source that serves only the other", () => {
    for (const page of FRESHNESS_PAGES) {
      for (const company of ["us", "kz"] as const) {
        for (const id of pageSources(page, company)) {
          expect([page, company, id, sourceServes(company, id)]).toEqual([page, company, id, true]);
        }
      }
    }
  });

  test("every source named is in the manifest, so it has a label and a cadence", () => {
    const known = new Set(SOURCES.map((s) => s.id));
    for (const page of FRESHNESS_PAGES) {
      for (const company of ["us", "kz"] as const) {
        for (const id of pageSources(page, company)) expect(known.has(id)).toBe(true);
      }
    }
  });

  test("Today has no area of its own: every page it sums up is gated by that page's", () => {
    expect(PAGE_SOURCES.today.area).toBeUndefined();
    for (const sub of PAGE_SOURCES.today.of ?? []) expect(PAGE_SOURCES[sub].area).toBeDefined();
  });
});
