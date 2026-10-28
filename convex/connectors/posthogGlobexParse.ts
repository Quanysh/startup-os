// PostHog's answers for Globex's app, read by position into typed rows.
// Pure: no fetch, no clock, so it is tested against made-up fixtures.
//
// A cell is a whole number unless its column says otherwise. The strings
// allowed are a clinic's id, a person's id, a doctor's first and last name, a
// clinic's name (only to link it to its row in Customers), an event's name
// and a page's path with its ids taken out. Each is held to its own shape
// here; a refusal names the question, never what came back.

import { z } from "zod";
import { cleanRemote } from "../lib/mirrorRules";
import { ConnectorError } from "./errors";
import { ROW_LIMIT, type Question } from "./posthogGlobexQueries";
import { expectShape } from "./shape";

const WHO = "PostHog";

/** What a column holds. */
type Column = "n" | "org" | "person" | "name" | "event" | "page";

/** A clinic's id in Globex's app (a Clerk organisation id). */
export const ORG_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A PostHog person id (a UUID). */
export const PERSON_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** An event's name: letters (Cyrillic too), digits, spaces and a few marks. */
export const EVENT_NAME = /^[\p{L}\p{N}_$ .:-]{1,80}$/u;
/** A page's path once its ids are ":id": no query, no fragment, nothing else. */
export const PAGE_PATH = /^\/[A-Za-z0-9/_:.-]{0,119}$/;

/** The longest name kept, after cleaning. */
const NAME_MAX = 60;

const answer = z.object({
  results: z.array(z.array(z.unknown())),
  hasMore: z.boolean().nullish(),
  error: z.unknown().optional(),
});

/** A cell as a whole number of zero or more, or null when it is anything else. */
function wholeNumber(cell: unknown): number | null {
  if (typeof cell === "number") {
    // A rounded quantile can arrive as 288.0, which JSON reads as 288.
    return Number.isSafeInteger(cell) && cell >= 0 ? cell : null;
  }
  if (typeof cell === "string" && /^\d{1,15}(\.0+)?$/.test(cell)) return Number.parseInt(cell, 10);
  return null;
}

/** A cell as text of a shape, or null; an empty cell is "". */
function text(cell: unknown, shape: RegExp): string | null {
  if (cell === null || cell === undefined || cell === "") return "";
  if (typeof cell !== "string") return null;
  return shape.test(cell) ? cell : null;
}

export type Cell = number | string;

/**
 * One question's answer as rows of cells, each held to its column. Refused
 * when PostHog reports an error, cuts the answer short or sends a row that
 * does not fit.
 */
export function parseRows(raw: unknown, question: Question, columns: readonly Column[]): Cell[][] {
  const body = expectShape(answer, raw, WHO, question);
  if (body.error !== undefined && body.error !== null) {
    throw new ConnectorError(`PostHog reported an error for ${question}.`);
  }
  if (body.hasMore === true || body.results.length >= ROW_LIMIT) {
    throw new ConnectorError(`PostHog's ${question} result was cut short.`);
  }
  return body.results.map((row) => {
    if (row.length !== columns.length) {
      throw new ConnectorError(`PostHog's ${question} result has a row of the wrong length.`);
    }
    return row.map((cell, i) => {
      const column = columns[i]!;
      const value =
        column === "n"
          ? wholeNumber(cell)
          : column === "org"
            ? text(cell, ORG_ID)
            : column === "person"
              ? text(cell, PERSON_ID)
              : // An event or a page that does not fit is left out (""), not
                // a failed run: an odd name somewhere must not stop the rest.
                column === "event"
                ? (text(cell, EVENT_NAME) ?? "")
                : column === "page"
                  ? (text(cell, PAGE_PATH) ?? "")
                  : typeof cell === "string" || cell === null || cell === undefined
                    ? cleanRemote(cell ?? "", NAME_MAX)
                    : null;
      if (value === null) {
        throw new ConnectorError(`PostHog's ${question} result has a cell that does not fit its column.`);
      }
      return value;
    });
  });
}

