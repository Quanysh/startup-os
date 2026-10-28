// The companies the OS is run for, and what belongs to each. One app and one
// store: a company is a view, chosen with the switch in the sidebar. What is
// not tagged by market (mail, calendar, tasks, meetings, goals, the weekly
// review) is shared and shows in every company.
//
// Two in main: "us" and its second, "kz". With the `secondCompany` switch off
// (convex/lib/features.ts) the OS is run for "us" alone: `companyIds()` is
// that one, and everything that goes through every company (the owner's
// companies, a teammate's, the crons, the agents' tools, the seed) asks it.

import { featureOn } from "./featureGates";
import { LINEAR_TEAM_PREFIXES, SUBSIDIARY_COUNTERPARTY } from "./features";
import { COMPANY_IDENTITY, type CompanyIdentity } from "./identity";
import type { ObligationCategory } from "./obligationShape";
import type { Scope, SourceId } from "./metricRegistry";

/**
 * Every company id the code knows, whether or not this OS is run for it: for
 * types, stored rows and validators. What is in use is `companyIds()`.
 */
export const ALL_COMPANY_IDS = ["us", "kz"] as const;
/** A company's id is its market. */
export type CompanyId = (typeof ALL_COMPANY_IDS)[number];

/** The company the OS is always run for: the first, and the default view. */
export const DEFAULT_COMPANY: CompanyId = "us";
/** The second company, there only while `secondCompany` is switched on. */
export const SECOND_COMPANY: CompanyId = "kz";

/**
 * The companies this OS is run for, in their order: both in main, "us" alone
 * in one-company mode. Read when asked, never when this module loads, so a
 * test can switch the second company off for one case.
 */
export function companyIds(): readonly CompanyId[] {
  return featureOn("secondCompany") ? ALL_COMPANY_IDS : [DEFAULT_COMPANY];
}

/** Whether there is more than one company: a switch, a group, a "both" to show. */
export const manyCompanies = (): boolean => companyIds().length > 1;

/** Said for a company the OS is not run for. Fixed words. */
export const COMPANY_NOT_IN_USE = "That company is not part of this OS.";

export type Company = {
  id: CompanyId;
  name: string;
  /** Where it operates, as the switch shows it beside the name. */
  marketLabel: string;
  /** The company as the law and the bank name it. */
  legalName: string;
  /** The company that owns this one, for a subsidiary. */
  parent?: CompanyId;
  /** The currency its money is kept in (its identity's). */
  currency: CompanyIdentity["currency"];
};

function companyOf(id: CompanyId): Company {
  const { name, marketLabel, legalName, parent, currency }: CompanyIdentity = COMPANY_IDENTITY[id];
  return parent === undefined
    ? { id, name, marketLabel, legalName, currency }
    : { id, name, marketLabel, legalName, parent, currency };
}

/**
 * The hashtag that names a company's board in a Telegram group, as the bot
 * and the settings page show it: its identity's first (convex/lib/identity.ts).
 */
export const hashtagOf = (id: CompanyId): string => `#${COMPANY_IDENTITY[id].hashtags[0]}`;

/**
 * Each company's names, from the identity (convex/lib/identity.ts). "kz" is
 * the subsidiary of "us": the team is mostly paid through it, and the parent
 * pays most subscriptions from Mercury and funds the subsidiary from there:
 * money the parent sends it is the subsidiary's money, whose spending is in
 * the subsidiary's own figures.
 */
export const COMPANIES: Record<CompanyId, Company> = { us: companyOf("us"), kz: companyOf("kz") };

/**
 * Whether a bank counterparty is the subsidiary: the bank's name for it holds
 * `SUBSIDIARY_COUNTERPARTY` (convex/lib/features.ts), matched in any capitals
 * inside the counterparty's name, so a respelling of the company type around
 * it does not hide a transfer. The one place the name is matched: a name is read to mark
 * a payment and is never stored, logged or returned. Never, while the
 * subsidiary's funding is switched off (convex/lib/features.ts).
 */
export function isSubsidiaryCounterparty(name: string | null | undefined): boolean {
  return (
    featureOn("subsidiaryFunding") &&
    typeof name === "string" &&
    name.toLowerCase().includes(SUBSIDIARY_COUNTERPARTY.toLowerCase())
  );
}

/** Whether a value is the id of a company this OS is run for. */
export function isCompanyId(value: unknown): value is CompanyId {
  return companyIds().includes(value as CompanyId);
}

/**
 * The markets a view covers: the company's own, or every company when none
 * is chosen. Finance math takes this, so a one-company view never waits for
 * the other company's figures.
 */
export function marketsOf(company: CompanyId | null): readonly CompanyId[] {
  return company === null ? companyIds() : [company];
}

