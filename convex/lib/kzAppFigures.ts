// Globex's app, worked out from PostHog's answers: the weekly figures the
// Kazakhstan tabs show, each clinic's weeks, each doctor's weeks and the
// breakdowns. Pure: the rows come from posthogGlobexParse, the weeks from the
// run, and nothing reads a clock.
//
// The rules are the weekly report's (doctorWeekOf, trialOutcomeOf), applied
// to the same counts. A week with no row in a full answer is a zero from the
// first week anything was seen; before it nothing is written, because there
// "nothing" means the tracking did not exist yet.

import {
  KZ_ERROR_KINDS,
  KZ_FAILURE_CAUSES,
  KZ_MODULES,
  doctorWeekOf,
  errorKindKey,
  failureKey,
  moduleKey,
  trialOutcomeOf,
  type DoctorWeek,
  type KzModuleId,
  type TrialOutcome,
} from "./kzProductDetail";
import type { SnapshotInput } from "./snapshotRules";
import { weekIndex, weekStartOfIndex } from "./weeks";

const DAY_MS = 24 * 60 * 60 * 1000;
const SCOPE = "kz_product";

/** The modules whose AI calls send a cost event: AI cost is a zero for them, unknown for the rest. */
export const COST_MODULES: readonly KzModuleId[] = [
  "intake",
  "records",
  "visits",
  "search",
  "inquiries",
  "capture",
  "journal",
];
/** The "event · property" pairs in the order the fields query counts them. */
export type FieldPair = readonly [event: string, property: string];

type Cell = number | string;
type Rows = readonly (readonly Cell[])[];
const num = (c: Cell | undefined) => (typeof c === "number" ? c : 0);
const str = (c: Cell | undefined) => (typeof c === "string" ? c : "");

export type AppInput = {
  /** The finished weeks figures are written for, oldest first. */
  weeks: readonly string[];
  /** The finished weeks read, oldest first (the weeks and the year and a month before them). */
  dataWeeks: readonly string[];
  /** The weeks breakdowns are kept for, oldest first. */
  breakdownWeeks: readonly string[];
  fields: readonly FieldPair[];
  rows: {
    weeks: Rows;
    modules: Rows;
    failures: Rows;
    clinics: Rows;
    orgs: Rows;
    doctor_days: Rows;
    people: Rows;
    hours: Rows;
    pages: Rows;
    events: Rows;
    fields: Rows;
    months: Rows;
  };
};

export type ClinicWeek = {
  weekStart: string;
  checks: number;
  actions: number;
  doctors: number;
  activeDays: number;
  lastActiveOn?: string;
  plan?: "paid" | "trial";
  failures: number;
  modules: Record<string, number>;
};
export type AppClinic = { org: string; name: string; weeks: ClinicWeek[] };

export type AppDoctor = {
  org: string;
  doctorId: string;
  name: string;
  weekStart: string;
  week: DoctorWeek;
  weekBefore?: DoctorWeek;
  actions: number;
  previous?: number;
  usual?: number;
  activeDays: number;
  lastActiveOn?: string;
  lastEvent?: string;
  mainModule?: string;
  plan?: "paid" | "trial";
  trialEndedOn?: string;
  trialOutcome?: TrialOutcome;
  actionsBeforeTrialEnd?: number;
  actionsAfterTrialEnd?: number;
  modules: Record<string, number>;
  modulesPrevious?: Record<string, number>;
  history: { weekStart: string; actions: number; days: number; modules: Record<string, number> }[];
};

export type AppBreakdown = {
  kind: "hour" | "page" | "event" | "field";
  weekStart: string;
  key: string;
  values: Record<string, number>;
};

export type AppFigures = {
  snapshots: SnapshotInput[];
  clinics: AppClinic[];
  doctors: AppDoctor[];
  breakdowns: AppBreakdown[];
};

