// The dashboard's blocks and the order each focus puts them in. Pure.
//
// A focus (convex/lib/focus.ts) decides ORDER and EMPHASIS only. What a
// person may see is their areas: a block whose area they lack is left out
// here, and nothing is put in its place. Each block's component still decides
// for itself whether it is this viewer's and this company's, and Convex
// decides what any of them is sent.
//
// The "Needs attention" list is not a block: it is first for everyone.
//
// The Dashboard answers one question, "how is the company doing?": the
// company's numbers and health. What is the viewer's own (their tasks, their
// day, the owner's brief and approvals) is on Today; asking Claude is on the
// Assistant.

import { FOCUS_LABELS, type Focus } from "@convex/lib/focus";
import type { Area } from "@convex/lib/roles";

export const DASHBOARD_BLOCKS = [
  "money",
  "customers",
  "sales",
  "fundraising",
  "product",
  "engineering",
  "gtm",
  "work",
  "compliance",
] as const;
export type BlockId = (typeof DASHBOARD_BLOCKS)[number];

/** The areas that open each block: one of them is enough. */
export const BLOCK_AREAS: Record<BlockId, readonly Area[]> = {
  money: ["finance"],
  customers: ["customers"],
  sales: ["sales"],
  fundraising: ["fundraising"],
  product: ["product"],
  engineering: ["engineering"],
  gtm: ["gtm"],
  // The team's goals, issues and board counts go with the scorecard or the board.
  work: ["scorecard", "board"],
  compliance: ["compliance"],
};

type Order = { lead: readonly BlockId[]; rest: readonly BlockId[] };

/**
 * Each focus's order. `lead` is what comes first, each across the page;
 * `rest` follows as the page always laid its blocks out. The founder's is the
 * page as it was before roles had a focus. Payroll has no block: its page is
 * in the navigation for whoever holds it.
 */
export const DASHBOARD_ORDER: Record<Focus, Order> = {
  founder: {
    lead: ["money"],
    rest: ["customers", "sales", "fundraising", "product", "engineering", "gtm", "work", "compliance"],
  },
  sales: {
    lead: ["sales"],
    rest: ["gtm", "customers", "money", "fundraising", "product", "engineering", "work", "compliance"],
  },
  engineering: {
    lead: ["engineering"],
    rest: ["product", "money", "customers", "sales", "fundraising", "gtm", "work", "compliance"],
  },
  marketing: {
    lead: ["gtm"],
    rest: ["product", "money", "customers", "sales", "fundraising", "engineering", "work", "compliance"],
  },
  customers: {
    lead: ["customers"],
    rest: ["sales", "money", "fundraising", "product", "engineering", "gtm", "work", "compliance"],
  },
  finance: {
    lead: ["money"],
    rest: ["compliance", "customers", "sales", "fundraising", "product", "engineering", "gtm", "work"],
  },
  general: {
    lead: ["money"],
    rest: ["customers", "sales", "fundraising", "product", "engineering", "gtm", "work", "compliance"],
  },
};

/**
 * The blocks a person gets, in their focus's order: only those one of whose
 * areas they hold. The rest keep their order; a lead block they lack leaves
 * the lead shorter, never filled from below.
 */
export function arrange(focus: Focus, areas: readonly Area[]): { lead: BlockId[]; rest: BlockId[] } {
  const held = (id: BlockId) => BLOCK_AREAS[id].some((area) => areas.includes(area));
  const order = DASHBOARD_ORDER[focus];
  return { lead: order.lead.filter(held), rest: order.rest.filter(held) };
}

/** The one line under the page's title: what the arrangement is, and who sets it. */
export function arrangementNote(viewer: {
  focus: Focus;
  roleName: string;
  isOwner: boolean;
}): string {
  const label = FOCUS_LABELS[viewer.focus];
  if (viewer.isOwner) {
    return `Arranged for ${label}. You set what each role's pages are arranged for on the Team page.`;
  }
  const named = viewer.roleName === label ? "" : ` (your role: ${viewer.roleName})`;
  return `Arranged for ${label}${named}. The owner sets this on the Team page.`;
}
