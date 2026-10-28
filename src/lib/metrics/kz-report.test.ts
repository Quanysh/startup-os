import { describe, expect, test } from "vitest";
import type { Tile } from "@/lib/metrics/scorecard";
import { compare, kzReport } from "./kz-report";

const tile = (key: string, values: [number, number]): Tile => ({
  key,
  scope: "kz_product",
  latest: null,
  firstPeriodStart: null,
  series: [
    { periodStart: "2026-09-28", value: values[0] },
    { periodStart: "2026-10-05", value: values[1] },
  ],
});

describe("kzReport: the overview's report, from the figures", () => {
  test("the main line compares each headline figure with the week before", () => {
    const report = kzReport([tile("checks_started", [596, 658]), tile("doctors_working", [64, 64])]);
    expect(report.headline).toEqual([
      "Checks started: 596 → 658 (+10%).",
      "Doctors with an action: 64 → 64 (about the same).",
    ]);
    expect(report.weekStart).toBe("2026-10-05");
  });

  test("record text in an error is always P0, first", () => {
    const report = kzReport([tile("failures_total", [10, 30]), tile("error_record_text", [0, 2])]);
    expect(report.broken.map((b) => [b.pri, b.title])).toEqual([
      ["P0", "Record text in error messages"],
      ["P1", "Failures doubled"],
    ]);
  });

  test("a cause is P1 only once it at least doubled from 3 or more", () => {
    expect(kzReport([tile("failures_gemini_timeout", [2, 5])]).broken).toEqual([]);
    expect(kzReport([tile("failures_gemini_timeout", [3, 6])]).broken.map((b) => b.title)).toEqual(["The model timed out"]);
  });

  test("clinics gone silent and doctors lost after a trial are P1; a module down 30% is watched", () => {
    const report = kzReport([
      tile("clinics_silent", [1, 2]),
      tile("trials_lost", [0, 1]),
      tile("module_actions_search", [405, 280]),
      tile("module_actions_capture", [7, 59]),
    ]);
    expect(report.broken.map((b) => b.title)).toEqual(["Clinics went silent", "Trials ending without paying"]);
    expect(report.watch.map((w) => w.text)).toEqual(["Quick search: 405 → 280 (−31%) actions."]);
    expect(report.works.map((w) => w.text)).toEqual(["Capture: 7 → 59 (+743%) actions."]);
  });

  test("no week read yet: nothing to say, and nothing made up", () => {
    expect(kzReport([])).toEqual({ weekStart: null, headline: [], broken: [], watch: [], works: [] });
  });

  test("a comparison reads as the weekly report writes it", () => {
    expect(compare({ periodStart: "x", value: 2, previous: 4 })).toBe("4 → 2 (−50%)");
    expect(compare({ periodStart: "x", value: 3, previous: null })).toBe("3");
  });
});

describe("kzReport names clinics, when it is given them", () => {
  const line = (status: string) => ({ status }) as unknown as import("./kz-clinics").ClinicLine;
  test("new clinics and the ones gone quiet, in the main line and in P1", () => {
    const report = kzReport(
      [tile("clinics_checking", [27, 19]), tile("clinics_silent", [0, 2])],
      [
        { name: "Клиника «Пример»", line: line("new") },
        { name: "Медцентр «Образец»", line: line("quiet") },
        { name: "Тест Смайл", line: line("quiet") },
      ],
    );
    expect(report.headline).toEqual([
      "New clinics: Клиника «Пример».",
      "Clinics that ran a check: 27 → 19 (−30%). Gone quiet: Медцентр «Образец» and Тест Смайл.",
    ]);
    expect(report.broken[0]?.text).toBe("2 clinics that worked before have no action last week: Медцентр «Образец» and Тест Смайл.");
  });

  test("where the growth came from, new doctors who started, and a slower, dearer module", () => {
    const report = kzReport([
      tile("checks_trial", [78, 114]),
      tile("checks_paid", [483, 538]),
      tile("new_doctors", [20, 23]),
      tile("new_doctors_started", [10, 12]),
      tile("module_p95_search", [67, 111]),
      tile("module_ai_cost_search", [6.68, 9.63]),
    ]);
    expect(report.headline).toEqual([
      "The growth came from trial: checks 78 → 114 (+46%).",
      "New doctors who started working: 12 of 23 (52%).",
    ]);
    expect(report.broken.map((b) => [b.title, b.text])).toEqual([
      ["Quick search slower and more expensive", "Slowest answers (p95) 67 → 111 s; AI cost $6.68 → $9.63."],
    ]);
  });
});

describe("kzReport over a span of weeks", () => {
  const weeks = (key: string, values: number[]): Tile => ({
    key,
    scope: "kz_product",
    latest: null,
    firstPeriodStart: null,
    series: values.map((value, i) => ({ periodStart: ["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19"][i]!, value })),
  });
  test("counts add up over the 4 weeks; doctors are a weekly average, and said so", () => {
    const report = kzReport(
      [weeks("checks_started", [10, 10, 10, 10, 20, 20, 20, 20]), weeks("doctors_working", [4, 4, 4, 4, 5, 6, 5, 6])],
      [],
      4,
    );
    expect(report.headline).toEqual([
      "Checks started: 40 → 80 (+100%).",
      "Doctors with an action, a week on average: 4 → 5.5 (+38%).",
    ]);
    expect(report.weekStart).toBe("2026-09-28");
  });
});

describe("slow answers", () => {
  test("a module whose slowest answers doubled, or crossed 120 s, is P1; a small swing is not", () => {
    const report = kzReport([
      tile("module_p95_journal", [20, 45]),
      tile("module_p95_intake", [100, 130]),
      tile("module_p95_capture", [300, 320]),
    ]);
    expect(report.broken.map((b) => [b.title, b.text])).toEqual([
      ["Intake: slow answers", "Slowest answers (p95) 100 → 130 s, past 120 s: doctors wait, and timeouts tend to follow."],
      ["Journal: slow answers", "Slowest answers (p95) 20 → 45 s: doctors wait, and timeouts tend to follow."],
    ]);
  });
});
