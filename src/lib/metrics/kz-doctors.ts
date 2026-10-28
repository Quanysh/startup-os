// Product › Kazakhstan › Doctors, as the team's weekly report has it: the
// four "what changed" cards, the groups, the trials that ended and the list of
// doctors with its filter and sort. Pure: the rows are `customers.doctorRoster`'s,
// and nothing here reads a clock.

import type { FunctionReturnType } from "convex/server";
import type { api } from "@convex/_generated/api";
import {
  DOCTOR_WEEKS,
  KZ_MODULES,
  TRIAL_OUTCOMES,
  type DoctorWeek,
  type TrialOutcome,
  doctorWeekOf,
} from "@convex/lib/kzProductDetail";
import { COMPANIES } from "@/lib/company";

export type Doctor = FunctionReturnType<typeof api.customers.doctorRoster>[number];

// ── The four cards ─────────────────────────────────────────────────────────

export const CARDS = ["stopped", "less", "more", "new"] as const;
export type Card = (typeof CARDS)[number];
export const CARD_TITLES: Record<Card, string> = {
  stopped: "Stopped working",
  less: "Working less",
  more: "Working more",
  new: "New doctors",
};
export const CARD_NOTES: Record<Card, string> = {
  stopped: "worked last week, no action this week",
  less: "half their usual or of last week, or less",
  more: "twice their usual or more",
  new: `new to ${COMPANIES.kz.name} this week`,
};

/** A card's doctors, in the order the report lists them. */
export function cardDoctors(roster: readonly Doctor[], card: Card): Doctor[] {
  const prev = (d: Doctor) => d.previous ?? 0;
  switch (card) {
    case "stopped":
      return roster.filter((d) => prev(d) > 0 && d.actions === 0).sort((a, b) => prev(b) - prev(a));
    case "less":
      return roster
        .filter((d) => d.week === "less")
        .sort((a, b) => Math.max(prev(b), b.usual ?? 0) - b.actions - (Math.max(prev(a), a.usual ?? 0) - a.actions));
    case "more":
      return roster.filter((d) => d.week === "more").sort((a, b) => b.actions - prev(b) - (a.actions - prev(a)));
    case "new":
      return roster.filter((d) => d.week === "new").sort((a, b) => b.actions - a.actions);
  }
}

/** How many doctors each segment holds this week and held the week before. */
export function segmentCounts(roster: readonly Doctor[]): Record<DoctorWeek, { now: number; before: number }> {
  const counts = Object.fromEntries(DOCTOR_WEEKS.map((w) => [w, { now: 0, before: 0 }])) as Record<
    DoctorWeek,
    { now: number; before: number }
  >;
  for (const d of roster) {
    counts[d.week].now += 1;
    if (d.weekBefore !== null) counts[d.weekBefore].before += 1;
  }
  return counts;
}

// ── Trials that ended ──────────────────────────────────────────────────────

export const TRIAL_LISTS = ["recent", "left", "kept", "paid", "all"] as const;
export type TrialList = (typeof TRIAL_LISTS)[number];
export const TRIAL_LIST_LABELS: Record<TrialList, string> = {
  recent: "Last 2 weeks",
  left: "Left",
  kept: "Kept working",
  paid: "Paid",
  all: "All",
};

/** Doctors whose trial ended, newest first; "recent" is from `since` (the week before last week's Monday). */
export function trialDoctors(roster: readonly Doctor[], list: TrialList, since: string): Doctor[] {
  return roster
    .filter((d) => d.trialEndedOn !== null && d.trialOutcome !== null)
    .filter((d) =>
      list === "all" ? true : list === "recent" ? d.trialEndedOn! >= since : d.trialOutcome === list,
    )
    .sort((a, b) => b.trialEndedOn!.localeCompare(a.trialEndedOn!));
}

export function trialTotals(roster: readonly Doctor[]): Record<TrialOutcome | "ended", number> {
  const totals = { ended: 0, ...Object.fromEntries(TRIAL_OUTCOMES.map((o) => [o, 0])) } as Record<
    TrialOutcome | "ended",
    number
  >;
  for (const d of roster) {
    if (d.trialOutcome === null) continue;
    totals.ended += 1;
    totals[d.trialOutcome] += 1;
  }
  return totals;
}

// ── The list of doctors ────────────────────────────────────────────────────

export const SORTS = ["doctor", "clinic", "loss", "usual", "last"] as const;
export type SortKey = (typeof SORTS)[number];
export type Sort = { key: SortKey; dir: "asc" | "desc" };
/** The biggest drop first, as the report opens the list. */
export const DEFAULT_SORT: Sort = { key: "loss", dir: "desc" };

/** A filter of the list: a segment, or one of the four cards. */
export type Who = { kind: "segment"; week: DoctorWeek } | { kind: "card"; card: Card };

type Params = { get(name: string): string | null };

/** The list's view in the address: who (`who=`), and the sort (`sort=`, `dir=`). */
export function readDoctorsView(params: Params): { who: Who | null; sort: Sort; trials: TrialList } {
  const who = params.get("who") ?? "";
  const sort = params.get("sort") ?? "";
  const dir = params.get("dir");
  const trials = params.get("trials") ?? "";
  return {
    who: (CARDS as readonly string[]).includes(who.replace(/^card-/, "")) && who.startsWith("card-")
      ? { kind: "card", card: who.replace(/^card-/, "") as Card }
      : (DOCTOR_WEEKS as readonly string[]).includes(who)
        ? { kind: "segment", week: who as DoctorWeek }
        : null,
    sort: (SORTS as readonly string[]).includes(sort)
      ? { key: sort as SortKey, dir: dir === "asc" ? "asc" : "desc" }
      : DEFAULT_SORT,
    trials: (TRIAL_LISTS as readonly string[]).includes(trials) ? (trials as TrialList) : "recent",
  };
}

