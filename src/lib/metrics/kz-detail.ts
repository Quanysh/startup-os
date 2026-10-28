// Product › Kazakhstan in detail: which view is open (in the address), and a
// figure's last finished week against the one before. Pure: the tiles are the
// scorecard's, and nothing here reads a clock.

import { KZ_MODULES, moduleKey, type KzModuleId } from "@convex/lib/kzProductDetail";
import type { Point } from "@/lib/metrics/derive";
import type { Tile } from "@/lib/metrics/scorecard";

export const KZ_VIEWS = [
  { id: "overview", label: "Overview" },
  { id: "modules", label: "Modules" },
  { id: "clinics", label: "Clinics" },
  { id: "doctors", label: "Doctors" },
  { id: "speed", label: "Speed & AI" },
  { id: "issues", label: "Errors" },
  { id: "tracking", label: "Tracking health" },
] as const;
export type KzViewId = (typeof KZ_VIEWS)[number]["id"];

export type KzView = { view: KzViewId; module: KzModuleId | null };

type Params = { get(name: string): string | null };

/** The view a URL asks for. Anything it does not recognise is the overview. */
export function readKzView(params: Params): KzView {
  const view = params.get("view") ?? "";
  const asked = params.get("module") ?? "";
  const known = KZ_VIEWS.find((v) => v.id === view)?.id ?? "overview";
  return {
    view: known,
    // A module narrows the modules view (its page) and the clinics view (its clinics).
    module:
      known === "modules" || known === "clinics" ? (KZ_MODULES.find((m) => m.id === asked)?.id ?? null) : null,
  };
}

/** The address of a view: the product, then only what differs from the overview, and the span picked. */
export function kzHref({ view, module }: KzView, span: number = 1, end: string | null = null): string {
  const params = new URLSearchParams({ product: "kz_product" });
  if (view !== "overview") params.set("view", view);
  if ((view === "modules" || view === "clinics") && module !== null) params.set("module", module);
  if (span !== 1) params.set("weeks", String(span));
  if (end !== null) params.set("end", end);
  return `/product?${params.toString()}`;
}

/** A Kazakhstan clinic's own page, with the period picked: its id in the address, never its name. */
export function kzClinicHref(id: string, span: number = 1, end: string | null = null): string {
  const params = new URLSearchParams();
  if (span !== 1) params.set("weeks", String(span));
  if (end !== null) params.set("end", end);
  const query = params.toString();
  return `/product/kz/clinics/${encodeURIComponent(id)}${query === "" ? "" : `?${query}`}`;
}

