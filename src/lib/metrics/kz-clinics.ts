// How a clinic used Globex's app, week by week (`customers.usage`), for
// Product › Kazakhstan's Clinics tab: its last finished week against the week
// before and its own usual week. Pure, and no clock: the weeks are the ones
// the server sent.

import { KZ_MODULES, type KzModuleId } from "@convex/lib/kzProductDetail";
import type { Week } from "@/lib/metrics/kz-detail";

export type UsageWeek = {
  weekStart: string;
  checks: number;
  actions: number;
  doctors: number;
  /** Its doctors in the app, active or not; null where not read. */
  doctorsTotal?: number | null;
  /** Days of the week with an action. */
  activeDays?: number | null;
  /** The last day with an action, as of the week's end. */
  lastActiveOn?: string | null;
  plan?: "paid" | "trial" | null;
  failures: number;
  modules: Record<string, number>;
  /** Weeks the row covers (a period of `periodRows`); one when absent. */
  weeks?: number;
};

/** The weeks before the last that make a clinic's usual week. */
export const USUAL_WEEKS = 4;
/** Under this share of its usual week a clinic reads as below it. */
export const BELOW_USUAL = 0.7;

export type UsageLevel = "quiet" | "below" | "usual" | "above" | "new";

export type UsageSummary = {
  weekStart: string;
  checks: number;
  /** The average of the weeks before, rounded; null when there are none. */
  usual: number | null;
  level: UsageLevel;
  words: string;
};

const count = (n: number) => n.toLocaleString("en-US");
const checksWord = (n: number) => `${count(n)} ${n === 1 ? "check" : "checks"}`;

export function usageSummary(weeks: readonly UsageWeek[]): UsageSummary | null {
  const last = weeks.at(-1);
  if (last === undefined) return null;
  // A run of weeks with no check at the end: the usual week is the one before it.
  let quiet = 0;
  while (quiet < weeks.length && weeks[weeks.length - 1 - quiet]!.checks === 0) quiet += 1;
  const before = weeks.slice(0, weeks.length - Math.max(quiet, 1)).slice(-USUAL_WEEKS);
  const usual =
    before.length === 0 ? null : Math.round(before.reduce((sum, w) => sum + w.checks, 0) / before.length);
  const base = { weekStart: last.weekStart, checks: last.checks, usual };
  if (quiet > 0) {
    const when = quiet === 1 ? "No checks last week" : `No checks for ${quiet} weeks`;
    return { ...base, level: "quiet", words: usual ? `${when} (usually ${count(usual)})` : when };
  }
  if (usual === null || usual === 0) return { ...base, level: "new", words: `${checksWord(last.checks)} last week` };
  const ratio = last.checks / usual;
  if (ratio < BELOW_USUAL) {
    return { ...base, level: "below", words: `${checksWord(last.checks)}, below its usual ${count(usual)}` };
  }
  if (ratio > 1.5) {
    return { ...base, level: "above", words: `${checksWord(last.checks)}, above its usual ${count(usual)}` };
  }
  return { ...base, level: "usual", words: `${checksWord(last.checks)}, about its usual ${count(usual)}` };
}

/** Actions by module over the recent weeks, busiest first; a module not used is left out. */
export function recentModules(
  weeks: readonly UsageWeek[],
  recent = USUAL_WEEKS,
): { id: KzModuleId; label: string; actions: number }[] {
  const window = weeks.slice(-recent);
  return KZ_MODULES.map((m) => ({
    id: m.id,
    label: m.label,
    actions: window.reduce((sum, w) => sum + (w.modules[m.id] ?? 0), 0),
  }))
    .filter((m) => m.actions > 0)
    .sort((a, b) => b.actions - a.actions);
}

export const usesModule = (weeks: readonly UsageWeek[], module: KzModuleId): boolean =>
  recentModules(weeks).some((m) => m.id === module);

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** One module's actions at a clinic: last week against the week before, if that week is on record. */
export function moduleWeek(weeks: readonly UsageWeek[], module: KzModuleId): Week | null {
  const last = weeks.at(-1);
  if (last === undefined) return null;
  const before = weeks.at(-2);
  const adjacent = before !== undefined && Date.parse(last.weekStart) - Date.parse(before.weekStart) === WEEK_MS * (before.weeks ?? 1);
  return {
    periodStart: last.weekStart,
    value: last.modules[module] ?? 0,
    previous: adjacent ? (before.modules[module] ?? 0) : null,
  };
}