/** Each question's columns, in the order its query selects them. */
export const COLUMNS: Record<Question, readonly Column[]> = {
  weeks: ["n", ...Array<Column>(31).fill("n")],
  // week, module, actions, doctors, clinics, failures, results, timed, p50, p95, slow, cost, cost events, hedged, tokens p95
  modules: Array<Column>(15).fill("n"),
  failures: ["n", "n", "n", "n"],
  // week, org, actions, checks, failures, doctors, days, last day, plan, then actions by module
  clinics: ["n", "org", "n", "n", "n", "n", "n", "n", "n", ...Array<Column>(10).fill("n")],
  orgs: ["org", "name"],
  // doctor, day, actions, then actions by module
  doctor_days: ["person", "n", "n", ...Array<Column>(10).fill("n")],
  // doctor, first name, last name, first seen, trial ended, subscribed, org, plan, last event
  people: ["person", "name", "name", "n", "n", "n", "org", "n", "event"],
  hours: ["n", "n", "n", "n", "n"],
  pages: ["n", "page", "n", "n", "n", "n"],
  events: ["n", "event", "n", "n"],
  fields: ["n", ...Array<Column>(16).fill("n")],
  months: ["n", "n", "n"],
};

// ── Slices: PostHog runs an API query for 10 seconds at most ───────────────

/** Which weeks a question reads: the weeks written, the year read, or the breakdowns' weeks. */
export const RANGE_OF: Record<Question, "weeks" | "data" | "breakdown" | "months"> = {
  weeks: "weeks",
  modules: "weeks",
  failures: "weeks",
  hours: "weeks",
  clinics: "data",
  orgs: "data",
  doctor_days: "data",
  people: "data",
  pages: "breakdown",
  events: "breakdown",
  fields: "breakdown",
  months: "months",
};

/** Weeks one request asks for, per question; a slice that still times out is halved. */
export const SLICE_WEEKS: Record<Question, number> = {
  weeks: 2,
  modules: 2,
  failures: 4,
  hours: 4,
  clinics: 8,
  orgs: 13,
  doctor_days: 8,
  people: 8,
  pages: 4,
  events: 4,
  fields: 4,
  months: 0,
};

const plusWeeks = (monday: string, weeks: number) =>
  new Date(Date.parse(`${monday}T00:00:00Z`) + weeks * 7 * 86_400_000).toISOString().slice(0, 10);

/** Weeks (Mondays, oldest first) cut into slices of `size` weeks, each Monday to Monday. */
export function slicesOf(weeks: readonly string[], size: number): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (let i = 0; i < weeks.length; i += Math.max(1, size)) {
    const part = weeks.slice(i, i + Math.max(1, size));
    out.push({ from: part[0]!, to: plusWeeks(part.at(-1)!, 1) });
  }
  return out;
}

/** A slice in two, at a Monday; null for a slice of one week, which cannot be cut. */
export function halves(slice: { from: string; to: string }): [{ from: string; to: string }, { from: string; to: string }] | null {
  const weeks = Math.round((Date.parse(`${slice.to}T00:00:00Z`) - Date.parse(`${slice.from}T00:00:00Z`)) / (7 * 86_400_000));
  if (weeks <= 1) return null;
  const middle = plusWeeks(slice.from, Math.floor(weeks / 2));
  return [
    { from: slice.from, to: middle },
    { from: middle, to: slice.to },
  ];
}

/**
 * The answers of a question's slices, oldest slice first, as one answer.
 * Grouped by week or day, they are put end to end. A person or a clinic seen
 * in several slices is one row: first seen and a trial's end the earliest, a
 * subscription the latest, and the name, clinic, plan and last event as the
 * latest slice that has them says.
 */
export function mergeSlices(question: Question, parts: readonly Cell[][][]): Cell[][] {
  if (question === "orgs") {
    const byOrg = new Map<string, Cell[]>();
    for (const rows of parts) {
      for (const row of rows) {
        const before = byOrg.get(String(row[0]));
        byOrg.set(String(row[0]), before && row[1] === "" ? before : row);
      }
    }
    return [...byOrg.values()];
  }
  if (question === "people") {
    const byPerson = new Map<string, Cell[]>();
    const earliest = (a: Cell, b: Cell) => (Number(a) === 0 ? b : Number(b) === 0 ? a : Math.min(Number(a), Number(b)));
    for (const rows of parts) {
      for (const row of rows) {
        const before = byPerson.get(String(row[0]));
        if (before === undefined) {
          byPerson.set(String(row[0]), [...row]);
          continue;
        }
        const named = row[1] !== "" || row[2] !== "";
        const acted = row[6] !== "";
        byPerson.set(String(row[0]), [
          row[0]!,
          named ? row[1]! : before[1]!,
          named ? row[2]! : before[2]!,
          earliest(before[3]!, row[3]!),
          earliest(before[4]!, row[4]!),
          Math.max(Number(before[5]), Number(row[5])),
          acted ? row[6]! : before[6]!,
          acted ? row[7]! : before[7]!,
          row[8] !== "" ? row[8]! : before[8]!,
        ]);
      }
    }
    return [...byPerson.values()];
  }
  return parts.flat();
}
