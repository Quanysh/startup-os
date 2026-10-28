// Asking PostHog every question for Globex's app, a slice of weeks at a
// time (PostHog runs an API query for 10 seconds at most), and putting each
// question's slices back together. No Convex here: the connector and the
// dry-run script both use it, each with its own way to send a query.

import { ConnectorError } from "./errors";
import { COLUMNS, RANGE_OF, SLICE_WEEKS, halves, mergeSlices, parseRows, slicesOf, type Cell } from "./posthogGlobexParse";
import { QUESTIONS, queries, type Question, type Slice, type Window } from "./posthogGlobexQueries";

/** Sends one query and returns PostHog's answer; throws a ConnectorError in our own words. */
export type Ask = (question: Question, query: string) => Promise<unknown>;

/** Queries running at once: PostHog runs at most three a project. */
const AT_ONCE = 3;

/** What PostHog says when a query ran out of time, or its gateway did. */
const OUT_OF_TIME = /answered (429|50[0-4])|did not answer in time/;

export type Asked = { rows: Record<Question, Cell[][]>; requests: number; slowestMs: number };

export async function askEverything(window: Window, ask: Ask, clock: () => number = Date.now): Promise<Asked> {
  let requests = 0;
  let slowestMs = 0;
  const once = async (question: Question, slice?: Slice): Promise<Cell[][]> => {
    const started = clock();
    requests += 1;
    const raw = await ask(question, queries(window, slice)[question]);
    slowestMs = Math.max(slowestMs, clock() - started);
    return parseRows(raw, question, COLUMNS[question]);
  };
  // A slice that runs out of time is asked again in two halves, down to one week.
  const sliced = async (question: Question, slice: Slice): Promise<Cell[][][]> => {
    try {
      return [await once(question, slice)];
    } catch (error) {
      const parts = halves(slice);
      if (parts === null || !(error instanceof ConnectorError) || !OUT_OF_TIME.test(error.message)) throw error;
      return [...(await sliced(question, parts[0])), ...(await sliced(question, parts[1]))];
    }
  };

  const rows = {} as Record<Question, Cell[][]>;
  // Question after question. Any one failing throws before this returns, so
  // the caller writes from a complete answer only. It then writes the numbers
  // in one mutation and, only after that commits, replaces the clinic links,
  // usage, doctors and breakdowns. Those are several mutations (a clinic's
  // year does not fit in one), each an overwrite of its own rows, so the next
  // run fills in a batch that stopped. A number write that throws leaves
  // those tables as they were.
  for (const question of QUESTIONS) {
    const range = RANGE_OF[question];
    if (range === "months") {
      rows[question] = await once(question);
      continue;
    }
    const weeks = range === "weeks" ? window.weeks : range === "data" ? window.dataWeeks : window.breakdownWeeks;
    // A question's slices three at a time, the most PostHog runs at once for
    // a project; put back in order, oldest first.
    const slices = slicesOf(weeks, SLICE_WEEKS[question]);
    const answers: Cell[][][][] = new Array(slices.length);
    let next = 0;
    const worker = async () => {
      while (next < slices.length) {
        const i = next++;
        answers[i] = await sliced(question, slices[i]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, slices.length) }, worker));
    rows[question] = mergeSlices(question, answers.flat(1));
  }
  return { rows, requests, slowestMs };
}
