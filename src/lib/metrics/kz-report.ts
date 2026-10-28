// Product › Kazakhstan's report, as the team's weekly report has it: the main
// line, what to fix first (P0 and P1), what to watch and what works. In the weekly
// report a model writes these; here they are worked out from the figures by
// the same rules, so every sentence is a count the page already shows. Pure:
// no clock, and no name (clinics and doctors are on their own tabs).

import { KZ_FAILURE_CAUSES, KZ_MODULES, failureKey, moduleKey } from "@convex/lib/kzProductDetail";
import type { Tile } from "@/lib/metrics/scorecard";
import type { ClinicLine } from "./kz-clinics";
import { SLOW_SECONDS, changeOf, kzHref, spanOf, type KzView, type Span, type Week } from "./kz-detail";

export type Priority = "P0" | "P1";
export type ReportItem = { text: string; href: string | null };
export type Broken = ReportItem & { pri: Priority; title: string };
export type Report = {
  /** The newest week the report is about; null before any week is read. */
  weekStart: string | null;
  headline: string[];
  broken: Broken[];
  watch: ReportItem[];
  works: ReportItem[];
};

const count = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;
/** "596 → 658 (+10%)", the way every comparison in the report is written. */
export function compare(week: Week): string {
  if (week.previous === null) return count(week.value);
  const change = changeOf(week, "up");
  const words = change === null || change.tone === "flat" ? "about the same" : change.words;
  return `${count(week.previous)} → ${count(week.value)} (${words})`;
}


/** A failure count that at least doubled against the week before (from 3 up). */
export const doubled = (week: Week) => week.previous !== null && week.value >= 2 * Math.max(week.previous, 3);

/** A clinic as the report may name it: only for a viewer sent its name (the Customers page). */
export type NamedClinic = { name: string; line: ClinicLine };

