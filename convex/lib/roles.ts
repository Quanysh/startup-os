// Who may use what. The areas the OS is split into, which of them the owner
// can give a teammate, and the one question the gate asks (`may`). The owner
// picks each teammate's areas one by one (`members.areas`); the gate
// (convex/lib/owner.ts) enforces that list inside Convex on every call, and
// the UI reads the same list to decide what to show. Pure, so the browser can
// import it.

import type { CompanyId } from "./company";
import { areaOn } from "./featureGates";

/** The owner and the three built-in roles. */
export const ROLES = ["owner", "cofounder", "sales", "engineer"] as const;
/**
 * What stands for a role the owner named (a row of `roles`, convex/roles.ts)
 * wherever code asks what kind of role someone has. It is never stored: a
 * teammate's row holds one of the three built-in words or the id of that row.
 */
export const CUSTOM_ROLE = "custom";
export type Role = (typeof ROLES)[number] | typeof CUSTOM_ROLE;

/** The roles a teammate can be given. The owner is never a row: see OWNER_EMAILS. */
export const MEMBER_ROLES = ["cofounder", "sales", "engineer"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  cofounder: "Co-founder",
  sales: "Sales",
  engineer: "Engineer",
  // What is said where the row a person's role points at is gone.
  custom: "No role",
};

export const AREAS = [
  "scorecard",
  "finance",
  "product",
  // Engineering: pull requests, who owns them and what is stuck (GitHub).
  "engineering",
  "sales",
  "customers",
  "compliance",
  "fundraising",
  // Partnerships: channel, integration, referral, strategic and design
  // partners from first contact to live (/partnerships), on each company.
  "partnerships",
  // Contacts: business contacts of each company (/contacts): real people's
  // email addresses, phone numbers and LinkedIn. Ordinary, but in no role's
  // starting set and no named role's usual pages, like Support: the owner
  // ticks it for each person who keeps the company's contacts.
  "contacts",
  // Outcomes: what came of a play a bot ran on a deal, a customer, an
  // investor or a partner (Bot Loop v3, `outcome_log`). No page of its own:
  // shown on the deal, customer and partner views and the Bots tab. Ordinary.
  "outcomes",
  "marketing",
  "gtm",
  "board",
  // Editing goals. (The weekly review page is put away for now.)
  "review",
  // Company memory: decisions and meeting notes (/memory). Ordinary: the
  // co-founder starts with it, anyone can be given it.
  "memory",
  // Support: Globex's Intercom inbox, its waits and Fin's outcomes
  // (/support, Globex's alone). Ordinary, but in no role's starting set:
  // the owner ticks it for each teammate who answers customers.
  "support",
  // Agents: Vertical Startup's customer-facing AI agents (/agents), their models,
  // cost and quality, and the switches that steer them. A product's, so not
  // split by company. Ordinary: the engineer and the co-founder start with it.
  "agents",
  // Today: a person's own mail, calendar, meeting notes and assigned issues.
  // Anyone can be given it, and each person is sent only their own records.
  "today",
  // Payroll and Costs are the owner's alone (PAY_AND_COSTS below): no
  // teammate can hold either, whatever their row or role says.
  // Everyone's pay, for both companies.
  "payroll",
  // Costs: what the company pays for besides pay (cloud, subscriptions, rent),
  // and with pay the run-rate and the burn.
  "costs",
  // The sensitive areas (SENSITIVE_AREAS below): ticked for a person by
  // name, in no role's starting set.
  // Sources and their runs, run-now, typed-in metrics, targets and the
  // Telegram bot's settings.
  "settings",
  // The team itself: who is let in, on which company, with which pages.
  "team",
  // The owner's work-tool settings and the built-in Google connection.
  "personal",
  // What only the owner may ever do. Nothing a teammate can be given is here.
  "admin",
] as const;
export type Area = (typeof AREAS)[number];

/**
 * Each area's short name wherever areas are listed (the Bots tab, a tool's
 * tag, a bot's refusal, a permission request). A Record over Area, so an area
 * added above does not compile until it is named here.
 */
export const AREA_NAMES: Record<Area, string> = {
  scorecard: "Scorecard",
  finance: "Finance",
  product: "Product",
  engineering: "Engineering",
  sales: "Sales",
  customers: "Customers",
  compliance: "Compliance",
  fundraising: "Fundraising",
  partnerships: "Partnerships",
  contacts: "Contacts",
  outcomes: "Outcomes",
  marketing: "Marketing",
  gtm: "Go to market",
  board: "Board",
  review: "Goals",
  memory: "Memory",
  support: "Support",
  agents: "Agents",
  today: "Today",
  payroll: "Payroll",
  costs: "Costs",
  settings: "Settings",
  team: "Team",
  personal: "Owner's own",
  admin: "Owner only",
};

