import { RECORD_FIGURE_ANCHOR } from "@convex/lib/attention/scorecard";
import { pageOn } from "@convex/lib/featureGates";
import type { Area } from "@convex/lib/roles";

/**
 * The area each page belongs to (convex/lib/roles.ts). The navigation hides a
 * page whose area the viewer lacks, and a link to one is not offered.
 * Presentation only: what a page reads is refused or allowed inside Convex.
 */
export const PAGE_AREAS: Record<string, Area> = {
  // Today, the start page: the company's numbers and health (the scorecard,
  // as the Dashboard was), and with `today` a person's own day. Either opens
  // it (PAGE_ALSO); every block on it is gated by its own area.
  "/": "scorecard",
  // The owner's Claude: its token and what it called. The owner's alone, like
  // Work tools: `personal` can be given to no teammate.
  "/assistant": "personal",
  // Everything the agents and bots wait on the owner for: the owner's alone too.
  "/approvals": "personal",
  // Goals and targets: goals read with the scorecard or the board (changed with
  // review), targets read with the scorecard or settings (changed with settings).
  // The board and settings open it too (PAGE_ALSO), for the part they are sent.
  "/goals": "scorecard",
  "/board": "board",
  // Work the owner's bots hand to each other.
  "/handoffs": "board",
  // Every project's AI agents: watched, launched and steered. On no company.
  "/agents": "agents",
  "/finance": "finance",
  "/product": "product",
  "/engineering": "engineering",
  "/sales": "sales",
  "/fundraising": "fundraising",
  "/partnerships": "partnerships",
  // Business contacts of each company. Never a patient.
  "/contacts": "contacts",
  "/customers": "customers",
  // Globex's Intercom inbox: who is waiting on a person, and how Fin does.
  "/support": "support",
  "/compliance": "compliance",
  "/gtm": "gtm",
  // The LinkedIn content calendar: planned and published posts, and their figures.
  "/linkedin": "gtm",
  // Decisions and meeting notes: the company's memory.
  "/memory": "memory",
  // The sensitive areas: each ticked for a person by name on the team page.
  "/payroll": "payroll",
  "/costs": "costs",
  "/settings/sources": "settings",
  "/settings/telegram": "settings",
  "/settings/team": "team",
  // One place to connect things (src/app/(app)/settings/connections): a teammate's own
  // token (Today's), and for the owner alone the Google connection, the work tools'
  // switches and the agent token, each mounted only for the owner and refused inside
  // Convex to anyone else. /today/connect, /settings/work-tools and /assistant/connection
  // redirect here.
  "/settings/connections": "today",
};

/**
 * Pages a second area opens as well. Today merged the Dashboard (the
 * scorecard's) with a person's own day (`today`'s): whoever could open either
 * page before opens it now, and nobody else. `/today` redirects to `/`.
 * Goals and targets opens to whoever the server sends a part of it: the
 * goals (`goals.list`: the scorecard or the board) or the targets
 * (`targets.list`: the scorecard or settings, which sets them); each part is
 * mounted only for a viewer it is sent to.
 */
export const PAGE_ALSO: Readonly<Record<string, readonly Area[]>> = {
  "/": ["today"],
  "/goals": ["board", "settings"],
};

/** Every area that opens a page: its own, then any it is also opened by. */
export const pageAreas = (page: string): readonly Area[] => [PAGE_AREAS[page]!, ...(PAGE_ALSO[page] ?? [])];

const PAGES = Object.keys(PAGE_AREAS);

/** The page a link leads to, or null where it is no page of the OS. */
function pageOf(href: string): string | null {
  return activeHref(href.split(/[?#]/)[0]!, PAGES);
}

/** The area of the page a link leads to, or null where it is no page of the OS. */
export function areaOfPage(href: string): Area | null {
  const page = pageOf(href);
  return page === null ? null : PAGE_AREAS[page]!;
}

/**
 * Whether a viewer with these areas can open the page a link leads to. A link
 * to Finance's "Record a figure" panel also needs the `settings` area, which
 * the panel (and `snapshots.setManual`) is gated on: a viewer without it is
 * not sent to a form they are not shown.
 */
export function canOpen(areas: readonly Area[], href: string): boolean {
  // A page a switched-off feature takes away is no page at all (convex/lib/featureGates.ts).
  if (!pageOn(href)) return false;
  const page = pageOf(href);
  if (href.endsWith(`#${RECORD_FIGURE_ANCHOR}`) && !areas.includes("settings")) return false;
  return page === null || pageAreas(page).some((area) => areas.includes(area));
}

/**
 * Which navigation item the current page belongs to: the one whose path is
 * the page's own or its nearest ancestor. One item at most: a page nested
 * under another with an item of its own lights its own, not its parent's.
 */
export function activeHref(pathname: string, hrefs: readonly string[]): string | null {
  const matches = hrefs.filter((href) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`),
  );
  return matches.reduce<string | null>(
    (best, href) => (best === null || href.length > best.length ? href : best),
    null,
  );
}
