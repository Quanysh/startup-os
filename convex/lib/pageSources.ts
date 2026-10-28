// Which sources each page draws on, for the "Updated …" line in its header.
// One map, read by `freshness.forPage` (which also gates each source as the
// page's own data is gated) and by the browser through src/lib/page-sources.ts.
//
// A page's figures are not listed here twice: a page names which of the
// registry's figures it shows (`shows`), and the sources are the ones the
// registry says feed those figures in the company in view. Only what carries
// no figure (a pipeline, the client register, the plan, Linear) is named.

import { MIRROR_SOURCES } from "./mirrorRules";
import { companyOfMetric, type CompanyId } from "./company";
import { METRICS, SOURCE_IDS, metricScopes, type MetricDef, type SourceId } from "./metricRegistry";
import type { Area } from "./roles";

export const FRESHNESS_PAGES = [
  "finance",
  "product",
  "engineering",
  "gtm",
  "sales",
  "fundraising",
  "customers",
  "today",
  "board_linear",
  "agents",
  "support",
] as const;
export type FreshnessPage = (typeof FRESHNESS_PAGES)[number];

export function isFreshnessPage(value: string): value is FreshnessPage {
  return (FRESHNESS_PAGES as readonly string[]).includes(value);
}

/** The figures on Go to market that are Product's: PostHog's visitors and signups. */
const GTM_WEB_FIGURES = ["web_visitors", "signups"];

export type PageSpec = {
  /**
   * The page's own area: a caller without it is told nothing about the page.
   * None for Today, which has no area of its own: each part it sums up is
   * gated by that part's area, and the viewer's own tools by `today`.
   */
  area?: Area;
  /** Which of the registry's figures the page shows. */
  shows?: (metric: MetricDef) => boolean;
  /** Sources the page reads that carry no figure, and the companies they serve on it. */
  lists?: readonly { source: SourceId; companies: readonly CompanyId[] }[];
  /** The viewer's own four work tools (Today's "Your day"), for a viewer with `today`. */
  own?: true;
  /** The pages it sums up (Today's company blocks): each still gated by its own area. */
  of?: readonly FreshnessPage[];
};

const BOTH: readonly CompanyId[] = ["us", "kz"];

export const PAGE_SOURCES: Record<FreshnessPage, PageSpec> = {
  // Mercury, the CFO workbook, the figures typed in, and the plan (Startup's).
  finance: {
    area: "finance",
    shows: (m) => m.section === "finance",
    lists: [{ source: "financial_model", companies: ["us"] }],
  },
  // PostHog, Vercel, Vertical Startup; Globex's PostHog and the workbook. GitHub's
  // figures are Product's in the registry but the Engineering page's to show.
  product: { area: "product", shows: (m) => m.section === "product" && m.alsoFor === undefined },
  engineering: { area: "engineering", shows: (m) => m.alsoFor?.includes("engineering") === true },
  // Apollo, Search Console, PostHog's web figures, and the counts typed in.
  gtm: {
    area: "gtm",
    shows: (m) =>
      m.section === "gtm" || m.section === "marketing" || GTM_WEB_FIGURES.includes(m.key),
  },
  // Startup's deals are typed in here (their last change is the page's own);
  // Globex's are mirrored from its CRM.
  sales: { area: "sales", lists: [{ source: "kz_crm", companies: ["kz"] }] },
  fundraising: { area: "fundraising", lists: [{ source: "visible", companies: ["us"] }] },
  // The register is Globex's source (`SOURCE_COMPANY`), like its run state.
  customers: { area: "customers", lists: [{ source: "client_register", companies: ["kz"] }] },
  // Today, the start page (the Dashboard and Today merged, 2026-10): the
  // sources behind the company blocks the viewer can see, and their own four
  // work tools. No area of its own: each part is gated as its block is.
  today: {
    // Support has no block, but its waits are rows of "Needs you".
    of: ["finance", "customers", "sales", "fundraising", "product", "engineering", "gtm", "support"],
    own: true,
  },
  // The shared Linear board, as `workTools.issues` reads it.
  board_linear: { area: "board", lists: [{ source: "linear", companies: BOTH }] },
  // Vertical Startup's agents: a product's, the same whichever company is in view.
  agents: { area: "agents", lists: [{ source: "vertical_agents", companies: BOTH }] },
  // Globex's Intercom inbox.
  support: { area: "support", lists: [{ source: "intercom", companies: ["kz"] }] },
};

/** The figures of a page that belong to a company: each (metric, scope) and its source. */
export function figuresOf(
  page: FreshnessPage,
  company: CompanyId,
): { metric: MetricDef; scope: string; source: SourceId }[] {
  const { shows } = PAGE_SOURCES[page];
  if (shows === undefined) return [];
  return METRICS.filter(shows).flatMap((metric) =>
    metricScopes(metric)
      .filter((scope) => companyOfMetric(metric.key, scope) === company)
      .map((scope) => ({ metric, scope, source: metric.sources[scope]! })),
  );
}

/**
 * Every source a page draws on in a company's view, in the registry's order,
 * before anything is asked of who is looking. `freshness.forPage` then leaves
 * out each one the caller may not see the page's data of.
 */
export function pageSources(page: FreshnessPage, company: CompanyId): SourceId[] {
  const spec = PAGE_SOURCES[page];
  const found = new Set<SourceId>();
  for (const sub of spec.of ?? []) for (const id of pageSources(sub, company)) found.add(id);
  for (const { source } of figuresOf(page, company)) found.add(source);
  for (const list of spec.lists ?? []) if (list.companies.includes(company)) found.add(list.source);
  if (spec.own) for (const id of MIRROR_SOURCES) found.add(id);
  return SOURCE_IDS.filter((id) => found.has(id));
}
