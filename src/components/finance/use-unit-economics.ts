"use client";

import { useQuery } from "convex/react";
import { useMemo } from "react";
import { api } from "@convex/_generated/api";
import { companyIds, type CompanyId } from "@convex/lib/company";
import { useViewer } from "@/hooks/use-viewer";
import type { Lens } from "@/lib/finance/all-costs";
import { latestRate } from "@/lib/finance/group";
import { unitEconomics, type CompanyUnitEconomics } from "@/lib/finance/unit-economics";
import type { Tile } from "@/lib/metrics/scorecard";

/**
 * Each company in the lens's unit economics, composed in the browser from the
 * functions Payroll, Costs and Customers already use, as All costs is. Each
 * is asked for only by a viewer who holds its page, and only for the
 * companies in the lens (the client register is one list of the viewer's own
 * companies' clinics): anyone else sends no such query, and the figures that
 * need it say where it is. No server function was added for it.
 */
export function useUnitEconomics(lens: Lens, currentMonth: string, tiles: readonly Tile[]): CompanyUnitEconomics[] {
  const viewer = useViewer();
  const holdsPayroll = viewer.can("payroll");
  const holdsCosts = viewer.can("costs");
  const holdsCustomers = viewer.can("customers");
  const inLens = (company: CompanyId) => lens === "group" || lens === company;
  const payArgs = (company: CompanyId) => (holdsPayroll && inLens(company) ? { company } : "skip");
  const costArgs = (company: CompanyId) => (holdsCosts && inLens(company) ? { company } : "skip");

  const usPeople = useQuery(api.payroll.listPeople, payArgs("us"));
  const usLines = useQuery(api.payroll.listLines, payArgs("us"));
  const usCosts = useQuery(api.costs.list, costArgs("us"));
  const kzPeople = useQuery(api.payroll.listPeople, payArgs("kz"));
  const kzLines = useQuery(api.payroll.listLines, payArgs("kz"));
  const kzCosts = useQuery(api.costs.list, costArgs("kz"));
  const register = useQuery(api.customers.list, holdsCustomers ? {} : "skip");

  return useMemo(() => {
    const fx = latestRate(tiles)?.rate ?? null;
    // What unit economics reads of a clinic: its market, contract date,
    // whether it is still in the register, and for one won on the Sales board
    // whether it has a monthly fee. Never its name.
    const clinics =
      register === undefined
        ? undefined
        : register.customers.map(({ market, contractDate, archived, fromSales, monthlyFee }) => ({
            market,
            contractDate,
            archived,
            fromSales,
            monthlyFee,
          }));
    const reads = {
      us: { people: usPeople, lines: usLines, costs: usCosts },
      kz: { people: kzPeople, lines: kzLines, costs: kzCosts },
    };
    return companyIds().filter(inLensOf(lens)).map((company) =>
      unitEconomics({
        company,
        month: currentMonth,
        fx,
        tiles,
        costLines: holdsCosts ? reads[company].costs : null,
        payroll: holdsPayroll ? { people: reads[company].people, lines: reads[company].lines } : null,
        customers: holdsCustomers ? clinics : null,
      }),
    );
  }, [lens, currentMonth, tiles, holdsPayroll, holdsCosts, holdsCustomers, usPeople, usLines, usCosts, kzPeople, kzLines, kzCosts, register]);
}

const inLensOf = (lens: Lens) => (company: CompanyId) => lens === "group" || lens === company;
