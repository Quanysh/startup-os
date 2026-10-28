import { useId } from "react";
import {
  GRANTABLE_AREAS,
  PAY_AND_COSTS,
  PAY_AND_COSTS_ARE_THE_OWNERS,
  SENSITIVE_AREAS,
  areasOf,
  isGrantableArea,
  isSensitiveArea,
  type Area,
  type GrantableArea,
  type MemberRole,
  type SensitiveArea,
} from "@convex/lib/roles";
import { areaOn } from "@convex/lib/featureGates";
import { COMPANIES, pageServes, type CompanyId } from "@/lib/company";
import { PAGE_AREAS } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { companyNames } from "./company-checks";

/**
 * What each area is called on screen. A Record over Area, so an area added to
 * the server's table does not compile until it is named here.
 */
export const AREA_PAGES: Record<Area, string> = {
  scorecard: "Today: the company's numbers and health",
  finance: "Finance",
  product: "Product",
  engineering: "Engineering: pull requests, who owns them and what is stuck",
  sales: "Sales",
  customers: "Customers",
  compliance: "Compliance",
  fundraising: "Fundraising",
  partnerships: "Partnerships",
  contacts: "Contacts",
  outcomes: "Outcomes: what came of the bots' plays, on deals, customers and partners",
  marketing: "Marketing",
  gtm: "Go to market",
  board: "Board",
  review: "Editing goals",
  memory: "Memory: decisions and meeting notes",
  support: `Support: ${COMPANIES.kz.name}'s Intercom inbox, its waits and Fin's outcomes`,
  agents: "Agents: every project's AI agents, their models, cost and quality, connecting projects and launching agents",
  today: "Your day on Today: your own mail, calendar and meetings",
  payroll: "Payroll",
  costs: "Costs: what the company pays for besides pay",
  settings: "Sources and Telegram",
  team: "Team",
  personal: "Work tools: the owner's own mail, calendar and meeting settings",
  admin: "What only the owner can do",
};

/**
 * The ordinary areas the owner can give, each once, in the order the
 * navigation lists their pages. The two sensitive ones are apart, below;
 * payroll and costs are the owner's alone and have no box at all.
 */
export const PAGE_ORDER: readonly GrantableArea[] = [
  ...new Set(
    Object.values(PAGE_AREAS)
      .filter(isGrantableArea)
      .filter((area) => !isSensitiveArea(area))
      // `review` has no page of its own since /review became a redirect: it is
      // editing goals on Goals and targets, ticked after the board as before.
      .flatMap((area) =>
        area === "scorecard"
          ? // Today opens with either: a person's own day is ticked beside the company's numbers.
            [area, "today" as const]
          : area === "board"
            ? [area, "review" as const]
            : // `outcomes` has no page of its own: it shows on the deal, customer and partner views.
              area === "partnerships"
              ? [area, "outcomes" as const]
              : [area],
      ),
  ),
];

/**
 * What each sensitive area lets its holder do, said beside its box. A Record
 * over the server's list, so a third does not compile until it is described.
 */
const SENSITIVE_DESCRIPTIONS: Record<SensitiveArea, string> = {
  settings:
    "can change numbers on the dashboard, run sources and change where the bot posts; never sees tokens",
  team: "can add and remove people and choose their ordinary pages, within their own companies; cannot give the sensitive pages or change another manager",
};

/** The sensitive pages, in the server's order: ticked one by one, never by a role. */
export const SENSITIVE_PAGES: readonly { area: SensitiveArea; name: string; description: string }[] =
  SENSITIVE_AREAS.map((area) => ({
    area,
    name: AREA_PAGES[area],
    description: SENSITIVE_DESCRIPTIONS[area],
  }));

/** Said over the sensitive boxes. */
export const SENSITIVE_HINT =
  "Not part of any role: each is ticked for one person, and unticked again when you choose a role.";

/** Said over the sensitive boxes to someone who manages the team and is not the owner. */
export const SENSITIVE_OWNERS = "Only the owner changes these.";

/** Said under the sensitive boxes: why Payroll and Costs have none. The server's own words. */
export const PAY_AND_COSTS_NOTE = PAY_AND_COSTS_ARE_THE_OWNERS;

/**
 * The names of payroll and costs among some areas, for the record of a change
 * made before they were the owner's alone. Never a box: nobody is given them.
 */
export function payAndCostsNames(areas: readonly Area[]): string[] {
  return PAY_AND_COSTS.filter((area) => areas.includes(area)).map((area) => AREA_PAGES[area]);
}

/** The pages a role starts with: what choosing it ticks. Never a sensitive one. */
export function presetOf(role: MemberRole): GrantableArea[] {
  return areasOf(role).filter(isGrantableArea);
}