export type ClinicModule = {
  id: KzModuleId;
  label: string;
  actions: Week;
  /** Its part of the clinic's actions last week; null when the clinic took none. */
  share: number | null;
};

/** The modules a clinic used in its recent weeks, busiest last week first. */
export function clinicModules(weeks: readonly UsageWeek[]): ClinicModule[] {
  const last = weeks.at(-1);
  if (last === undefined) return [];
  const total = KZ_MODULES.reduce((sum, m) => sum + (last.modules[m.id] ?? 0), 0);
  return recentModules(weeks)
    .map((m) => {
      const actions = moduleWeek(weeks, m.id)!;
      return { id: m.id, label: m.label, actions, share: total === 0 ? null : actions.value / total };
    })
    .sort((a, b) => b.actions.value - a.actions.value || (b.actions.previous ?? 0) - (a.actions.previous ?? 0));
}

/** One of a clinic's weekly counts: last week against the week before, if that week is on record. */
export function clinicWeek(
  weeks: readonly UsageWeek[],
  field: "checks" | "actions" | "doctors" | "failures",
): Week | null {
  const last = weeks.at(-1);
  if (last === undefined) return null;
  const before = weeks.at(-2);
  const adjacent = before !== undefined && Date.parse(last.weekStart) - Date.parse(before.weekStart) === WEEK_MS * (before.weeks ?? 1);
  return { periodStart: last.weekStart, value: last[field], previous: adjacent ? before[field] : null };
}

/** Which clinics to look at first: gone quiet, then below their usual week, then the rest. */
export const LEVEL_ORDER: Record<UsageLevel, number> = { quiet: 0, below: 1, new: 2, above: 3, usual: 4 };

// ── The Clinics tab, as the team's weekly report has it ────────────────────

/** Where a clinic's last week stands against its norm (the four weeks before). */
export type ClinicStatus = "quiet" | "fell" | "usual" | "grew" | "new" | "idle";
export const CLINIC_STATUS_LABELS: Record<ClinicStatus, string> = {
  quiet: "Gone quiet",
  fell: "Fell",
  usual: "As usual",
  grew: "Grew",
  new: "New",
  idle: "Not using",
};
/** Under 70% of its norm is a fall, over 130% growth. */
export const FELL_BELOW = 0.7;
export const GREW_ABOVE = 1.3;
/** A regular clinic pays and worked in at least 3 of the last 5 weeks. */
export const REGULAR_OF = { worked: 3, weeks: 5 } as const;
export const NORM_WEEKS = 4;

export type ModuleUse = { id: KzModuleId; label: string; now: number; previous: number };

export type ClinicLine = {
  plan: "paid" | "trial" | null;
  status: ClinicStatus;
  regular: boolean;
  /** Actions, last week against the week before. */
  actions: Week | null;
  /** The four weeks before last week, averaged; null with none of them. */
  norm: number | null;
  doctors: Week | null;
  doctorsTotal: number | null;
  days: Week | null;
  lastActiveOn: string | null;
  /** The last five weeks' actions, oldest first, for the small bars. */
  last5: number[];
  /** Modules used last week or the week before, last week's busiest first. */
  modules: ModuleUse[];
  /** The biggest moves, in words: "doctors 1 → 0", "Visits 10 → 0". */
  changes: string[];
};

const field = (weeks: readonly UsageWeek[], key: "activeDays" | "doctors"): Week | null => {
  const last = weeks.at(-1);
  if (last === undefined) return null;
  const before = weeks.at(-2);
  const adjacent = before !== undefined && Date.parse(last.weekStart) - Date.parse(before.weekStart) === WEEK_MS * (before.weeks ?? 1);
  const value = last[key];
  if (value === null || value === undefined) return null;
  return { periodStart: last.weekStart, value, previous: adjacent ? (before[key] ?? null) : null };
};