export function isArea(value: unknown): value is Area {
  return AREAS.includes(value as Area);
}

/** The owner's own work tools and what else is theirs alone: never a teammate's, never a row's. */
const OWNERS_OWN = ["personal", "admin"] as const;
/** What those two hold, as the team page says it and as `team.add` refuses them. */
export const OWNERS_ONLY =
  "The owner's own mail, calendar and meeting notes, and the work-tool settings, are the owner's only.";

/**
 * Everyone's pay, and what the company pays for besides it (with which the
 * burn and the run-rate incl. pay): the owner's alone, by the owner's
 * decision. Engineers and others who work on the OS are let in, and pay is
 * not to be shown to them. Once a sensitive area ticked by name, so a row or
 * a role written before may still hold one: `effectiveAreas` reads it without
 * them, `team` and `roles` refuse them, and `migrations:dropOwnerOnlyAreas`
 * takes them out of what is stored.
 */
export const PAY_AND_COSTS = ["payroll", "costs"] as const satisfies readonly Area[];
/** Said wherever one of the two is asked for a teammate or a role, and on the team page. */
export const PAY_AND_COSTS_ARE_THE_OWNERS = "Payroll and costs are the owner's alone.";

export function isPayOrCosts(value: unknown): value is (typeof PAY_AND_COSTS)[number] {
  return PAY_AND_COSTS.includes(value as (typeof PAY_AND_COSTS)[number]);
}

/** The areas no teammate can be given: they stay the owner's alone. */
export const OWNER_ONLY_AREAS = [...OWNERS_OWN, ...PAY_AND_COSTS] as const;
export type GrantableArea = Exclude<Area, (typeof OWNER_ONLY_AREAS)[number]>;

/** The areas the owner can give a teammate, in the table's order. */
export const GRANTABLE_AREAS: readonly GrantableArea[] = AREAS.filter(
  (area): area is GrantableArea => !(OWNER_ONLY_AREAS as readonly Area[]).includes(area),
);

/**
 * What a stored list of areas (a teammate's row, a named role, the record of
 * a team change) may hold: what can be given, and payroll and costs from
 * before they were the owner's alone. Never `personal` or `admin`. Holding
 * one gives nothing: access is `effectiveAreas`.
 */
export type StoredArea = Exclude<Area, (typeof OWNERS_OWN)[number]>;
export const STORED_AREAS: readonly StoredArea[] = AREAS.filter(
  (area): area is StoredArea => !(OWNERS_OWN as readonly Area[]).includes(area),
);

export function isGrantableArea(value: unknown): value is GrantableArea {
  return GRANTABLE_AREAS.includes(value as GrantableArea);
}

/**
 * The areas that can be given but that no role starts with: each is ticked
 * for one person, by name, and by the owner alone. Settings changes the
 * numbers on the dashboard and the bot's shared switches; team adds and
 * removes people and chooses their ordinary pages. Neither lets its holder
 * give a sensitive area to anyone (convex/team.ts). Payroll and costs were
 * here until they became the owner's alone (PAY_AND_COSTS).
 */
export const SENSITIVE_AREAS = ["settings", "team"] as const satisfies readonly GrantableArea[];
export type SensitiveArea = (typeof SENSITIVE_AREAS)[number];

export function isSensitiveArea(value: unknown): value is SensitiveArea {
  return SENSITIVE_AREAS.includes(value as SensitiveArea);
}

/**
 * Areas ticked for one person, by name, and never by a role (built-in or
 * named): Today (a person's own day), Support (Globex's inbox, for whoever
 * answers its customers), Contacts (real people's addresses and numbers) and
 * the sensitive two.
 */
function isPersonAlone(area: GrantableArea): boolean {
  return area === "today" || area === "support" || area === "contacts" || isSensitiveArea(area);
}

// What a role starts with. A role is the label a teammate wears and the boxes
// ticked to begin with, nothing more. It is also what a teammate added before
// pages could be picked has: a row with no list of its own.
const ROLE_AREAS: Record<Role, readonly Area[]> = {
  owner: AREAS,
  // Every ordinary page but Today, which is in no role's starting set: the
  // owner ticks it for a person, who then connects their own Claude. Never a
  // sensitive area: "every page" must not come to mean salaries and the team.
  // Nor Support, which the owner ticks for whoever answers Globex's customers,
  // nor Contacts, ticked for whoever keeps the company's contacts.
  cofounder: GRANTABLE_AREAS.filter((area) => !isPersonAlone(area)),
  sales: ["scorecard", "sales", "customers", "marketing", "gtm", "board"],
  engineer: ["product", "engineering", "board", "agents"],
  // A role the owner named gives nothing by itself: its usual pages are what
  // the form ticks, and the person has the list that was saved for them.
  custom: [],
};

