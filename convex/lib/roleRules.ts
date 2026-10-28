// The rules for a role the owner names (convex/roles.ts) and for a person's
// GitHub username (convex/team.ts). Pure, so the form can say the same thing
// the server will. A role's name is typed text: cleaned here, stored as it is
// cleaned, rendered as text, and never put in a log or a thrown error.

import { ConvexError } from "convex/values";
import type { Focus } from "./focus";
import { cleanRemote } from "./mirrorRules";
import {
  GRANTABLE_AREAS,
  PAY_AND_COSTS_ARE_THE_OWNERS,
  ROLE_LABELS,
  isArea,
  isPayOrCosts,
  isPresetArea,
  type GrantableArea,
} from "./roles";
import { LOGIN } from "./sharedRecords";

/** The most roles the owner can name, beside the three built in. */
export const MAX_ROLES = 30;
export const MAX_ROLE_NAME_LENGTH = 40;

export const ROLE_NAME_TAKEN = "There is already a role with that name.";
export const ROLES_FULL = `There are ${MAX_ROLES} roles already. Delete one first.`;
export const ROLE_GONE = "That role no longer exists.";
/** Said of a built-in role, which is the same for every deployment. */
export const BUILTIN_IS_FIXED = "A built-in role cannot be changed or deleted.";
/** Said when a role's usual pages name a sensitive page, Today or one of the owner's own. */
export const PRESET_IS_ORDINARY =
  "A role's usual pages are ordinary pages only. Sources and Telegram, Team and Your day are ticked for one person.";

/**
 * A role's name as it is stored: one line, single spaces, nothing invisible,
 * one to forty characters. Too long is refused, never cut: the owner should
 * see the name they will get.
 */
export function cleanRoleName(raw: string): string {
  const name = cleanRemote(raw, Number.MAX_SAFE_INTEGER);
  if (name === "") throw new ConvexError("A role needs a name.");
  if (Array.from(name).length > MAX_ROLE_NAME_LENGTH) {
    throw new ConvexError(`That name is too long (${MAX_ROLE_NAME_LENGTH} characters at most).`);
  }
  return name;
}

/** What two names are compared by: capitals do not make a second role. */
export const roleNameKey = (name: string) => name.toLowerCase();

/** Whether a name is the owner's or a built-in role's, whatever its capitals. */
export function isReservedRoleName(name: string): boolean {
  const key = roleNameKey(name);
  return Object.values(ROLE_LABELS).some((label) => roleNameKey(label) === key);
}

/**
 * A role's usual pages, each once, in the table's order; none is allowed.
 * Ordinary pages only: payroll and costs are refused as the owner's alone, a
 * sensitive area, Today and the owner's own two in one fixed sentence, and a
 * name that is no page in another.
 */
export function cleanPreset(areas: readonly string[]): GrantableArea[] {
  if (areas.some(isPayOrCosts)) throw new ConvexError(PAY_AND_COSTS_ARE_THE_OWNERS);
  if (areas.some((area) => isArea(area) && !isPresetArea(area))) {
    throw new ConvexError(PRESET_IS_ORDINARY);
  }
  if (!areas.every(isPresetArea)) throw new ConvexError("That is not a page of the OS.");
  return GRANTABLE_AREAS.filter((area) => areas.includes(area));
}

/**
 * Names offered when the owner adds a role, each with a focus and usual pages
 * to start from. Offered, never created: a deployment has only the roles its
 * owner added.
 */
export const SUGGESTED_ROLES: readonly { name: string; focus: Focus; areas: GrantableArea[] }[] = [
  { name: "Product", focus: "engineering", areas: ["product", "engineering", "board"] },
  { name: "Marketing", focus: "marketing", areas: ["scorecard", "marketing", "gtm", "board"] },
  { name: "Customer success", focus: "customers", areas: ["customers", "board"] },
  { name: "Operations", focus: "general", areas: ["scorecard", "compliance", "board"] },
  { name: "Finance", focus: "finance", areas: ["scorecard", "finance", "compliance"] },
  { name: "Designer", focus: "general", areas: ["product", "board"] },
  { name: "Doctor/Clinical", focus: "customers", areas: ["product", "customers", "board"] },
  { name: "Advisor", focus: "general", areas: ["scorecard"] },
];

// ── A person's GitHub username ──────────────────────────────────────────────

export const GITHUB_NOT_A_USERNAME =
  "That is not a GitHub username: letters, digits and hyphens, 39 at most.";
export const GITHUB_TAKEN = "That GitHub username is already on another person.";
export const GITHUB_IS_THE_OWNERS = "Only the owner sets a GitHub username.";
const MAX_GITHUB_LENGTH = 39;

/**
 * A GitHub username as it is stored: without the "@", held to the rule a pull
 * request's author login is (`LOGIN`), 39 characters at most. Blank is none.
 * A refusal quotes nothing.
 */
export function cleanGithub(raw: string): string | undefined {
  const typed = raw.trim().replace(/^@/, "").trim();
  if (typed === "") return undefined;
  if (typed.length > MAX_GITHUB_LENGTH || !LOGIN.test(typed)) {
    throw new ConvexError(GITHUB_NOT_A_USERNAME);
  }
  return typed;
}

/** GitHub logins are one person's whatever their capitals. */
export const sameGithub = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