export function clinicLine(weeks: readonly UsageWeek[]): ClinicLine {
  const last = weeks.at(-1);
  const actions = clinicWeek(weeks, "actions");
  const before = weeks.slice(-1 - NORM_WEEKS, -1);
  const norm = before.length === 0 ? null : before.reduce((sum, w) => sum + w.actions, 0) / before.length;
  const now = last?.actions ?? 0;
  const status: ClinicStatus =
    last === undefined
      ? "idle"
      : now === 0
        ? norm !== null && norm > 0
          ? "quiet"
          : "idle"
        : norm === null || norm === 0
          ? "new"
          : now < norm * FELL_BELOW
            ? "fell"
            : now > norm * GREW_ABOVE
              ? "grew"
              : "usual";
  const recent = weeks.slice(-REGULAR_OF.weeks);
  const regular = last?.plan === "paid" && recent.filter((w) => w.actions > 0).length >= REGULAR_OF.worked;
  const previousWeek = weeks.at(-2);
  const modules = KZ_MODULES.map((m) => ({
    id: m.id,
    label: m.label,
    now: last?.modules[m.id] ?? 0,
    previous: previousWeek?.modules[m.id] ?? 0,
  }))
    .filter((m) => m.now > 0 || m.previous > 0)
    .sort((a, b) => b.now - a.now || b.previous - a.previous);
  const doctors = clinicWeek(weeks, "doctors");
  const moves = [
    ...(doctors && doctors.previous !== null && doctors.previous !== doctors.value
      ? [{ size: Infinity, words: `doctors ${doctors.previous} → ${doctors.value}` }]
      : []),
    ...modules
      .filter((m) => m.now !== m.previous)
      .map((m) => ({ size: Math.abs(m.now - m.previous), words: `${m.label} ${m.previous} → ${m.now}` })),
  ]
    .sort((a, b) => b.size - a.size)
    .slice(0, 3)
    .map((m) => m.words);
  return {
    plan: last?.plan ?? null,
    status,
    regular,
    actions,
    norm,
    doctors,
    doctorsTotal: last?.doctorsTotal ?? null,
    days: field(weeks, "activeDays"),
    lastActiveOn: [...weeks].reverse().find((w) => w.lastActiveOn)?.lastActiveOn ?? null,
    last5: weeks.slice(-5).map((w) => w.actions),
    modules,
    changes: moves,
  };
}

/**
 * A clinic's weeks as periods of `span` weeks ending at the week of `end`
 * (the newest when null), oldest first, so the Clinics tab's rules read a
 * period as they read a week. Counts add up; doctors are the period's weekly
 * average (one doctor working four weeks is one doctor); days worked add up;
 * plan and doctors in the app are the period's last week's. Only whole periods.
 */
export function periodRows(weeks: readonly UsageWeek[], span: number, end: string | null = null): UsageWeek[] {
  const upTo = end === null ? weeks.length : weeks.findIndex((w) => w.weekStart === end) + 1;
  const kept = weeks.slice(0, Math.max(0, upTo));
  if (span <= 1) return [...kept];
  const out: UsageWeek[] = [];
  for (let stop = kept.length; stop - span >= 0; stop -= span) {
    const part = kept.slice(stop - span, stop);
    const sum = (pick: (w: UsageWeek) => number) => part.reduce((total, w) => total + pick(w), 0);
    const modules: Record<string, number> = {};
    for (const w of part) for (const [m, n] of Object.entries(w.modules)) modules[m] = (modules[m] ?? 0) + n;
    const lastOf = part.at(-1)!;
    out.unshift({
      weekStart: part[0]!.weekStart,
      checks: sum((w) => w.checks),
      actions: sum((w) => w.actions),
      doctors: Math.round((sum((w) => w.doctors) / span) * 10) / 10,
      doctorsTotal: lastOf.doctorsTotal ?? null,
      activeDays: part.every((w) => w.activeDays == null) ? null : sum((w) => w.activeDays ?? 0),
      lastActiveOn: [...part].reverse().find((w) => w.lastActiveOn)?.lastActiveOn ?? null,
      plan: lastOf.plan ?? null,
      failures: sum((w) => w.failures),
      modules,
      weeks: span,
    });
  }
  return out;
}

/** A clinic's line over a period: `clinicLine` on its periods, a regular clinic still judged by its last 5 weeks. */
export function clinicPeriodLine(weeks: readonly UsageWeek[], span: number, end: string | null = null): ClinicLine {
  const line = clinicLine(periodRows(weeks, span, end));
  if (span <= 1) return line;
  const upTo = end === null ? weeks.length : weeks.findIndex((w) => w.weekStart === end) + 1;
  return { ...line, regular: clinicLine(weeks.slice(0, Math.max(0, upTo))).regular };
}