const dayOf = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);
const weekOfDay = (day: number) => weekStartOfIndex(weekIndex(day * DAY_MS));
const planOf = (code: number): "paid" | "trial" | undefined => (code === 1 ? "paid" : code === 2 ? "trial" : undefined);
const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;
const share = (part: number, whole: number) => round((part / whole) * 100, 1);
const average = (values: readonly number[]) => (values.length === 0 ? 0 : values.reduce((t, v) => t + v, 0) / values.length);
const modulesOf = (counts: readonly number[]) => {
  const out: Record<string, number> = {};
  KZ_MODULES.forEach((m, i) => {
    const n = counts[i] ?? 0;
    if (n > 0) out[m.id] = n;
  });
  return out;
};
const addModules = (into: number[], counts: readonly number[]) => counts.forEach((n, i) => (into[i] = (into[i] ?? 0) + n));
const usualOf = (weekly: readonly number[], i: number) => average(weekly.slice(Math.max(0, i - 4), i));

export function appFigures(input: AppInput): AppFigures {
  const { rows } = input;
  const dataIndex = new Map(input.dataWeeks.map((w, i) => [w, i]));
  const lastData = input.dataWeeks.length - 1;
  const weekOfCell = (c: Cell | undefined) => weekStartOfIndex(num(c));
  const snapshots: SnapshotInput[] = [];
  const write = (key: string, week: string, value: number, money = false) =>
    snapshots.push({ key, scope: SCOPE, period: "week", periodStart: week, value, ...(money ? { currency: "USD" } : null) });

  // ── The first week anything was seen: nothing is written before it ─────────
  const seen = new Set<string>();
  for (const r of [...rows.weeks, ...rows.modules, ...rows.failures, ...rows.clinics]) seen.add(weekOfCell(r[0]));
  for (const r of rows.doctor_days) seen.add(weekOfDay(num(r[1])));
  const firstSeen = input.weeks.find((w) => seen.has(w));
  const written = firstSeen === undefined ? [] : input.weeks.filter((w) => w >= firstSeen);

  // ── The app as a whole, week by week ─────────────────────────────────────
  const totals = new Map(rows.weeks.map((r) => [weekOfCell(r[0]), r.map(num)]));
  for (const week of written) {
    const t = totals.get(week) ?? Array<number>(32).fill(0);
    const [, wau, completed, clinicsChecking, doctors, checks, actions, failures, recordText, checksTrial, checksPaid, clinicsTrial, clinicsPaid, costMicro, aiCalls, offModel, rage, rageSessions, sessions, excWeb, excServer, stale, authRedirects, uploads, uploadsFailed, trialEvents, trialPeople, inp, inpN, inpPoor, lcp, lcpN] = t as number[];
    const counts: [string, number][] = [
      ["weekly_active_users", wau!],
      ["checks_completed", completed!],
      ["clinics_checking", clinicsChecking!],
      ["doctors_working", doctors!],
      ["checks_started", checks!],
      ["actions", actions!],
      ["failures_total", failures!],
      ["error_record_text", recordText!],
      ["checks_trial", checksTrial!],
      ["checks_paid", checksPaid!],
      ["clinics_trial", clinicsTrial!],
      ["clinics_paid", clinicsPaid!],
      ["ai_calls", aiCalls!],
      ["ai_calls_off_model", offModel!],
      ["rage_clicks", rage!],
      ["exceptions_web", excWeb!],
      ["exceptions_server", excServer!],
      ["stale_session_retries", stale!],
      ["auth_redirects", authRedirects!],
      ["uploads", uploads!],
      ["uploads_failed", uploadsFailed!],
    ];
    for (const [key, value] of counts) write(key, week, value);
    write("ai_cost_total", week, round(costMicro! / 1e6, 4), true);
    if (sessions! > 0) write("rage_session_share", week, share(rageSessions!, sessions!));
    if (inpN! > 0) {
      write("inp_p75", week, inp!);
      write("inp_poor_share", week, share(inpPoor!, inpN!));
    }
    if (lcpN! > 0) write("lcp_p75", week, lcp!);
    if (trialPeople! > 0) write("trial_ended_per_doctor", week, round(trialEvents! / trialPeople!, 1));
  }

  // ── Modules ──────────────────────────────────────────────────────────────
  const moduleRows = new Map(rows.modules.map((r) => [`${weekOfCell(r[0])}:${num(r[1])}`, r.map(num)]));
  for (const week of written) {
    KZ_MODULES.forEach((m, i) => {
      const r = moduleRows.get(`${week}:${i + 1}`) ?? Array<number>(15).fill(0);
      const [, , actions, doctors, clinics, failures, results, timed, p50, p95, slow, costMicro, costEvents, hedged, tokens] = r as number[];
      write(moduleKey("actions", m.id), week, actions!);
      write(moduleKey("doctors", m.id), week, doctors!);
      write(moduleKey("clinics", m.id), week, clinics!);
      write(moduleKey("failures", m.id), week, failures!);
      if (timed! > 0) {
        write(moduleKey("p50", m.id), week, Math.round(p50! / 1000));
        write(moduleKey("p95", m.id), week, Math.round(p95! / 1000));
        write(moduleKey("slow_share", m.id), week, share(slow!, timed!));
      }
      if (COST_MODULES.includes(m.id)) {
        const cost = round(costMicro! / 1e6, 4);
        write(moduleKey("ai_cost", m.id), week, cost, true);
        if (results! > 0) write(moduleKey("cost_per_result", m.id), week, round(cost / results!, 4), true);
      }
      if (costEvents! > 0) {
        write(moduleKey("hedged_share", m.id), week, share(hedged!, costEvents!));
        write(moduleKey("tokens_p95", m.id), week, tokens!);
      }
    });
  }

  // ── Failures by cause and by kind ────────────────────────────────────────
  const causes = new Map<string, number>();
  const kinds = new Map<string, number>();
  for (const r of rows.failures) {
    const week = weekOfCell(r[0]);
    const n = num(r[3]);
    causes.set(`${week}:${num(r[1])}`, (causes.get(`${week}:${num(r[1])}`) ?? 0) + n);
    kinds.set(`${week}:${num(r[2])}`, (kinds.get(`${week}:${num(r[2])}`) ?? 0) + n);
  }
  for (const week of written) {
    KZ_FAILURE_CAUSES.forEach((c, i) => write(failureKey(c.id), week, causes.get(`${week}:${i + 1}`) ?? 0));
    KZ_ERROR_KINDS.forEach((k, i) => write(errorKindKey(k.id), week, kinds.get(`${week}:${i + 1}`) ?? 0));
  }

  // ── Hours: the busiest hours of each week, and the heat map ───────────────
  const breakdowns: AppBreakdown[] = [];
  const keepBreakdown = new Set(input.breakdownWeeks);
  const hourStats = new Map<string, { busy: number; worst: number }>();
  for (const r of rows.hours) {
    const week = weekOfCell(r[0]);
    const failures = num(r[3]);
    const stats = hourStats.get(week) ?? { busy: 0, worst: 0 };
    if (failures >= 5) stats.busy += 1;
    stats.worst = Math.max(stats.worst, failures);
    hourStats.set(week, stats);
    if (keepBreakdown.has(week) && (failures > 0 || num(r[4]) > 0)) {
      breakdowns.push({ kind: "hour", weekStart: week, key: `${num(r[1])}-${num(r[2])}`, values: { failures, actions: num(r[4]) } });
    }
  }
  for (const week of written) {
    write("failure_hours_busy", week, hourStats.get(week)?.busy ?? 0);
    write("failure_worst_hour", week, hourStats.get(week)?.worst ?? 0);
  }

  // ── Pages, events and empty fields, for the weeks kept ────────────────────
  for (const r of rows.pages) {
    const week = weekOfCell(r[0]);
    const page = str(r[1]);
    const [inp, inpN, poor, rage] = [num(r[2]), num(r[3]), num(r[4]), num(r[5])];
    if (!keepBreakdown.has(week) || page === "" || (inpN === 0 && rage === 0)) continue;
    breakdowns.push({
      kind: "page",
      weekStart: week,
      key: page,
      values: inpN > 0 ? { inp_p75: inp, inp_poor: Math.round((poor / inpN) * 100), rage } : { rage },
    });
  }
  for (const r of rows.events) {
    const week = weekOfCell(r[0]);
    const event = str(r[1]);
    if (!keepBreakdown.has(week) || event === "") continue;
    breakdowns.push({ kind: "event", weekStart: week, key: event, values: { count: num(r[2]), users: num(r[3]) } });
  }
  for (const r of rows.fields) {
    const week = weekOfCell(r[0]);
    if (!keepBreakdown.has(week)) continue;
    input.fields.forEach(([event, property], i) => {
      const total = num(r[1 + i * 2]);
      if (total > 0) {
        breakdowns.push({ kind: "field", weekStart: week, key: `${event} · ${property}`, values: { total, missing: num(r[2 + i * 2]) } });
      }
    });
  }

  // ── Clinics: their weeks, and which went silent, fell or are new ──────────
  const orgNames = new Map(rows.orgs.map((r) => [str(r[0]), str(r[1])]));
  const byOrg = new Map<string, Map<number, readonly Cell[]>>();
  for (const r of rows.clinics) {
    const i = dataIndex.get(weekOfCell(r[0]));
    const org = str(r[1]);
    if (i === undefined || org === "") continue;
    const map = byOrg.get(org) ?? new Map();
    map.set(i, r);
    byOrg.set(org, map);
  }
  const clinics: AppClinic[] = [];
  const clinicChanges = new Map<string, { silent: number; declining: number; fresh: number }>();
  for (const [org, weeks] of byOrg) {
    const first = Math.min(...weeks.keys());
    const actionsAt = input.dataWeeks.map((_, i) => num(weeks.get(i)?.[2]));
    const out: ClinicWeek[] = [];
    let lastDay = 0;
    for (let i = first; i <= lastData; i += 1) {
      const r = weeks.get(i);
      lastDay = Math.max(lastDay, num(r?.[7]));
      out.push({
        weekStart: input.dataWeeks[i]!,
        actions: num(r?.[2]),
        checks: num(r?.[3]),
        failures: num(r?.[4]),
        doctors: num(r?.[5]),
        activeDays: num(r?.[6]),
        ...(lastDay > 0 ? { lastActiveOn: dayOf(lastDay) } : null),
        ...(planOf(num(r?.[8])) ? { plan: planOf(num(r?.[8])) } : null),
        modules: modulesOf((r ?? []).slice(9, 19).map(num)),
      });
    }
    clinics.push({ org, name: orgNames.get(org) ?? "", weeks: out.slice(-53) });
    for (const week of written) {
      const i = dataIndex.get(week);
      if (i === undefined) continue;
      const c = clinicChanges.get(week) ?? { silent: 0, declining: 0, fresh: 0 };
      const now = actionsAt[i]!;
      const usual = usualOf(actionsAt, i);
      if (i === first && now > 0) c.fresh += 1;
      else if (i > first && now === 0 && (usual >= 1 || (actionsAt[i - 1] ?? 0) > 0)) c.silent += 1;
      else if (now > 0 && usual >= 3 && now < 0.7 * usual) c.declining += 1;
      clinicChanges.set(week, c);
    }
  }
  for (const week of written) {
    const c = clinicChanges.get(week) ?? { silent: 0, declining: 0, fresh: 0 };
    write("clinics_silent", week, c.silent);
    write("clinics_declining", week, c.declining);
    write("clinics_new", week, c.fresh);
  }

  // ── Doctors: their days, weeks, segments and trials ──────────────────────
  type Days = { day: number; actions: number; modules: number[] }[];
  const daysOf = new Map<string, Days>();
  for (const r of rows.doctor_days) {
    const doctor = str(r[0]);
    if (doctor === "") continue;
    const list = daysOf.get(doctor) ?? [];
    list.push({ day: num(r[1]), actions: num(r[2]), modules: r.slice(3, 13).map(num) });
    daysOf.set(doctor, list);
  }
  type Person = { doctor: string; name: string; firstSeen: number; trialEnd: number; subscribed: number; org: string; plan: number; lastEvent: string };
  const people: Person[] = rows.people
    .map((r) => ({
      doctor: str(r[0]),
      name: [str(r[1]), str(r[2])].filter((s) => s !== "").join(" "),
      firstSeen: num(r[3]),
      trialEnd: num(r[4]),
      subscribed: num(r[5]),
      org: str(r[6]),
      plan: num(r[7]),
      lastEvent: str(r[8]),
    }))
    .filter((p) => p.doctor !== "");
  const personOf = new Map(people.map((p) => [p.doctor, p]));
  // Everyone with a day of work, and everyone signed in, once each.
  const everyone = [...new Set([...daysOf.keys(), ...people.map((p) => p.doctor)])];

  const segments = new Map<string, Record<string, number>>();
  const trials = new Map<string, Record<TrialOutcome | "ended", number>>();
  const signups = new Map<string, { signed: number; started: number; recentNever: number; never: number }>();
  const writtenIndex = written.map((w) => [w, dataIndex.get(w)] as const).filter((e): e is readonly [string, number] => e[1] !== undefined);
  const doctors: AppDoctor[] = [];

  for (const doctor of everyone) {
    const days = (daysOf.get(doctor) ?? []).sort((a, b) => a.day - b.day);
    const person = personOf.get(doctor);
    const weekly = input.dataWeeks.map(() => ({ actions: 0, days: 0, modules: Array<number>(10).fill(0) }));
    for (const d of days) {
      const i = dataIndex.get(weekOfDay(d.day));
      if (i === undefined) continue;
      weekly[i]!.actions += d.actions;
      weekly[i]!.days += d.actions > 0 ? 1 : 0;
      addModules(weekly[i]!.modules, d.modules);
    }
    const actionsAt = weekly.map((w) => w.actions);
    const firstAction = actionsAt.findIndex((n) => n > 0);
    const firstActionDay = days.find((d) => d.actions > 0)?.day ?? null;
    const lastActionDay = days.filter((d) => d.actions > 0).at(-1)?.day ?? null;
    const segmentAt = (i: number): DoctorWeek =>
      doctorWeekOf({
        actions: actionsAt[i]!,
        usual: usualOf(actionsAt, i),
        days: weekly[i]!.days,
        firstWeek: i === firstAction,
        lastWeek: i > 0 ? actionsAt[i - 1]! : null,
      });

    if (firstAction >= 0) {
      for (const [week, i] of writtenIndex) {
        if (i < firstAction) continue;
        const counts = segments.get(week) ?? {};
        const s = segmentAt(i);
        counts[s] = (counts[s] ?? 0) + 1;
        segments.set(week, counts);
      }
    }

    // Signed up: the first day they were seen signed in.
    if (person !== undefined && person.firstSeen > 0) {
      for (const [week] of writtenIndex) {
        const end = Math.floor((Date.parse(`${week}T00:00:00Z`) + 7 * DAY_MS) / DAY_MS);
        const s = signups.get(week) ?? { signed: 0, started: 0, recentNever: 0, never: 0 };
        const startedBy = firstActionDay !== null && firstActionDay < end;
        if (weekOfDay(person.firstSeen) === week) {
          s.signed += 1;
          if (firstActionDay !== null && weekOfDay(firstActionDay) === week) s.started += 1;
        }
        if (person.firstSeen < end && person.firstSeen >= end - 21 && !startedBy) s.recentNever += 1;
        if (person.firstSeen < end && person.firstSeen >= end - 90 && !startedBy) s.never += 1;
        signups.set(week, s);
      }
    }

    // A trial ends once: `trial_ended` is sent at every status check, so its first day counts.
    let trial: { endedOn: string; outcome: TrialOutcome; before: number; after: number } | null = null;
    if (person !== undefined && person.trialEnd > 0) {
      const before = days.filter((d) => d.day < person.trialEnd && d.day >= person.trialEnd - 14).reduce((t, d) => t + d.actions, 0);
      const after = days.filter((d) => d.day > person.trialEnd).reduce((t, d) => t + d.actions, 0);
      const endedOn = dayOf(person.trialEnd);
      const outcome = trialOutcomeOf({
        paid: person.subscribed > 0 && person.subscribed >= person.trialEnd,
        lastActiveOn: lastActionDay === null ? null : dayOf(lastActionDay),
        endedOn,
        before,
        after,
      });
      trial = { endedOn, outcome, before, after };
      const week = weekOfDay(person.trialEnd);
      if (written.includes(week)) {
        const t = trials.get(week) ?? { ended: 0, paid: 0, kept: 0, left: 0, never: 0 };
        t.ended += 1;
        t[outcome] += 1;
        trials.set(week, t);
      }
    }

    // The doctor's row, for a clinic: only someone who worked, at the clinic of their latest action.
    const org = person?.org ?? "";
    if (firstAction < 0 || org === "") continue;
    const i = lastData;
    const recent = Array<number>(10).fill(0);
    for (let k = Math.max(0, i - 4); k <= i; k += 1) addModules(recent, weekly[k]!.modules);
    const top = recent.indexOf(Math.max(...recent));
    const history = weekly
      .map((w, k) => ({ weekStart: input.dataWeeks[k]!, actions: w.actions, days: w.days, modules: modulesOf(w.modules) }))
      .slice(firstAction)
      .slice(-53);
    doctors.push({
      org,
      doctorId: doctor,
      name: person?.name || "Unnamed doctor",
      weekStart: input.dataWeeks[i]!,
      week: segmentAt(i),
      ...(i - 1 >= firstAction ? { weekBefore: segmentAt(i - 1) } : null),
      actions: actionsAt[i]!,
      ...(i > 0 ? { previous: actionsAt[i - 1]! } : null),
      usual: round(usualOf(actionsAt, i), 1),
      activeDays: weekly[i]!.days,
      ...(lastActionDay !== null ? { lastActiveOn: dayOf(lastActionDay) } : null),
      ...(person && person.lastEvent !== "" ? { lastEvent: person.lastEvent } : null),
      ...(recent[top]! > 0 ? { mainModule: KZ_MODULES[top]!.id } : null),
      ...(planOf(person?.plan ?? 0) ? { plan: planOf(person?.plan ?? 0) } : null),
      ...(trial
        ? { trialEndedOn: trial.endedOn, trialOutcome: trial.outcome, actionsBeforeTrialEnd: trial.before, actionsAfterTrialEnd: trial.after }
        : null),
      modules: modulesOf(weekly[i]!.modules),
      ...(i > 0 ? { modulesPrevious: modulesOf(weekly[i - 1]!.modules) } : null),
      history,
    });
  }

  for (const week of written) {
    const s = segments.get(week) ?? {};
    write("doctors_daily", week, s.daily ?? 0);
    write("doctors_new", week, s.new ?? 0);
    write("doctors_more", week, s.more ?? 0);
    write("doctors_less", week, s.less ?? 0);
    write("doctors_stopped", week, s.stopped ?? 0);
    const u = signups.get(week) ?? { signed: 0, started: 0, recentNever: 0, never: 0 };
    write("doctors_never_started", week, u.never);
    write("new_doctors", week, u.signed);
    write("new_doctors_started", week, u.started);
    write("doctors_never_started_recent", week, u.recentNever);
    const t = trials.get(week) ?? { ended: 0, paid: 0, kept: 0, left: 0, never: 0 };
    write("trials_ended", week, t.ended);
    write("trials_converted", week, t.paid);
    write("trials_continuing", week, t.kept);
    write("trials_lost", week, t.left + t.never);
  }

  // ── AI cost by month ──────────────────────────────────────────────────────
  for (const r of rows.months) {
    const index = num(r[0]);
    const month = `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-01`;
    snapshots.push({ key: "ai_token_cost", scope: SCOPE, period: "month", periodStart: month, value: round(num(r[1]) / 1e6, 4), currency: "USD" });
    snapshots.push({ key: "ai_token_clinics", scope: SCOPE, period: "month", periodStart: month, value: num(r[2]) });
  }

  return { snapshots, clinics, doctors, breakdowns };
}
