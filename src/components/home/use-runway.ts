"use client";

import { useQuery } from "convex/react";
import { useMemo } from "react";
import { api } from "@convex/_generated/api";
import { periodStart } from "@convex/lib/periods";
import { useCompany } from "@/components/company-provider";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { groupOfCard } from "@/lib/finance/group";
import { companyCashPath, groupCashPath, type RunOutDay } from "@/lib/finance/runway-path";
import { financeSummary, moneyTilesOf } from "@/lib/metrics/finance";

/** Today as "YYYY-MM-DD" in UTC, as Finance starts its runway line. */
export const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);

/**
 * The run-out Finance shows this viewer first: the group's for a viewer on
 * both companies (Finance's default lens is the group), else their company's
 * own. The same functions as Finance's runway glances (`GroupRunwayGlance`,
 * `RunwayGlance` in src/components/finance/runway-glance.tsx: `groupOfCard`,
 * `groupCashPath`, `companyCashPath`), from the same reads.
 *
 *   null       not this viewer's (no finance: nothing is asked), or not known
 *   undefined  still being read
 */
export function useRunway(): { subject: string; runOut: RunOutDay } | null | undefined {
  const viewer = useViewer();
  const company = useCompany();
  const allowed = viewer.can("finance");
  const both = viewer.companies.includes("us") && viewer.companies.includes("kz");
  const own = company ?? viewer.companies[0] ?? null;
  const kzNeeded = allowed && (both || own === "kz");
  // The scorecard as the server sends it: only the viewer's companies' figures.
  const card = useQuery(api.metrics.scorecard, allowed ? {} : "skip");
  const kzCash = useQuery(api.metrics.series, kzNeeded ? { key: "cash", scope: "kz", limit: 400 } : "skip");
  const now = useNow();
  return useMemo(() => {
    if (!allowed || own === null) return null;
    if (card === undefined || now === null || (kzNeeded && kzCash === undefined)) return undefined;
    const currentMonth = periodStart("month", now);
    const readAt = card.sources.mercury?.lastOkAt ?? null;
    const today = dayOf(now);
    if (both) {
      const { group } = groupOfCard(card.tiles, kzCash ?? [], currentMonth, readAt);
      const path = groupCashPath(group, today);
      return path.kind === "projected" ? { subject: "Group cash", runOut: path.runOut } : null;
    }
    const summary = financeSummary(
      moneyTilesOf(own, card.tiles, viewer.companies),
      own === "kz" ? (kzCash ?? []) : [],
      currentMonth,
      readAt,
      [own],
    );
    const path = companyCashPath(summary, own, today);
    return path.kind === "projected" ? { subject: "Cash", runOut: path.runOut } : null;
  }, [allowed, own, card, now, kzNeeded, kzCash, both, viewer.companies]);
}