/** "A", "A and B", "A, B and C". */
const listOf = (names: readonly string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
const percent = (part: number, whole: number) => (whole === 0 ? "" : ` (${Math.round((part / whole) * 100)}%)`);
const dollars = (v: number) => `$${v.toFixed(2)}`;

export function kzReport(
  tiles: readonly Tile[],
  clinics: readonly NamedClinic[] = [],
  span: Span = 1,
  end: string | null = null,
): Report {
  const week = (key: string) => spanOf(tiles, key, span, end);
  // Doctors and clinics are judged week by week (against their own usual
  // week), so those lines read last week whatever the span.
  const lastWeekOf = (key: string) => spanOf(tiles, key, 1, end);
  const href = (view: KzView["view"]) => kzHref({ view, module: null }, span, end);
  const checks = week("checks_started");
  const doctors = week("doctors_working");
  const clinicsWeek = week("clinics_checking");
  const failures = week("failures_total");
  const weekStart = checks?.periodStart ?? doctors?.periodStart ?? null;

  const named = (status: ClinicLine["status"]) => clinics.filter((c) => c.line.status === status).map((c) => c.name);
  const headline: string[] = [];
  if (checks) headline.push(`Checks started: ${compare(checks)}.`);
  const average = span === 1 ? "" : ", a week on average";
  if (doctors) headline.push(`Doctors with an action${average}: ${compare(doctors)}.`);
  // Where the growth came from: trial or paying doctors, whichever moved more.
  const trialChecks = week("checks_trial");
  const paidChecks = week("checks_paid");
  if (trialChecks?.previous != null && paidChecks?.previous != null) {
    // By how much each grew against itself, as the weekly report reads it.
    const growth = (w: Week) => (w.previous ? w.value / w.previous : w.value > 0 ? Infinity : 1);
    const [more, words] =
      growth(trialChecks) >= growth(paidChecks) ? [trialChecks, "trial"] : [paidChecks, "paying doctors"];
    if (more.previous !== null && more.value > more.previous) {
      headline.push(`The growth came from ${words}: checks ${compare(more)}.`);
    }
  }
  const fresh = named("new");
  if (fresh.length > 0) headline.push(`New clinics: ${listOf(fresh)}.`);
  if (clinicsWeek) {
    const quiet = named("quiet");
    headline.push(
      `Clinics that ran a check${average}: ${compare(clinicsWeek)}.` + (quiet.length > 0 ? ` Gone quiet${span === 1 ? "" : " last week"}: ${listOf(quiet)}.` : ""),
    );
  }
  const signed = week("new_doctors");
  const started = week("new_doctors_started");
  if (signed && started && signed.periodStart === started.periodStart && signed.value > 0) {
    headline.push(`New doctors who started working: ${count(started.value)} of ${count(signed.value)}${percent(started.value, signed.value)}.`);
  }

  const broken: Broken[] = [];
  const leaks = week("error_record_text");
  if (leaks && leaks.value > 0) {
    broken.push({
      pri: "P0",
      title: "Record text in error messages",
      text: `${plural(leaks.value, "error message", "error messages")} held a model's answer, and with it part of a medical record, which reached analytics. It must be zero.`,
      href: href("issues"),
    });
  }
  if (failures && doubled(failures)) {
    broken.push({
      pri: "P1",
      title: "Failures doubled",
      text: `Failures went ${compare(failures)}.`,
      href: href("issues"),
    });
  }
  for (const cause of KZ_FAILURE_CAUSES) {
    const w = week(failureKey(cause.id));
    if (w && doubled(w) && broken.length < 5) {
      broken.push({ pri: "P1", title: cause.label, text: `${compare(w)} failures.`, href: href("issues") });
    }
  }
  const silent = lastWeekOf("clinics_silent");
  if (silent && silent.value > 0 && broken.length < 5) {
    const quiet = named("quiet");
    broken.push({
      pri: "P1",
      title: "Clinics went silent",
      text:
        `${plural(silent.value, "clinic that worked before has", "clinics that worked before have")} no action last week` +
        (quiet.length > 0 ? `: ${listOf(quiet)}.` : "."),
      href: href("clinics"),
    });
  }
  const lost = week("trials_lost");
  if (lost && lost.value > 0 && broken.length < 5) {
    broken.push({
      pri: "P1",
      title: "Trials ending without paying",
      text: `${plural(lost.value, "doctor has", "doctors have")} done nothing since their trial ended.`,
      href: href("doctors"),
    });
  }
  // A module whose answers got slower and dearer at once: 30% or more on both.
  const slower = new Set<string>();
  for (const m of KZ_MODULES) {
    const p95 = week(moduleKey("p95", m.id));
    const cost = week(moduleKey("ai_cost", m.id));
    const up = (w: Week | null) => w !== null && w.previous !== null && w.previous > 0 && w.value >= w.previous * 1.3;
    if (up(p95) && up(cost) && broken.length < 5) {
      slower.add(m.id);
      broken.push({
        pri: "P1",
        title: `${m.label} slower and more expensive`,
        text: `Slowest answers (p95) ${p95!.previous} → ${p95!.value} s; AI cost ${dollars(cost!.previous!)} → ${dollars(cost!.value)}.`,
        href: kzHref({ view: "modules", module: m.id }, span, end),
      });
    }
  }
  // A module whose slowest answers doubled, or went past the limit it was under.
  for (const m of KZ_MODULES) {
    const p95 = week(moduleKey("p95", m.id));
    if (p95 === null || p95.previous === null || slower.has(m.id) || broken.length >= 5) continue;
    const doubledTime = p95.previous > 0 && p95.value >= 2 * p95.previous;
    const pastLimit = p95.previous < SLOW_SECONDS && p95.value >= SLOW_SECONDS;
    if (doubledTime || pastLimit) {
      broken.push({
        pri: "P1",
        title: `${m.label}: slow answers`,
        text: `Slowest answers (p95) ${p95.previous} → ${p95.value} s${pastLimit ? `, past ${SLOW_SECONDS} s` : ""}: doctors wait, and timeouts tend to follow.`,
        href: kzHref({ view: "modules", module: m.id }, span, end),
      });
    }
  }

  const watch: ReportItem[] = [];
  const less = lastWeekOf("doctors_less");
  if (less && less.value > 0) watch.push({ text: `${plural(less.value, "doctor", "doctors")} worked half their usual week or less.`, href: href("doctors") });
  const stopped = lastWeekOf("doctors_stopped");
  if (stopped && stopped.value > 0) watch.push({ text: `${plural(stopped.value, "doctor", "doctors")} worked the week before and not last week.`, href: href("doctors") });
  const declining = lastWeekOf("clinics_declining");
  if (declining && declining.value > 0) {
    const fell = named("fell");
    watch.push({
      text: `${plural(declining.value, "clinic is", "clinics are")} under 70% of their usual week${fell.length > 0 ? `: ${listOf(fell)}` : ""}.`,
      href: href("clinics"),
    });
  }
  const works: ReportItem[] = [];
  for (const m of KZ_MODULES) {
    const w = week(moduleKey("actions", m.id));
    if (w === null || w.previous === null || Math.max(w.previous, w.value) < 20) continue;
    const ratio = w.value / Math.max(w.previous, 1);
    const item = { text: `${m.label}: ${compare(w)} actions.`, href: kzHref({ view: "modules", module: m.id }, span, end) };
    if (ratio <= 0.7 && watch.length < 6) watch.push(item);
    if (ratio >= 1.2 && works.length < 4) works.push(item);
  }
  const daily = lastWeekOf("doctors_daily");
  if (daily && daily.previous !== null && daily.value > daily.previous && works.length < 4) {
    works.push({ text: `${compare(daily)} doctors worked most days of the week.`, href: href("doctors") });
  }
  const paid = week("trials_converted");
  if (paid && paid.value > 0 && works.length < 4) {
    works.push({ text: `${plural(paid.value, "doctor", "doctors")} paid after their trial.`, href: href("doctors") });
  }

  return { weekStart, headline, broken, watch: watch.slice(0, 6), works: works.slice(0, 4) };
}