const SCOPE_COMPANY: Partial<Record<Scope, CompanyId>> = {
  us: "us",
  startup_insights: "us",
  vertical_startup: "us",
  kz: "kz",
  kz_product: "kz",
};

// "company" scope predates the split. Each such metric belongs to one company:
// the exchange rate exists to convert tenge; the rest are measured on Startup's
// site and pages.
const COMPANY_SCOPE_OWNER: Record<string, CompanyId> = { fx_usd_kzt: "kz" };

/** The company a stored figure belongs to. */
export function companyOfMetric(key: string, scope: string): CompanyId {
  return SCOPE_COMPANY[scope as Scope] ?? COMPANY_SCOPE_OWNER[key] ?? "us";
}

/**
 * Whether a thing one company owns (`owner`; undefined is every company's)
 * is in a view of `company` (null: every company): never a company's this OS
 * is not run for.
 */
function serves(owner: CompanyId | undefined, company: CompanyId | null): boolean {
  if (owner === undefined) return true;
  return companyIds().includes(owner) && (company === null || owner === company);
}

/** Keep the figures of one company. With no company chosen, every company's are kept. */
export function tilesOf<T extends { key: string; scope: string }>(
  company: CompanyId | null,
  tiles: readonly T[],
): T[] {
  return tiles.filter((tile) => serves(companyOfMetric(tile.key, tile.scope), company));
}

// A source missing here serves every company (manual entry and the work tools).
const SOURCE_COMPANY: Partial<Record<SourceId, CompanyId>> = {
  mercury: "us",
  vercel: "us",
  vertical_startup: "us",
  apollo: "us",
  search_console: "us",
  visible: "us",
  // The people Visible and Apollo put in Startup's Contacts book, and the
  // Kazakhstan CRM in Globex's. Mail's and meetings' people go to either.
  visible_contacts: "us",
  apollo_contacts: "us",
  kz_crm_contacts: "kz",
  // The plan is Startup's US business.
  financial_model: "us",
  cfo_workbook: "kz",
  client_register: "kz",
  kz_crm: "kz",
  intercom: "kz",
  // Globex's PostHog project (app.globex.example.com).
  posthog_globex: "kz",
};

/** Whether a source's failed run is this company's to hear about. */
export function sourceServes(company: CompanyId | null, source: string): boolean {
  return serves(SOURCE_COMPANY[source as SourceId], company);
}

/** Keep the sources that serve one company. */
export function sourcesOf<T>(company: CompanyId | null, sources: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(sources).filter(([id]) => sourceServes(company, id)));
}

// An obligation carries a category, not a market. A category missing here
// (company and tax dates, contracts) is kept in both views.
const CATEGORY_COMPANY: Partial<Record<ObligationCategory, CompanyId>> = {
  hipaa: "us",
  soc2: "us",
  kz_data: "kz",
  // Globex's information security management system (Globex LLP).
  iso27001: "kz",
};

export function categoryServes(company: CompanyId | null, category: ObligationCategory): boolean {
  return serves(CATEGORY_COMPANY[category], company);
}

// Pages that only one company has anything on. Any other page is in both.
const PAGE_COMPANY: Record<string, CompanyId> = {
  "/fundraising": "us",
  "/gtm": "us",
  // Globex's Intercom inbox.
  "/support": "kz",
};

export function pageServes(company: CompanyId | null, href: string): boolean {
  return serves(PAGE_COMPANY[href], company);
}

// A teammate is on one company or both. The server filters with these: the
// same rules as above, asked for a list of companies.

export const metricServesAny = (companies: readonly CompanyId[], key: string, scope: string) =>
  companies.includes(companyOfMetric(key, scope));

export const sourceServesAny = (companies: readonly CompanyId[], source: string) =>
  companies.some((company) => sourceServes(company, source));

export const categoryServesAny = (
  companies: readonly CompanyId[],
  category: ObligationCategory,
) => companies.some((company) => categoryServes(company, category));

// A Linear team is named after the company it works for (LINEAR_TEAM_PREFIXES
// in convex/lib/features.ts). A team with any other name works for both.

/** The company a Linear team belongs to, by its name; null for a team both share. */
export function companyOfLinearTeam(teamName: string): CompanyId | null {
  const name = teamName.trim().toLowerCase();
  return LINEAR_TEAM_PREFIXES.find(({ prefix }) => name.startsWith(prefix.toLowerCase()))?.company ?? null;
}

/** Whether an issue of this Linear team is in view for these companies. */
export function linearTeamServes(companies: readonly CompanyId[], teamName: string): boolean {
  const owner = companyOfLinearTeam(teamName);
  return owner === null || companies.includes(owner);
}
