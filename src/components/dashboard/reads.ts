"use client";

import { useQuery } from "convex/react";
import { useMemo } from "react";
import { api } from "@convex/_generated/api";
import { useCompany } from "@/components/company-provider";
import { useViewer } from "@/hooks/use-viewer";
import { categoryServes, marketsOf, pageServes, type CompanyId } from "@/lib/company";
import type { PullsInView } from "@/lib/metrics/engineering";

// What the dashboard's sections read, each behind the same rule: a query the
// server would refuse throws and takes the page with it, so it is never sent.
// Every hook answers one of three things:
//
//   null       not this viewer's, or not this company's: never asked for
//   undefined  asked for, not yet answered
//   a value    the answer, narrowed to the company in view
//
// Two sections that read the same thing share one subscription (Convex keys
// them by function and arguments), so a section owning its reads costs nothing.

/** The markets in view that the viewer is on: Convex refuses the other's rows. */
export function useMarkets(): CompanyId[] {
  const company = useCompany();
  const { companies } = useViewer();
  return marketsOf(company).filter((market) => companies.includes(market));
}

/** One market's deal board, for a viewer who sells in it. */
export function useDeals(market: CompanyId) {
  const sells = useViewer().can("sales");
  const allowed = useMarkets().includes(market) && sells;
  const board = useQuery(api.deals.board, allowed ? { market } : "skip");
  return allowed ? board : null;
}

/** One company's partnerships board, for a viewer who has the area and is on that company. */
export function usePartners(company: CompanyId) {
  const has = useViewer().can("partnerships");
  const allowed = useMarkets().includes(company) && has;
  const board = useQuery(api.partnerships.board, allowed ? { company } : "skip");
  return allowed ? board : null;
}

/** Whether the investor board is this view's: investors are Startup's. */
export function useFundraises(): boolean {
  const company = useCompany();
  const { can, companies } = useViewer();
  return can("fundraising") && companies.includes("us") && pageServes(company, "/fundraising");
}

export function useInvestors() {
  const allowed = useFundraises();
  const board = useQuery(api.investors.board, allowed ? {} : "skip");
  return allowed ? board : null;
}

/** The clinics of the markets in view, with the day the register was last pushed. */
export function useClinics() {
  const allowed = useViewer().can("customers");
  const markets = useMarkets();
  const all = useQuery(api.customers.list, allowed ? {} : "skip");
  // Keyed on what the list holds: `markets` is a new array each render.
  const marketKey = markets.join(",");
  const narrowed = useMemo(
    () =>
      all && {
        ...all,
        customers: all.customers.filter((clinic) => marketKey.split(",").includes(clinic.market)),
      },
    [all, marketKey],
  );
  return allowed ? narrowed : null;
}

/** The obligations of the company in view. */
export function useObligations() {
  const allowed = useViewer().can("compliance");
  const company = useCompany();
  const all = useQuery(api.obligations.list, allowed ? {} : "skip");
  const narrowed = useMemo(
    () => all?.filter((obligation) => categoryServes(company, obligation.category)),
    [all, company],
  );
  return allowed ? narrowed : null;
}

/** The vendor agreements of the company in view: their ends feed Today's "Needs you". */
export function useAgreements() {
  const allowed = useViewer().can("compliance");
  const company = useCompany();
  const all = useQuery(api.evidence.agreements, allowed ? {} : "skip");
  const narrowed = useMemo(
    () => all?.filter((agreement) => company === null || agreement.company === company),
    [all, company],
  );
  return allowed ? narrowed : null;
}

/**
 * The owner's target for a figure, where one is set: what puts "On target"
 * or "Off target" on a tile. Targets are the scorecard area's; without it, or
 * until they arrive, a tile is drawn without one.
 */
export function useTargets(): (key: string, scope: string) => number | undefined {
  const targets = useQuery(api.targets.list, useViewer().can("scorecard") ? {} : "skip");
  return (key, scope) => targets?.find((t) => t.key === key && t.scope === scope)?.target;
}

/**
 * GitHub's pull request list for the companies in view, for a viewer with the
 * engineering area: what every "N pull requests stuck" on the Dashboard is
 * counted from (`stuckCount`, the Engineering page's five rules).
 */
export function usePullsInView(): PullsInView | null | undefined {
  const allowed = useViewer().can("engineering");
  const markets = useMarkets();
  const list = useQuery(api.workTools.pullRequests, allowed ? {} : "skip");
  // Keyed on what the list holds: `markets` is a new array each render.
  const marketKey = markets.join(",");
  const inView = useMemo(
    () =>
      list && {
        companies: marketKey === "" ? [] : (marketKey.split(",") as CompanyId[]),
        readAt: list.readAt,
        rows: list.rows,
      },
    [list, marketKey],
  );
  return allowed ? inView : null;
}
