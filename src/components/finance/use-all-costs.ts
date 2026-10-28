"use client";

import { useQuery } from "convex/react";
import { useMemo } from "react";
import { api } from "@convex/_generated/api";
import { companyIds, type CompanyId } from "@convex/lib/company";
import { useViewer } from "@/hooks/use-viewer";
import { allCosts, companyCosts, isLoaded, type AllCosts, type Lens } from "@/lib/finance/all-costs";
import { latestRate } from "@/lib/finance/group";
import type { Tile } from "@/lib/metrics/scorecard";

/**
 * Every recurring cost of the companies in the lens this month, composed in
 * the browser from the functions Payroll, Costs and the budget already use.
 * Payroll's are asked for only by a viewer who holds Payroll, and Costs' only
 * by one who holds Costs, each only for the companies in the lens: anyone
 * else sends no such query (the server would refuse it) and is told where the
 * figures are. Undefined while anything asked for is still on its way.
 */
export function useAllCosts(lens: Lens, currentMonth: string, tiles: readonly Tile[]): AllCosts | undefined {
  const viewer = useViewer();
  const holdsPayroll = viewer.can("payroll");
  const holdsCosts = viewer.can("costs");
  const inLens = (company: CompanyId) => lens === "group" || lens === company;
  const payArgs = (company: CompanyId) => (holdsPayroll && inLens(company) ? { company } : "skip");
  const costArgs = (company: CompanyId) => (holdsCosts && inLens(company) ? { company } : "skip");

  const usPeople = useQuery(api.payroll.listPeople, payArgs("us"));
  const usLines = useQuery(api.payroll.listLines, payArgs("us"));
  const usRuns = useQuery(api.payroll.listRuns, payArgs("us"));
  const usCosts = useQuery(api.costs.list, costArgs("us"));
  const kzPeople = useQuery(api.payroll.listPeople, payArgs("kz"));
  const kzLines = useQuery(api.payroll.listLines, payArgs("kz"));
  const kzRuns = useQuery(api.payroll.listRuns, payArgs("kz"));
  const kzCosts = useQuery(api.costs.list, costArgs("kz"));

  return useMemo(() => {
    const fx = latestRate(tiles)?.rate ?? null;
    const reads = {
      us: { payroll: { people: usPeople, lines: usLines, runs: usRuns }, costLines: usCosts },
      kz: { payroll: { people: kzPeople, lines: kzLines, runs: kzRuns }, costLines: kzCosts },
    };
    const companies = companyIds().filter((company) => lens === "group" || lens === company).map((company) =>
      companyCosts({
        company,
        month: currentMonth,
        fx,
        holdsPayroll,
        holdsCosts,
        ...reads[company],
      }),
    );
    const loaded = companies.filter(isLoaded);
    return loaded.length < companies.length ? undefined : allCosts({ lens, companies: loaded, fx });
  }, [lens, currentMonth, tiles, holdsPayroll, holdsCosts, usPeople, usLines, usRuns, usCosts, kzPeople, kzLines, kzRuns, kzCosts]);
}