/**
 * The areas a role's usual pages may hold, built-in or named by the owner:
 * the ordinary ones. Never a sensitive area, Today, Support or Contacts, which are
 * ticked for one person, by name (`isPersonAlone`).
 */
export const PRESET_AREAS: readonly GrantableArea[] = GRANTABLE_AREAS.filter(
  (area) => !isPersonAlone(area),
);

export function isPresetArea(value: unknown): value is GrantableArea {
  return PRESET_AREAS.includes(value as GrantableArea);
}

export function isMemberRole(value: unknown): value is MemberRole {
  return MEMBER_ROLES.includes(value as MemberRole);
}

/**
 * What kind of role a teammate's row holds: one of the three built-in words,
 * or (anything else: the id of a row of `roles`) one the owner named.
 */
export function roleKind(stored: string): MemberRole | typeof CUSTOM_ROLE {
  return isMemberRole(stored) ? stored : CUSTOM_ROLE;
}

/** The areas a role starts with. Not what a person has: that is `effectiveAreas`. */
export function areasOf(role: Role): readonly Area[] {
  return ROLE_AREAS[role];
}

/**
 * The owner's areas: every one this OS has. An area a switched-off feature
 * takes away (convex/lib/featureGates.ts) is nobody's, the owner's included.
 */
export function ownerAreas(): readonly Area[] {
  return AREAS.every(areaOn) ? AREAS : AREAS.filter(areaOn);
}

/**
 * The areas a person has: every one for the owner; for a teammate the list
 * the owner picked, or their role's where the row has none. Whatever a row
 * holds, only an area that can be given counts, once, in the table's order:
 * never `personal` or `admin`, never payroll or costs, which are the owner's
 * alone whatever a row from before says, and never one a switched-off
 * feature takes away. Every gate, page, block, tool and notice reads a
 * teammate's access from here.
 */
export function effectiveAreas(
  /** "owner", or a role as a teammate's row stores it (`roleKind` reads it). */
  role: string,
  picked: readonly string[] | undefined,
): readonly Area[] {
  if (role === "owner") return ownerAreas();
  if (picked === undefined) {
    return ROLE_AREAS[roleKind(role)].filter((area) => isGrantableArea(area) && areaOn(area));
  }
  // Marketing has no page of its own: it is the inbound half of the
  // go-to-market page, so it goes with that page and never without it.
  return GRANTABLE_AREAS.filter(
    (area) => areaOn(area) && (area === "marketing" ? picked.includes("gtm") : picked.includes(area)),
  );
}

/**
 * Whether someone has an area (one of the areas, given a list; an empty list
 * is nobody's). The one way to ask what a caller may do: by the areas they
 * hold, never by their role.
 */
export function may(who: { areas: readonly Area[] }, area: Area | readonly Area[]): boolean {
  const asked: readonly Area[] = typeof area === "string" ? [area] : area;
  return asked.some((one) => who.areas.includes(one));
}

/**
 * Who is sent a goal's target. A target is what done looks like, often in a
 * figure (an MRR to reach): the company's numbers, which are the Scorecard's
 * and Finance's. Goals are also read with the board alone (its goal chips,
 * Today's summary), and a holder of only that is sent each goal without its
 * target, and cannot set or clear one (convex/goals.ts).
 */
export const GOAL_TARGET_AREAS = ["scorecard", "finance"] as const satisfies readonly Area[];

/**
 * The areas whose pages carry the company's money: cash, burn and MRR
 * (Finance), the raise and investors' commitments (Fundraising), deal amounts
 * (Sales) and each clinic's fee and what it owes (Customers). Payroll and
 * Costs are not here only because no bot may read them. What a bot that
 * reads one of these writes for the team (a handoff's words) goes to a
 * teammate only if they hold every one the bot reads (convex/handoffs.ts).
 */
export const FIGURE_AREAS = ["finance", "fundraising", "sales", "customers"] as const satisfies readonly Area[];

/**
 * Every area: what a function open to anyone with a page is gated with. A
 * teammate the owner has given no page at all is refused these too.
 */
export const ANY_AREA: readonly Area[] = AREAS;

/** The most teammates the owner can add. */
export const MAX_MEMBERS = 50;

/** What the gate knows about a caller beyond who they are. */
export type Access = {
  role: Role;
  companies: readonly CompanyId[];
  areas: readonly Area[];
};
