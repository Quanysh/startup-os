import { describe, expect, test } from "vitest";
import { appFigures, type AppInput } from "../lib/kzAppFigures";
import { appNameKey } from "../lib/kzAppLink";
import { validateSnapshots } from "../lib/snapshotRules";
import { closedWeeks, msOfDay, weekIndex } from "../lib/weeks";
import { ConnectorError } from "./errors";
import { askEverything } from "./posthogGlobexAsk";
import { COLUMNS, halves, mergeSlices, parseRows, slicesOf } from "./posthogGlobexParse";
import { KZ_APP_UTC_OFFSET_HOURS, KZ_EXPECTED_MODELS, KZ_FAILURE_WORDS, KZ_TEST_HOST_WORDS } from "../lib/features";
import { FIELD_CHECKS, QUESTIONS, offModelOf, queries } from "./posthogGlobexQueries";

// Made-up throughout: ids shaped like PostHog's, names that read as invented.
const NOW = Date.parse("2026-10-21T12:00:00Z");
const dataWeeks = closedWeeks(NOW, 12);
const weeks = dataWeeks.slice(-3);
const breakdownWeeks = dataWeeks.slice(-2);
const W = (week: string) => weekIndex(msOfDay(week));
const day = (week: string, plus = 0) => Math.floor(msOfDay(week) / 86_400_000) + plus;
const last = dataWeeks.at(-1)!;
const before = dataWeeks.at(-2)!;
const DOC_A = "0190aaaa-0000-7000-8000-00000000000a";
const DOC_B = "0190bbbb-0000-7000-8000-00000000000b";
const DOC_C = "0190cccc-0000-7000-8000-00000000000c";
const ORG = "org_SampleClinicOne";
const answer = (results: unknown[][], more = false) => ({ results, hasMore: more });
const modules = (intake = 0, search = 0) => [intake, 0, 0, search, 0, 0, 0, 0, 0, 0];

function input(over: Partial<AppInput["rows"]> = {}): AppInput {
  const empty = Object.fromEntries(QUESTIONS.map((q) => [q, []])) as unknown as AppInput["rows"];
  return { weeks, dataWeeks, breakdownWeeks, fields: FIELD_CHECKS, rows: { ...empty, ...over } };
}
const value = (out: ReturnType<typeof appFigures>, key: string, week = last) =>
  out.snapshots.find((s) => s.key === key && s.periodStart === week)?.value;

