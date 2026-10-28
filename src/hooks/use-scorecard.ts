import { useQuery } from "convex/react";
import { useMemo } from "react";
import { api } from "@convex/_generated/api";
import { useCompany } from "@/components/company-provider";
import { useViewer } from "@/hooks/use-viewer";
import { sourcesOf, tilesOf } from "@/lib/company";
import { moneyTilesOf } from "@/lib/metrics/finance";

/**
 * The scorecard's figures and source states for the company in view. The one
 * place a page reads them, so no page can show the other company's numbers
 * or raise an alarm for a source that feeds only the other company.
 *
 * `money` is what the company's own money math reads (`financeSummary`): in
 * Globex's view, what Startup sent it as well (`moneyTilesOf`, for a viewer
 * on Startup too), and when Mercury last finished a run, which decides whether
 * a month of that figure is whole. Neither is a tile or an alarm of Globex
 * AI's: they are only ever arithmetic there.
 */
export function useScorecard() {
  const company = useCompany();
  const { companies } = useViewer();
  const data = useQuery(api.metrics.scorecard);
  return useMemo(
    () =>
      data === undefined
        ? undefined
        : {
            ...data,
            tiles: tilesOf(company, data.tiles),
            sources: sourcesOf(company, data.sources),
            money: {
              tiles: moneyTilesOf(company, data.tiles, companies),
              mercuryReadAt: data.sources.mercury?.lastOkAt ?? null,
            },
          },
    [company, companies, data],
  );
}
