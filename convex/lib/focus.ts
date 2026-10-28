// What a role is arranged for. Every role has one focus, from this fixed set,
// and the Dashboard and Today pages put their blocks in that focus's order.
//
// A focus decides ORDER and EMPHASIS only. It never grants anything: what a
// person may see is exactly their areas and companies (convex/lib/roles.ts),
// asked with `may`, and a block whose area they lack is simply not there.
// Pure, so the browser can import it.

import { CUSTOM_ROLE, isMemberRole, type MemberRole, type Role } from "./roles";

export const FOCUSES = [
  "founder",
  "sales",
  "engineering",
  "marketing",
  "customers",
  "finance",
  "general",
] as const;
export type Focus = (typeof FOCUSES)[number];

export function isFocus(value: unknown): value is Focus {
  return FOCUSES.includes(value as Focus);
}

/** A focus as it is named on screen: "Arranged for Sales." */
export const FOCUS_LABELS: Record<Focus, string> = {
  founder: "Founder",
  sales: "Sales",
  engineering: "Engineering",
  marketing: "Marketing",
  customers: "Customers",
  finance: "Finance",
  general: "General",
};

/** What comes first for each, said beside the choice on the Team page. */
export const FOCUS_HINTS: Record<Focus, string> = {
  founder: "The whole company: what needs attention, then money.",
  sales: "Their tasks, then the deals.",
  engineering: "Their tasks, then pull requests and product health.",
  marketing: "Their tasks, then go to market.",
  customers: "Their tasks, then the clinics.",
  finance: "Money, then the dates to keep.",
  general: "Their tasks, then everything in the usual order.",
};

/** The three built-in roles' focuses. Fixed: only a role the owner named has one to choose. */
export const BUILTIN_FOCUS: Record<MemberRole, Focus> = {
  cofounder: "founder",
  sales: "sales",
  engineer: "engineering",
};

/**
 * The focus someone's pages are arranged for. The owner is always a founder;
 * a built-in role has its own; a role the owner named has the one on its row.
 * A row that is gone, or a focus this build does not know, is `general`:
 * nothing is guessed.
 */
export function focusOf(role: Role, named?: { focus: string } | null): Focus {
  if (role === "owner") return "founder";
  if (isMemberRole(role)) return BUILTIN_FOCUS[role];
  if (role === CUSTOM_ROLE && named != null && isFocus(named.focus)) return named.focus;
  return "general";
}