/** Said under the role control, in the add form and the row editor alike. */
export const ROLE_HINT =
  "Choosing a role ticks its usual pages. Tick or untick any of them; the role stays as a label.";

/** The names of some areas' ordinary pages, in the navigation's order. */
export function pageNames(areas: readonly Area[]): string[] {
  return PAGE_ORDER.filter((area) => areas.includes(area)).map((area) => AREA_PAGES[area]);
}

/** The names of the sensitive pages among some areas, in their own order. */
export function sensitiveNames(areas: readonly Area[]): string[] {
  return SENSITIVE_PAGES.filter((page) => areas.includes(page.area)).map((page) => page.name);
}

/**
 * The ticked areas whose pages none of the person's companies has anything
 * on (fundraising, for someone on Globex alone). Ticking one opens
 * nothing: the server keeps a company's pages to the people on it. Said here
 * so the owner is not surprised; with no company chosen there is nothing to say.
 */
export function emptyFor(
  areas: readonly Area[],
  companies: readonly CompanyId[],
): GrantableArea[] {
  if (companies.length === 0) return [];
  return PAGE_ORDER.filter((area) => {
    const pages = Object.entries(PAGE_AREAS).filter(([, pageArea]) => pageArea === area);
    // An area with no page of its own (`review`: editing goals) is never "empty".
    return (
      areas.includes(area) &&
      pages.length > 0 &&
      pages.every(([href]) => !companies.some((company) => pageServes(company, href)))
    );
  });
}

/** What a teammate with no page at all gets, said rather than refused. */
export const NO_PAGES =
  "No pages: this person can sign in, and sees only “You do not have access to this page”.";

/** What the owner should know about a set of pages before, or after, saving it. */
export function PagesNote({
  areas,
  companies,
  className,
}: {
  areas: readonly Area[];
  companies: readonly CompanyId[];
  className?: string;
}) {
  const empty = emptyFor(areas, companies);
  if (areas.length > 0 && empty.length === 0) return null;
  return (
    <p className={cn("text-xs text-ink-2", className)}>
      {areas.length === 0
        ? NO_PAGES
        : `Empty for someone on ${companyNames(companies)} only: ${pageNames(empty).join(", ")}.`}
    </p>
  );
}

/**
 * One checkbox per page that can be given: the ordinary pages in the
 * navigation's order, then, in a group of their own, the two sensitive
 * ones with what each lets the person do, and the line saying Payroll and
 * Costs are the owner's alone.
 */
export function PageChecks({
  value,
  onChange,
  sensitiveLocked = false,
}: {
  value: readonly GrantableArea[];
  onChange: (next: GrantableArea[]) => void;
  /**
   * For a viewer who is not the owner: the sensitive boxes are shown as they
   * stand and cannot be changed. The server refuses the change either way.
   */
  sensitiveLocked?: boolean;
}) {
  const id = useId();
  // Rebuilt from the table, so the order sent never depends on the clicks.
  const toggle = (area: GrantableArea, checked: boolean) =>
    onChange(GRANTABLE_AREAS.filter((other) => (other === area ? checked : value.includes(other))));
  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="text-sm font-medium text-ink">Pages</legend>
        <div className="mt-1.5 grid gap-x-5 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
          {PAGE_ORDER.filter(areaOn).map((area) => (
            <label key={area} className="flex min-h-6 items-start gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={value.includes(area)}
                onChange={(e) => toggle(area, e.target.checked)}
                className="mt-0.5 size-4 shrink-0 accent-brand"
              />
              {AREA_PAGES[area]}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="rounded-inner border border-line p-3">
        <legend className="px-1 text-sm font-medium text-ink">Sensitive</legend>
        <p className="text-xs text-ink-2">{sensitiveLocked ? SENSITIVE_OWNERS : SENSITIVE_HINT}</p>
        <div className="mt-2 space-y-2">
          {SENSITIVE_PAGES.map((page) => (
            <div key={page.area} className="flex items-start gap-2">
              <input
                id={`${id}-${page.area}`}
                type="checkbox"
                checked={value.includes(page.area)}
                disabled={sensitiveLocked}
                aria-describedby={`${id}-${page.area}-about`}
                onChange={(e) => toggle(page.area, e.target.checked)}
                className="mt-0.5 size-4 shrink-0 accent-brand"
              />
              <div className="min-w-0 text-sm">
                <label htmlFor={`${id}-${page.area}`} className="font-medium text-ink">
                  {page.name}
                </label>
                <p id={`${id}-${page.area}-about`} className="text-xs text-ink-2">
                  {page.description}
                </p>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-ink-2">{PAY_AND_COSTS_NOTE}</p>
      </fieldset>
    </div>
  );
}