describe("the queries", () => {
  test("hold only numbers worked out here and fixed words: no email, phone or typed text is selected", () => {
    const all = Object.values(queries({ weeks, dataWeeks, breakdownWeeks, monthsFrom: "2025-10-01", now: NOW }));
    for (const q of all) {
      expect(q).not.toMatch(/phoneNumber|search_query|file_name|\$exception_values/);
      // The email only decides who is left out; the error's text is only searched for a few fixed words.
      expect(q.replaceAll("coalesce(toString(person.properties.email), '')", "")).not.toContain("email");
      // A sum over no row is null in PostHog: every sum is read as 0 then.
      expect(q.match(/sumIf\(/g)?.length ?? 0).toBe(q.match(/coalesce\(round\(sumIf\(/g)?.length ?? 0);
      const grouped = q.split("GROUP BY")[1]?.split("ORDER BY")[0] ?? "";
      expect(grouped).not.toMatch(/error|message|name/);
    }
  });

  test("this deployment's own values come from convex/lib/features.ts: the app's clock, its test hosts, its error words and models", () => {
    const q = queries({ weeks, dataWeeks, breakdownWeeks, monthsFrom: "2025-10-01", now: NOW });
    expect(q.hours).toContain(`toHour(timestamp + INTERVAL ${KZ_APP_UTC_OFFSET_HOURS} HOUR)`);
    const all = Object.values(q).join("\n");
    for (const host of KZ_TEST_HOST_WORDS) expect(all).toContain(host.replaceAll(".", String.raw`\\.`));
    for (const word of Object.values(KZ_FAILURE_WORDS).flat()) expect(all).toContain(`'${word}') > 0`);
    for (const [event, model] of Object.entries(KZ_EXPECTED_MODELS)) {
      expect(all).toContain(`(event = '${event}' AND toString(properties.model_name) != '${model}')`);
    }
  });

  test("with no model expected, no call is off the list", () => {
    expect(offModelOf({})).toBe("0");
    expect(offModelOf({ a_cost: "m-1" })).toBe("((event = 'a_cost' AND toString(properties.model_name) != 'm-1'))");
  });

  test("a value that would break out of its quotes is refused", () => {
    expect(() => offModelOf({ a_cost: "m'1" })).toThrow("is not one HogQL can quote");
  });
});

describe("parsing an answer", () => {
  test("refuses an answer cut short, a row of the wrong length or a cell that does not fit", () => {
    expect(() => parseRows(answer([[W(last), 1, 2, 3]], true), "failures", COLUMNS.failures)).toThrow("was cut short");
    expect(() => parseRows(answer([[W(last), 1, 2]]), "failures", COLUMNS.failures)).toThrow("wrong length");
    expect(() => parseRows(answer([[W(last), 1, 2, -3]]), "failures", COLUMNS.failures)).toThrow("does not fit");
    expect(() => parseRows(answer([["not a uuid", 1, 2, ...modules()]]), "doctor_days", COLUMNS.doctor_days)).toThrow(
      "does not fit",
    );
  });

  test("never quotes what came back in a refusal", () => {
    try {
      parseRows(answer([["SECRET name", 1, 2, ...modules()]]), "doctor_days", COLUMNS.doctor_days);
    } catch (error) {
      expect(String(error)).not.toContain("SECRET");
    }
  });

  test("cleans names and leaves out an event or a page of an odd shape instead of failing", () => {
    const people = parseRows(
      answer([[DOC_A, "  Sample​ ", "Doctor\n", day(last), 0, 0, ORG, 1, "<script>"]]),
      "people",
      COLUMNS.people,
    );
    expect(people[0]!.slice(1, 3)).toEqual(["Sample", "Doctor"]);
    expect(people[0]![8]).toBe("");
    expect(parseRows(answer([[W(last), "/a?b=c", 1, 1, 0, 0]]), "pages", COLUMNS.pages)[0]![1]).toBe("");
  });
});

describe("the figures", () => {
  test("a week's totals, and a measure with nothing measured is left out rather than written as 0", () => {
    const row = [W(last), 80, 500, 20, 60, 560, 1500, 100, 4, 70, 490, 10, 15, 15_637_312, 900, 0, 200, 100, 1000, 6, 14, 100, 7, 40, 10, 90, 12, 0, 0, 0, 2792, 900];
    const out = appFigures(input({ weeks: [row] }));
    expect(value(out, "checks_started")).toBe(560);
    expect(value(out, "ai_cost_total")).toBe(15.6373);
    expect(value(out, "rage_session_share")).toBe(10);
    expect(value(out, "trial_ended_per_doctor")).toBe(7.5);
    expect(value(out, "inp_p75")).toBeUndefined();
    expect(value(out, "lcp_p75")).toBe(2792);
    // From the first week seen on, a week with no row is a zero; before it, nothing.
    expect(value(out, "checks_started", weeks[0])).toBeUndefined();
  });

  test("a module's speed in whole seconds, and its AI cost only for modules that send one", () => {
    const intake = [W(last), 1, 100, 20, 5, 10, 90, 80, 17_400, 111_000, 20, 2_000_000, 100, 10, 162_000];
    const codes = [W(last), 9, 30, 4, 2, 1, 30, 0, 0, 0, 0, 0, 0, 0, 0];
    const out = appFigures(input({ modules: [intake, codes] }));
    expect(value(out, "module_p50_intake")).toBe(17);
    expect(value(out, "module_p95_intake")).toBe(111);
    expect(value(out, "module_slow_share_intake")).toBe(25);
    expect(value(out, "module_cost_per_result_intake")).toBe(0.0222);
    expect(value(out, "module_hedged_share_intake")).toBe(10);
    expect(value(out, "module_p95_codes")).toBeUndefined();
    expect(value(out, "module_ai_cost_codes")).toBeUndefined();
    expect(value(out, "module_ai_cost_search")).toBe(0);
  });

  test("failures by cause and kind, every cause written", () => {
    const out = appFigures(input({ failures: [[W(last), 1, 1, 5], [W(last), 13, 7, 2], [W(last), 1, 2, 1]] }));
    expect(value(out, "failures_gemini_timeout")).toBe(6);
    expect(value(out, "failures_other")).toBe(2);
    expect(value(out, "failures_upstream")).toBe(0);
    expect(value(out, "failures_kind_http_5xx")).toBe(1);
  });

  test("doctors: segments as the weekly report has them, a roster row by clinic, and a trial's outcome", () => {
    // A: worked every week, then stopped last week. B: new last week. C: never worked.
    const doctorDays = [
      ...dataWeeks.slice(0, -1).map((w) => [DOC_A, day(w, 1), 6, ...modules(6)]),
      [DOC_B, day(last, 0), 3, ...modules(0, 3)],
      [DOC_B, day(last, 1), 3, ...modules(0, 3)],
    ];
    const people = [
      [DOC_A, "Sample", "Doctor", day(dataWeeks[0]!), day(before, 2), 0, ORG, 2, "intake_check_initiated"],
      [DOC_B, "Made-up", "Person", day(last), 0, 0, ORG, 1, "ask_search_submitted"],
      [DOC_C, "", "", day(last, 1), 0, 0, "", 0, ""],
    ];
    const out = appFigures(input({ doctor_days: doctorDays, people }));
    expect(value(out, "doctors_stopped")).toBe(1);
    expect(value(out, "doctors_new")).toBe(1);
    expect(value(out, "new_doctors")).toBe(2);
    expect(value(out, "new_doctors_started")).toBe(1);
    expect(value(out, "doctors_never_started_recent")).toBe(1);
    // A's trial ended the week before last and nothing came after: left.
    expect(value(out, "trials_ended", before)).toBe(1);
    expect(value(out, "trials_lost", before)).toBe(1);
    const a = out.doctors.find((d) => d.doctorId === DOC_A)!;
    expect(a).toMatchObject({ org: ORG, name: "Sample Doctor", week: "stopped", actions: 0, previous: 6, trialOutcome: "left" });
    expect(a.history).toHaveLength(dataWeeks.length);
    expect(out.doctors.find((d) => d.doctorId === DOC_B)).toMatchObject({ week: "new", activeDays: 2, mainModule: "search" });
    // Never worked, so on no clinic's roster.
    expect(out.doctors.find((d) => d.doctorId === DOC_C)).toBeUndefined();
  });

  test("clinics: each one's weeks from its first, and which went silent", () => {
    const clinic = (w: string, actions: number) => [W(w), ORG, actions, actions, 0, 2, actions > 0 ? 3 : 0, actions > 0 ? day(w, 2) : 0, 1, ...modules(actions)];
    const rows = dataWeeks.slice(2, -1).map((w) => clinic(w, 10));
    const out = appFigures(input({ clinics: rows, orgs: [[ORG, "ТОО «Sample Clinic»"]] }));
    expect(value(out, "clinics_silent")).toBe(1);
    const c = out.clinics[0]!;
    expect(c).toMatchObject({ org: ORG, name: "ТОО «Sample Clinic»" });
    expect(c.weeks).toHaveLength(dataWeeks.length - 2);
    expect(c.weeks.at(-1)).toMatchObject({ actions: 0, lastActiveOn: expect.any(String) });
  });

  test("breakdowns for the weeks kept only, and AI cost by month", () => {
    const out = appFigures(
      input({
        hours: [[W(last), 3, 11, 19, 60], [W(dataWeeks[0]!), 1, 9, 5, 5]],
        pages: [[W(last), "/dashboard/forms/entries/:id", 1400, 50, 20, 30]],
        events: [[W(last), "Просмотр страницы Справочник", 10, 4]],
        fields: [[W(last), 300, 300, ...Array(14).fill(0)]],
        months: [[2026 * 12 + 8, 64_000_000, 30]],
      }),
    );
    expect(out.breakdowns.map((b) => `${b.kind}:${b.key}`)).toEqual([
      "hour:3-11",
      "page:/dashboard/forms/entries/:id",
      "event:Просмотр страницы Справочник",
      "field:intake_check_completed · check_id",
    ]);
    expect(out.snapshots.filter((s) => s.period === "month")).toEqual([
      { key: "ai_token_cost", scope: "kz_product", period: "month", periodStart: "2026-09-01", value: 64, currency: "USD" },
      { key: "ai_token_clinics", scope: "kz_product", period: "month", periodStart: "2026-09-01", value: 30 },
    ]);
  });

  test("every figure passes the registry as the Globex PostHog source's", () => {
    const out = appFigures(
      input({
        weeks: [[W(last), ...Array(31).fill(1)]],
        modules: [[W(last), 1, ...Array(13).fill(1)]],
        failures: [[W(last), 1, 1, 1]],
        months: [[2026 * 12 + 8, 1, 1]],
      }),
    );
    expect(validateSnapshots("posthog_globex", out.snapshots, undefined, { now: NOW })).toEqual([]);
  });
});

describe("linking a clinic by name", () => {
  test("quotes, capitals and the legal form do not count", () => {
    expect(appNameKey("ТОО «Sample Clinic»")).toBe(appNameKey("sample clinic"));
    expect(appNameKey("ГКП на ПХВ \"Example Hospital\"")).toBe("example hospital");
    expect(appNameKey("Sample Clinic Almaty")).not.toBe(appNameKey("Sample Clinic"));
  });
});

describe("asking a slice of weeks at a time", () => {
  test("weeks are cut Monday to Monday, and a slice is halved down to one week", () => {
    expect(slicesOf(["2026-09-28", "2026-10-05", "2026-10-12"], 2)).toEqual([
      { from: "2026-09-28", to: "2026-10-12" },
      { from: "2026-10-12", to: "2026-10-19" },
    ]);
    expect(halves({ from: "2026-09-28", to: "2026-10-12" })).toEqual([
      { from: "2026-09-28", to: "2026-10-05" },
      { from: "2026-10-05", to: "2026-10-12" },
    ]);
    expect(halves({ from: "2026-10-12", to: "2026-10-19" })).toBeNull();
  });

  test("a person seen in two slices is one row: earliest first seen, latest name and clinic", () => {
    const older = [DOC_A, "Old", "Name", 100, 120, 0, ORG, 2, "intake_check_initiated"];
    const newer = [DOC_A, "Sample", "Doctor", 140, 0, 150, "", 0, ""];
    expect(mergeSlices("people", [[older], [newer]])).toEqual([
      [DOC_A, "Sample", "Doctor", 100, 120, 150, ORG, 2, "intake_check_initiated"],
    ]);
  });

  test("a slice PostHog runs out of time on is asked again in halves, and the answers add up", async () => {
    const window = { weeks, dataWeeks, breakdownWeeks, monthsFrom: "2025-10-01", now: NOW };
    const asked: string[] = [];
    const ask = async (question: string, query: string) => {
      const from = Number(query.match(/timestamp >= toDateTime\((\d+)\)/)![1]);
      const to = Number(query.match(/timestamp < toDateTime\((\d+)\)/)![1]);
      asked.push(question);
      // The weeks question over more than one week takes too long.
      if (question === "weeks" && to - from > 7 * 86_400) throw new ConnectorError("PostHog answered 504 for weeks.");
      if (question === "weeks") return answer([[Math.floor((from - 345_600) / 604_800), ...Array(31).fill(1)]]);
      return answer([]);
    };
    const { rows } = await askEverything(window, ask);
    expect(rows.weeks.map((r) => r[0])).toEqual(weeks.map(W));
    expect(asked.filter((q) => q === "weeks").length).toBeGreaterThan(weeks.length);
  });

  test("any other failure is not retried: the run fails as it would have", async () => {
    const window = { weeks, dataWeeks, breakdownWeeks, monthsFrom: "2025-10-01", now: NOW };
    const ask = async () => {
      throw new ConnectorError("PostHog answered 403 for weeks.");
    };
    await expect(askEverything(window, ask)).rejects.toThrow("PostHog answered 403 for weeks.");
  });
});