/** The newest week on record and the one before it, if it is the week before. */
export type Week = {
  periodStart: string;
  value: number;
  previous: number | null;
  /** Weeks it covers, from `periodStart`; one when absent. */
  weeks?: number;
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function lastWeek(series: readonly Point[]): Week | null {
  const last = series.at(-1);
  if (!last) return null;
  const before = series.at(-2);
  const adjacent =
    before !== undefined && Date.parse(last.periodStart) - Date.parse(before.periodStart) === WEEK_MS;
  return { periodStart: last.periodStart, value: last.value, previous: adjacent ? before.value : null };
}

// ── A span of weeks ────────────────────────────────────────────────────────

/**
 * The periods a viewer may pick, in whole Monday-to-Sunday weeks: last week,
 * the last 2 or 4, or a custom period (two dates, rounded to the whole weeks
 * they fall in, up to a year; kept as the last Monday and the number of weeks).
 * Days and calendar months are not offered: the figures are stored by week.
 */
export const SPANS = [1, 2, 4] as const;
export type Span = number;
export const SPAN_LABELS: Record<(typeof SPANS)[number], string> = {
  1: "Last week (Mon–Sun)",
  2: "Last 2 weeks",
  4: "Last 4 weeks",
};
/** The most weeks a period may hold: the year of history Product › Kazakhstan reads. */
export const MAX_SPAN = 53;
/** The weeks a chart shows: a quarter, so its bars stay readable. */
export const CHART_WEEKS = 13;
export type Period = { weeks: Span; end: string | null };
export function readPeriod(params: Params): Period {
  const asked = Math.trunc(Number(params.get("weeks")));
  const weeks = asked >= 1 && asked <= MAX_SPAN ? asked : 1;
  const end = params.get("end");
  return { weeks, end: end !== null && /^\d{4}-\d{2}-\d{2}$/.test(end) ? end : null };
}
/** @deprecated read the whole period with `readPeriod`. */
export const readSpan = (params: Params): Span => readPeriod(params).weeks;

/**
 * Whether a figure adds up over weeks. A count of events does (checks,
 * failures, dollars); a count of people or clinics does not, since one
 * doctor working three weeks is one doctor, so over a span it is the weekly
 * average. Slowest answers are averaged too.
 */
const AVERAGED =
  /^(weekly_active_users|doctors_|clinics_|module_(doctors|clinics|p95)_)/;
export const addsUp = (key: string) => !AVERAGED.test(key);

/**
 * A figure over the last `span` weeks against the same span just before, as
 * one `Week` dated by the span's first Monday. Null when the span is not all on
 * record; `previous` null when the span before is not. A span of 1 is `lastWeek`.
 */
export function spanWeek(series: readonly Point[], span: Span, sum: boolean, end: string | null = null): Week | null {
  if (end !== null) {
    // A custom period ends at the week of `end`: the series up to it.
    const at = series.findIndex((p) => p.periodStart === end);
    if (at === -1) return null;
    series = series.slice(0, at + 1);
  }
  if (span === 1) return lastWeek(series);
  const consecutive = (points: readonly Point[]) =>
    points.every((p, i) => i === 0 || Date.parse(p.periodStart) - Date.parse(points[i - 1]!.periodStart) === WEEK_MS);
  const now = series.slice(-span);
  if (now.length < span || !consecutive(now)) return null;
  const before = series.slice(-2 * span, -span);
  const total = (points: readonly Point[]) => points.reduce((t, p) => t + p.value, 0);
  const value = (points: readonly Point[]) => (sum ? total(points) : Math.round((total(points) / points.length) * 10) / 10);
  const whole = before.length === span && consecutive([...before, ...now]);
  return { periodStart: now[0]!.periodStart, value: value(now), previous: whole ? value(before) : null, weeks: span };
}

/** A tile's figure over the span, added up or averaged as the figure allows. */
export const spanOf = (tiles: readonly Tile[], key: string, span: Span, end: string | null = null) =>
  spanWeek(seriesOf(tiles, key), span, addsUp(key), end);

/** "+12", "−3", "no change", or null when there is no week before to compare. */
export function changeWords(week: Week | null): string | null {
  if (week === null || week.previous === null) return null;
  const diff = week.value - week.previous;
  if (diff === 0) return "no change";
  return `${diff > 0 ? "+" : "−"}${Math.abs(diff).toLocaleString("en-US")}`;
}

/** A tile's series by key, in the product scope. Empty when it is not sent. */
export function seriesOf(tiles: readonly Tile[], key: string, scope = "kz_product"): Point[] {
  return tiles.find((t) => t.key === key && t.scope === scope)?.series ?? [];
}

/** A tile's series as a chart shows it: its last `CHART_WEEKS` weeks. */
export const chartSeries = (tiles: readonly Tile[], key: string, scope = "kz_product"): Point[] =>
  seriesOf(tiles, key, scope).slice(-CHART_WEEKS);

/**
 * The scorecard's tiles with Globex's weekly figures over the year
 * `history` sent, where it sent one, so a period can reach back that far.
 */
export function withHistory(
  tiles: readonly Tile[],
  history: readonly { key: string; series: Point[] }[] | undefined,
): Tile[] {
  if (history === undefined) return [...tiles];
  const longer = new Map(history.map((h) => [h.key, h.series]));
  return tiles.map((t) => (t.scope === "kz_product" && longer.has(t.key) ? { ...t, series: longer.get(t.key)! } : t));
}

/** How a figure moved from the week before, and whether that is good news. */
export type Change = { words: string; tone: "good" | "bad" | "flat" | "new" };

/** Under this a move is "about the same": a percent of the figure, or points of a rate. */
export const FLAT_PERCENT = 5;
export const FLAT_POINTS = 1;
/** Answer times swing a lot from week to week on a few dozen answers: only a fifth or more counts. */
export const FLAT_SECONDS_PERCENT = 20;
/** A module's slowest answers (p95) past this many seconds is slow, whatever it was before. */
export const SLOW_SECONDS = 120;

/**
 * The move as the page's chips say it: "+12%" (or "+6 pp" for a rate),
 * "same" when it is small (the chip wears ≈), "new" from nothing. Null with
 * no week before.
 */
export function changeOf(
  week: Week | null,
  better: "up" | "down" | "none",
  kind: "relative" | "points" = "relative",
  /** Under this percent a move reads "same": 5 unless a figure is noisier (answer times: 20). */
  flat: number = FLAT_PERCENT,
): Change | null {
  if (week === null || week.previous === null) return null;
  const { value, previous } = week;
  // "none": a figure that is neither good nor bad news when it moves (trials ended).
  const tone = (diff: number): Change["tone"] =>
    better === "none" ? "flat" : (diff > 0) === (better === "up") ? "good" : "bad";
  if (kind === "points") {
    const diff = value - previous;
    if (Math.abs(diff) < FLAT_POINTS) return { words: "same", tone: "flat" };
    return { words: `${diff > 0 ? "+" : "−"}${Math.round(Math.abs(diff))} pp`, tone: tone(diff) };
  }
  if (previous === 0) return value === 0 ? { words: "same", tone: "flat" } : { words: "new", tone: "new" };
  const percent = ((value - previous) / previous) * 100;
  if (Math.abs(percent) < flat) return { words: "same", tone: "flat" };
  return { words: `${percent > 0 ? "+" : "−"}${Math.round(Math.abs(percent)).toLocaleString("en-US")}%`, tone: tone(percent) };
}

export type ModuleRow = {
  id: KzModuleId;
  label: string;
  actions: Week | null;
  doctors: Week | null;
  clinics: Week | null;
  failures: Week | null;
  /** Failures as a percent of actions, this week and the one before. */
  failureRate: Week | null;
  /** The slowest answers (95th percentile), whole seconds. */
  p95: Week | null;
  /** What its AI calls cost, US dollars. */
  aiCost: Week | null;
};

const rate = (failures: Week | null, actions: Week | null): Week | null => {
  if (failures === null || actions === null || failures.periodStart !== actions.periodStart || actions.value === 0) {
    return null;
  }
  const previous =
    failures.previous !== null && actions.previous !== null && actions.previous > 0
      ? (failures.previous / actions.previous) * 100
      : null;
  return { periodStart: actions.periodStart, value: (failures.value / actions.value) * 100, previous };
};

/** One row a module, the busiest first; a module with no figure yet last. */
export function moduleRows(tiles: readonly Tile[], span: Span = 1, end: string | null = null): ModuleRow[] {
  const rows = KZ_MODULES.map((m): ModuleRow => {
    const week = (kind: Parameters<typeof moduleKey>[0]) => spanOf(tiles, moduleKey(kind, m.id), span, end);
    const actions = week("actions");
    const failures = week("failures");
    return {
      id: m.id,
      label: m.label,
      actions,
      doctors: week("doctors"),
      clinics: week("clinics"),
      failures,
      failureRate: rate(failures, actions),
      p95: week("p95"),
      aiCost: week("ai_cost"),
    };
  });
  return rows.sort((a, b) => (b.actions?.value ?? -1) - (a.actions?.value ?? -1));
}

/** An offset from UTC in hours, as a clock is named: "UTC+5", "UTC-3", or "UTC". */
export const utcWords = (hours: number): string => (hours === 0 ? "UTC" : `UTC${hours > 0 ? "+" : ""}${hours}`);