export const whoParam = (who: Who | null) =>
  who === null ? null : who.kind === "card" ? `card-${who.card}` : who.week;

export function filterDoctors(roster: readonly Doctor[], who: Who | null, words: string, clinicOf: (d: Doctor) => string) {
  const inGroup =
    who === null
      ? roster
      : who.kind === "card"
        ? cardDoctors(roster, who.card)
        : roster.filter((d) => d.week === who.week);
  const needle = words.trim().toLowerCase();
  return needle === ""
    ? [...inGroup]
    : inGroup.filter((d) => `${d.name} ${clinicOf(d)}`.toLowerCase().includes(needle));
}

/** Clicking a header: the same one turns it round; a new one starts A–Z for words, largest first for numbers. */
export function nextSort(sort: Sort, key: SortKey): Sort {
  if (sort.key === key) return { key, dir: sort.dir === "asc" ? "desc" : "asc" };
  return { key, dir: key === "doctor" || key === "clinic" ? "asc" : "desc" };
}

export function sortDoctors(rows: Doctor[], sort: Sort, clinicOf: (d: Doctor) => string): Doctor[] {
  const value = (d: Doctor): string | number => {
    switch (sort.key) {
      case "doctor":
        return d.name;
      case "clinic":
        return clinicOf(d);
      case "loss":
        return (d.previous ?? 0) - d.actions;
      case "usual":
        return d.usual ?? -1;
      case "last":
        return d.lastActiveOn ?? "";
    }
  };
  const sign = sort.dir === "asc" ? 1 : -1;
  return rows.sort((a, b) => {
    const x = value(a);
    const y = value(b);
    return sign * (typeof x === "string" ? x.localeCompare(String(y)) : x - (y as number));
  });
}

/** A module's id as the list names it. */
export const moduleLabel = (id: string | null) => KZ_MODULES.find((m) => m.id === id)?.label ?? id ?? "—";

/** An event worth a look: a failure, a trial's end, the payment screen. */
export const isWarningEvent = (event: string | null) => event !== null && /failed|trial_ended|paywall/.test(event);
export const eventWords = (event: string | null) =>
  event === null
    ? "—"
    : event === "trial_ended"
      ? "trial ended"
      : event === "paywall_shown"
        ? "payment screen shown"
        : event.replace(/_/g, " ");

// ── A doctor over a period ─────────────────────────────────────────────────

/**
 * A doctor as the Doctors tab reads them over a period of `span` weeks ending
 * at the week of `end` (the newest when null): their actions in it against
 * the same span before, their usual (the average of up to four such spans
 * before it), their group by the same rules as a week's, and their modules.
 * A week, with no end picked, is the doctor as stored.
 */
export function doctorOver(d: Doctor, span: number, end: string | null = null): Doctor {
  if (span <= 1 && end === null) return d;
  const upTo = end === null ? d.history.length : d.history.findIndex((h) => h.weekStart === end) + 1;
  const kept = d.history.slice(0, Math.max(0, upTo));
  const chunks: (typeof kept)[] = [];
  for (let stop = kept.length; stop - span >= 0; stop -= span) chunks.unshift(kept.slice(stop - span, stop));
  const now = chunks.at(-1);
  if (now === undefined) return { ...d, actions: 0, previous: null, usual: null, modules: {}, modulesPrevious: {} };
  const total = (c: typeof kept) => c.reduce((t, h) => t + h.actions, 0);
  const days = (c: typeof kept) => c.reduce((t, h) => t + h.days, 0);
  const modules = (c: typeof kept | undefined) => {
    const out: Record<string, number> = {};
    for (const h of c ?? []) for (const [m, n] of Object.entries(h.modules)) out[m] = (out[m] ?? 0) + n;
    return out;
  };
  const before = chunks.at(-2);
  const usualOf = (index: number) => {
    const earlier = chunks.slice(Math.max(0, index - 4), index);
    return earlier.length === 0 ? null : Math.round((earlier.reduce((t, c) => t + total(c), 0) / earlier.length) * 10) / 10;
  };
  const index = chunks.length - 1;
  const usual = usualOf(index);
  const actions = total(now);
  const previous = before === undefined ? null : total(before);
  const firstWeek = chunks.slice(0, -1).every((c) => total(c) === 0) && actions > 0;
  // The "every day" rule is per week: 4 days of each week of the span.
  const week = doctorWeekOf({
    actions,
    usual: usual ?? 0,
    days: Math.floor(days(now) / span),
    firstWeek,
    lastWeek: previous,
  });
  const weekBefore =
    before === undefined || chunks.slice(0, -2).every((c) => total(c) === 0)
      ? null
      : doctorWeekOf({
          actions: previous ?? 0,
          usual: usualOf(index - 1) ?? 0,
          days: Math.floor(days(before) / span),
          firstWeek: false,
        });
  return {
    ...d,
    weekStart: now[0]!.weekStart,
    week,
    weekBefore,
    actions,
    previous,
    usual,
    activeDays: days(now),
    modules: modules(now),
    modulesPrevious: modules(before),
  };
}
