// ARR per person in the OS, for the Assistant page's one ratio. Pure.
//
// A state table, first matching row wins:
//
//   the view is Globex alone        other_company  the published lines are US and EU figures
//   MRR for Startup has no figure        no_mrr         "Not known yet": a missing number is not a zero
//   nobody is counted                  no_people      never a division by zero
//   otherwise                          known          latest MRR × 12 ÷ people
//
// "People" is who is in the OS on Startup (the owner and the teammates on it),
// from the list a task can be given to. It is not a payroll head count, and
// the tile says so: someone paid who was never added here is not counted,
// and someone added who is not an employee is.

import { COMPANIES, type CompanyId } from "@/lib/company";

type Tile = {
  key: string;
  scope: string;
  latest: { value: number; periodStart: string } | null;
};

export type ArrPerPerson =
  | { state: "other_company" }
  | { state: "no_mrr" }
  | { state: "no_people" }
  | { state: "known"; value: number; arr: number; people: number; periodStart: string };

export function arrPerPerson(input: {
  /** The company in view. */
  company: CompanyId;
  tiles: readonly Tile[];
  /** People in the OS on Startup. */
  people: number;
}): ArrPerPerson {
  if (input.company !== "us") return { state: "other_company" };
  const mrr = input.tiles.find((tile) => tile.key === "mrr" && tile.scope === "us")?.latest ?? null;
  if (mrr === null || !Number.isFinite(mrr.value)) return { state: "no_mrr" };
  if (!Number.isInteger(input.people) || input.people <= 0) return { state: "no_people" };
  const arr = mrr.value * 12;
  return {
    state: "known",
    value: arr / input.people,
    arr,
    people: input.people,
    periodStart: mrr.periodStart,
  };
}

export const ARR_WORDS = {
  other_company:
    `Given for ${COMPANIES.us.name} only: the published figures are from US and European software companies.`,
  no_mrr: `Not known yet: MRR for ${COMPANIES.us.name} has not been read.`,
  no_people: `Not known yet: nobody is counted on ${COMPANIES.us.name}.`,
  marks: "Reported, not verified at source.",
} as const;
