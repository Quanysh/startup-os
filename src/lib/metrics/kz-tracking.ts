// Product › Kazakhstan › Tracking health: whether Globex's app still sends
// what the figures are made of. Pure: the rows are `kzProduct.breakdowns`'
// ("event": a week's count and doctors of one event), nothing reads a clock.

export type BreakdownRow = { weekStart: string; key: string; values: Record<string, number> };

/**
 * Silent: nothing in the last two weeks, after a usual week of 5 or more in
 * the weeks it was sent. Dropped: last week under half its usual (the 4
 * weeks before). Rare: usually under 5 a week, so a quiet week says little.
 */
export type EventState = "silent" | "dropped" | "ok" | "rare";
export const SILENT_FROM = 5;
export const DROPPED_UNDER = 0.5;

export type EventHealth = {
  event: string;
  /** Its count each week on record, oldest first; 0 for a week it was not seen. */
  counts: number[];
  /** The 4 weeks before last week, averaged; null with none of them. */
  usual: number | null;
  users: number;
  lastSeen: string | null;
  state: EventState;
};

const ORDER: Record<EventState, number> = { silent: 0, dropped: 1, ok: 2, rare: 3 };

export function eventHealth(rows: readonly BreakdownRow[]): { weeks: string[]; rows: EventHealth[] } {
  const weeks = [...new Set(rows.map((r) => r.weekStart))].sort();
  const byEvent = new Map<string, Map<string, BreakdownRow["values"]>>();
  for (const r of rows) {
    const map = byEvent.get(r.key) ?? new Map();
    map.set(r.weekStart, r.values);
    byEvent.set(r.key, map);
  }
  const out = [...byEvent].map(([event, byWeek]): EventHealth => {
    const counts = weeks.map((w) => byWeek.get(w)?.count ?? 0);
    const before = counts.slice(-5, -1);
    const usualFrom = (span: number[]) => (span.length === 0 ? null : span.reduce((t, n) => t + n, 0) / span.length);
    const usual = usualFrom(before);
    // Silence is judged against the weeks it was alive in, before the last
    // two: an event gone quiet a month ago is still silent.
    const earlier = usualFrom(counts.slice(0, -2).filter((n) => n > 0));
    const last = counts.at(-1) ?? 0;
    const lastTwo = counts.slice(-2);
    const seen = weeks.filter((w) => (byWeek.get(w)?.count ?? 0) > 0);
    const state: EventState =
      earlier !== null && earlier >= SILENT_FROM && lastTwo.every((n) => n === 0)
        ? "silent"
        : usual !== null && usual >= SILENT_FROM && last < usual * DROPPED_UNDER
          ? "dropped"
          : usual !== null && usual < SILENT_FROM && last < SILENT_FROM
            ? "rare"
            : "ok";
    return {
      event,
      counts,
      // A silent event's usual is its week while it was sent: what went missing.
      usual: (state === "silent" ? earlier : usual) === null ? null : Math.round((state === "silent" ? earlier! : usual!) * 10) / 10,
      users: byWeek.get(weeks.at(-1) ?? "")?.users ?? 0,
      lastSeen: seen.at(-1) ?? null,
      state,
    };
  });
  out.sort((a, b) => ORDER[a.state] - ORDER[b.state] || (b.usual ?? 0) - (a.usual ?? 0));
  return { weeks, rows: out };
}

/** Each module's results and the cost events sent for them, by their event names. */
const COST_PAIRS = [
  { label: "Intake", results: "intake_check_completed", costs: "intake_check_cost" },
  { label: "Records", results: "records_check_completed", costs: "records_check_cost" },
  { label: "Quick search", results: "ask_search_completed", costs: "ask_search_cost" },
  { label: "Visits", results: "globexai_check_completed", costs: "visits_enrichment_cost" },
  { label: "Journal", results: "journal_check_completed", costs: "journal_check_cost" },
  { label: "Inquiries", results: "inquiry_generated", costs: "inquiry_cost" },
  { label: "Capture", results: "capture_completed", costs: "capture_cost" },
] as const;

/** Last week, per module: results, cost events and the share of results with a cost (null with no result). */
export function costCoverage(rows: readonly BreakdownRow[]) {
  const newest = [...new Set(rows.map((r) => r.weekStart))].sort().at(-1);
  const countOf = (event: string) => rows.find((r) => r.weekStart === newest && r.key === event)?.values.count ?? 0;
  return COST_PAIRS.map((p) => {
    const results = countOf(p.results);
    const costs = countOf(p.costs);
    return { label: p.label, results, costs, share: results === 0 ? null : Math.round((costs / results) * 100) };
  }).filter((c) => c.results > 0 || c.costs > 0);
}

/**
 * The overview's one line when tracking broke: how many events went silent
 * or dropped, in words; null while none did. Counts only: the names are on
 * Tracking health.
 */
export function trackingWarning(rows: readonly EventHealth[]): string | null {
  const silent = rows.filter((r) => r.state === "silent").length;
  const dropped = rows.filter((r) => r.state === "dropped").length;
  if (silent + dropped === 0) return null;
  const events = (n: number) => `${n} app ${n === 1 ? "event" : "events"}`;
  const what =
    silent > 0 && dropped > 0
      ? `${events(silent)} went silent and ${dropped} dropped by half or more`
      : silent > 0
        ? `${events(silent)} went silent`
        : `${events(dropped)} dropped by half or more`;
  return `${what}: figures made of ${silent + dropped === 1 ? "it" : "them"} may read low.`;
}
