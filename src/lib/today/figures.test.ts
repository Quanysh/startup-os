import { describe, expect, test } from "vitest";
import { moneyFigures, pipelineFigure, type MoneyInput } from "./figures";

const point = (periodStart: string, value: number, complete = true) => ({
  periodStart,
  value,
  complete,
  missing: [],
  rate: null,
  ratePeriodStart: null,
  parts: { us: value, kz: null },
});

const summary: MoneyInput = {
  cash: { usd: 240_000, parts: [], missing: [], rate: null, ratePeriodStart: null },
  average: { value: 60_000, months: ["2026-07-01", "2026-08-01", "2026-09-01"], expected: [] },
  runway: { kind: "months", months: 4 },
  burn: [point("2026-07-01", 55_000), point("2026-08-01", 50_000), point("2026-09-01", 75_000)],
  mrr: {
    series: [],
    trend: [point("2026-08-01", 10_000), point("2026-09-01", 11_000)],
    latest: point("2026-09-01", 11_000),
    growthPercent: 10,
    previousPeriodStart: "2026-08-01",
    growthWithheld: null,
    rate: null,
    ratePeriodStart: null,
    rateIsOld: false,
  },
} as never;

describe("the company strip: money", () => {
  test("cash with its runway, net burn against last month, MRR with its growth, each leading to Finance", () => {
    const [cash, burn, mrr] = moneyFigures(summary);
    expect(cash).toMatchObject({ label: "Cash", value: "$240K", sub: "4.0 months of runway", href: "/finance" });
    expect(burn).toMatchObject({ label: "Net burn a month", value: "$60K", change: { ratio: 0.5, better: "down", versus: "Aug" } });
    expect(mrr).toMatchObject({ label: "MRR", value: "$11K", change: { ratio: 0.1, better: "up", versus: "Aug" } });
  });

  test("a figure not known says so, and is never a zero", () => {
    const [cash, burn] = moneyFigures({ ...summary, cash: null, average: null, runway: null, burn: [], mrr: null });
    expect(cash).toMatchObject({ value: "Not known", sub: null });
    expect(burn).toMatchObject({ value: "Not known", change: null });
  });

  test("a partial balance is not given as the whole", () => {
    const [cash] = moneyFigures({ ...summary, cash: { ...summary.cash!, missing: ["kz"] } });
    expect(cash).toMatchObject({ value: "Not known", sub: "A balance is missing" });
  });

  test("with no MRR figure there is no MRR in the strip", () => {
    expect(moneyFigures({ ...summary, mrr: null }).map((f) => f.label)).toEqual(["Cash", "Net burn a month"]);
  });

  test("a runway not burning, or past ten years, in the Finance page's words", () => {
    expect(moneyFigures({ ...summary, runway: { kind: "not_burning" } })[0]!.sub).toBe("Not burning cash");
    expect(moneyFigures({ ...summary, runway: { kind: "months", months: 200 } })[0]!.sub).toBe("10+ years of runway");
  });

  test("burn needs two complete months to say a change", () => {
    const [, burn] = moneyFigures({ ...summary, burn: [point("2026-08-01", 50_000, false), point("2026-09-01", 75_000)] });
    expect(burn!.change).toBeNull();
  });
});

describe("the company strip: pipeline", () => {
  test("open deals and their monthly value, leading to Sales", () => {
    expect(pipelineFigure({ open: 4, value: 12_000, withoutAmount: 0, unsorted: 0 }, "USD")).toMatchObject({
      label: "Open pipeline",
      value: "$12K/mo",
      sub: "4 open deals",
      href: "/sales",
    });
  });

  test("no amount on any open deal is not a zero: the count is the figure, and the line says why", () => {
    expect(pipelineFigure({ open: 2, value: null, withoutAmount: 2, unsorted: 0 }, "USD")).toMatchObject({
      value: "2 deals",
      sub: "No monthly fee on any yet",
    });
    expect(pipelineFigure({ open: 1, value: null, withoutAmount: 1, unsorted: 0 }, "USD").value).toBe("1 deal");
    expect(pipelineFigure({ open: 1, value: 500, withoutAmount: 0, unsorted: 0 }, "USD").sub).toBe("1 open deal");
  });
});

describe("the company strip: what reads oddly", () => {
  test("a change past three times is said in money, not as a percentage", () => {
    const [, burn] = moneyFigures({
      ...summary,
      burn: [point("2026-08-01", 600), point("2026-09-01", 27_700)],
    });
    expect(burn!.change).toBeNull();
    expect(burn!.sub).toBe("Up from $600 in Aug");
    const [, fell] = moneyFigures({ ...summary, burn: [point("2026-08-01", 40_000), point("2026-09-01", 5_000)] });
    expect(fell!.change).toMatchObject({ ratio: -0.875 });
    expect(fell!.sub).toBeNull();
  });

  test("a short runway is flagged: under six months", () => {
    expect(moneyFigures({ ...summary, runway: { kind: "months", months: 0.3 } })[0]!.alert).toBe(true);
    expect(moneyFigures({ ...summary, runway: { kind: "months", months: 5.9 } })[0]!.alert).toBe(true);
    expect(moneyFigures({ ...summary, runway: { kind: "months", months: 12 } })[0]!.alert).toBe(false);
    expect(moneyFigures({ ...summary, runway: { kind: "months", months: 6 } })[0]!.alert).toBe(false);
    expect(moneyFigures({ ...summary, runway: { kind: "not_burning" } })[0]!.alert).toBe(false);
  });

  test("an MRR of zero says there is none yet", () => {
    const zero = { ...summary.mrr!, latest: point("2026-09-01", 0), growthPercent: null };
    expect(moneyFigures({ ...summary, mrr: zero })[2]).toMatchObject({ value: "$0", sub: "No recurring revenue yet" });
    expect(moneyFigures(summary)[2]!.sub).toBeNull();
  });
});

describe("the company strip: figures that count up", () => {
  test("a money figure carries its number and the words it ends on, which are its value", () => {
    const [cash, burn, mrr] = moneyFigures(summary);
    for (const figure of [cash!, burn!, mrr!]) {
      expect(figure.count).not.toBeNull();
      expect(figure.count!.format(figure.count!.value)).toBe(figure.value);
    }
    expect(cash!.count!.value).toBe(240_000);
  });

  test("a figure not known, or a count of deals, does not count", () => {
    const [cash] = moneyFigures({ ...summary, cash: null });
    expect(cash!.count).toBeNull();
    expect(pipelineFigure({ open: 2, value: null, withoutAmount: 2, unsorted: 0 }, "USD").count).toBeNull();
    const fees = pipelineFigure({ open: 4, value: 12_000, withoutAmount: 0, unsorted: 0 }, "USD");
    expect(fees.count!.format(fees.count!.value)).toBe("$12K/mo");
  });
});
