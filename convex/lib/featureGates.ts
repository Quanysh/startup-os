// What each switch of convex/lib/features.ts takes away, and the questions
// the code asks of them. Gates sit at the boundary: a page's layout, the
// navigation, the areas a person holds, the MCP tool registry, the sources
// (ingest, a connector's run, Settings › Sources, freshness), the products
// /product shows, and the agents' docs. Pure, so the browser imports it too.
//
// Every question reads `FEATURES` when it is asked, never when this module
// loads, so a test can turn one switch off for one case.

import { ConvexError } from "convex/values";
import { FEATURES, type FeatureId } from "./features";
import type { Area } from "./roles";

/**
 * The switches that are part of another: off whenever it is, whatever they
 * say. The second company's own features go with the second company.
 */
const PART_OF: Partial<Record<FeatureId, FeatureId>> = {
  subsidiaryFunding: "secondCompany",
  kzProduct: "secondCompany",
  supportInbox: "secondCompany",
};

/** Whether a switch is on (and the one it is part of, if any). The one way the code asks. */
export const featureOn = (feature: FeatureId): boolean => {
  const whole = PART_OF[feature];
  return FEATURES[feature] === true && (whole === undefined || featureOn(whole));
};

/** Said by a function that belongs to a switched-off feature. Fixed words. */
export const FEATURE_OFF = "That is not part of this OS.";

/** For a Convex function of a feature: refused, in fixed words, while its switch is off. */
export function requireFeature(feature: FeatureId): void {
  if (!featureOn(feature)) throw new ConvexError(FEATURE_OFF);
}

/** The pages each switch takes away: the page and everything under it. */
const FEATURE_PAGES: Partial<Record<FeatureId, readonly string[]>> = {
  supportInbox: ["/support"],
  kzProduct: ["/product/kz"],
};

/** The areas each switch takes away: nobody holds one, the owner included. */
const FEATURE_AREAS: Partial<Record<FeatureId, readonly Area[]>> = {
  supportInbox: ["support"],
};

/**
 * The sources each switch takes away: their token is not accepted, a run of
 * theirs does nothing, and Settings › Sources and the pages' freshness leave
 * them out.
 */
const FEATURE_SOURCES: Partial<Record<FeatureId, readonly string[]>> = {
  // The second company's own feeds (`SOURCE_COMPANY` in convex/lib/company.ts
  // gives each to "kz"); its Intercom and PostHog go with their own switches.
  secondCompany: ["cfo_workbook", "client_register", "kz_crm", "kz_crm_contacts"],
  supportInbox: ["intercom"],
  kzProduct: ["posthog_globex"],
  verticalStartupAgents: ["vertical_agents"],
  startupInsights: ["posthog", "vercel"],
  verticalStartupProduct: ["vertical_startup"],
};

/** The MCP tools each switch takes away: not listed, and refused as unknown. */
const FEATURE_TOOLS: Partial<Record<FeatureId, readonly string[]>> = {
  supportInbox: ["support"],
};

/** The /product tabs (each a product's scope) each switch takes away. */
const FEATURE_PRODUCTS: Partial<Record<FeatureId, readonly string[]>> = {
  kzProduct: ["kz_product"],
  startupInsights: ["startup_insights"],
  verticalStartupProduct: ["vertical_startup"],
};

const FEATURE_IDS = Object.keys(FEATURES) as FeatureId[];

/** False when a switched-off feature lists this thing as its own. */
const keptBy = (table: Partial<Record<FeatureId, readonly string[]>>, item: string) =>
  FEATURE_IDS.every((feature) => featureOn(feature) || !(table[feature] ?? []).includes(item));

/** Whether a page is part of this OS: the path itself or one under it. */
export function pageOn(pathname: string): boolean {
  const path = pathname.split(/[?#]/)[0]!;
  return FEATURE_IDS.every(
    (feature) =>
      featureOn(feature) ||
      !(FEATURE_PAGES[feature] ?? []).some((page) => path === page || path.startsWith(`${page}/`)),
  );
}

export const areaOn = (area: Area): boolean => keptBy(FEATURE_AREAS, area);
export const sourceOn = (source: string): boolean => keptBy(FEATURE_SOURCES, source);
export const toolOn = (tool: string): boolean => keptBy(FEATURE_TOOLS, tool);
export const productOn = (product: string): boolean => keptBy(FEATURE_PRODUCTS, product);

// ── The agents' docs ────────────────────────────────────────────────────────
//
// Text a model is given (docs/agents/*.md, a tool's description) marks what
// belongs to one switch:
//
//   <!-- feature:subsidiaryFunding -->
//   - a whole line or more, the markers on lines of their own
//   <!-- /feature -->
//
// or inline, inside a line: `… <!-- feature:startupInsights -->some words<!-- /feature --> …`.
// With the switch on only the markers go, so the text is what it was before
// they were written; off, the text between them goes too. A marked part may
// hold another switch's (a part of the second company's words that also
// names Vertical Startup, say): the inner is taken first, then the outer.

// A body never holds an opening marker: the innermost is matched first.
const BLOCK = /^<!-- feature:(\w+) -->\n((?:(?!<!-- feature:)[\s\S])*?)^<!-- \/feature -->\n/gm;
const INLINE = /<!-- feature:(\w+) -->((?:(?!<!-- feature:)[\s\S])*?)<!-- \/feature -->/g;

const keep = (feature: string) => !(FEATURE_IDS as string[]).includes(feature) || featureOn(feature as FeatureId);

/** The text as this OS gives it: what a switched-off feature's markers hold taken out, every marker dropped. */
export function withFeatures(text: string): string {
  let out = text;
  for (;;) {
    const next = out
      .replace(BLOCK, (_, feature: string, body: string) => (keep(feature) ? body : ""))
      .replace(INLINE, (_, feature: string, body: string) => (keep(feature) ? body : ""));
    if (next === out) return out;
    out = next;
  }
}
