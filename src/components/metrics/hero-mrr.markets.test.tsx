// @vitest-environment jsdom
// The headline MRR in one company's view: that company's figure, and no
// sentence about the other. The both-markets wording is in hero-mrr.test.tsx.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getMetric } from "@convex/lib/metricRegistry";
import { CompanyProvider } from "@/components/company-provider";
import { supplyOf, type Tile } from "@/lib/metrics/scorecard";
import { HeroMrr } from "./hero-mrr";

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

const series = (key: string, scope: string, points: [string, number][]): Tile => ({
  key,
  scope,
  latest: null,
  firstPeriodStart: points[0]?.[0] ?? null,
  series: points.map(([periodStart, value]) => ({ periodStart, value })),
});
// The US is entered for October; Kazakhstan's workbook stops at September.
const both = [
  series("mrr", "us", [["2026-09-01", 5_000], ["2026-10-01", 5_500]]),
  series("mrr", "kz", [["2026-08-01", 4_400_000], ["2026-09-01", 4_840_000]]),
  series("fx_usd_kzt", "company", [["2026-08-01", 440]]),
];
const hero = () => screen.getByRole("region", { name: /Monthly recurring revenue/ }).textContent ?? "";
const KZ_WORDS = /Kazakhstan|KZT|₸|CFO workbook|every market/;
const US_WORDS = /\bUS\b|every market/;

describe("HeroMrr for the US alone", () => {
  test("the US figure with its growth: Kazakhstan's missing October is not its concern", () => {
    render(<HeroMrr tiles={both} markets={["us"]} />);
    expect(screen.getByText("$5,500")).toBeTruthy();
    expect(screen.queryByText("partial")).toBeNull();
    expect(screen.getByText(/10(\.0)?%/)).toBeTruthy();
    expect(hero()).not.toMatch(KZ_WORDS);
  });

  test("with no figure, it asks for this month's and says nothing of the workbook", () => {
    render(<HeroMrr tiles={both.filter((t) => t.scope !== "us")} markets={["us"]} />);
    expect(screen.getByText("No value yet")).toBeTruthy();
    expect(
      screen.getByText(
        "MRR is the primary metric this scorecard is built around. Enter this month's figure to start the trend.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Add MRR" }).getAttribute("href")).toBe(
      "/finance?metric=mrr&scope=us#record-a-figure",
    );
    expect(hero()).not.toMatch(KZ_WORDS);
  });

  test("its first month is a first month, not 'the first with every market in it'", () => {
    render(
      <HeroMrr tiles={[series("mrr", "us", [["2026-10-01", 5_500]]), ...both.slice(1)]} markets={["us"]} />,
    );
    expect(
      screen.getByText("Growth appears next month, once there are two months to compare."),
    ).toBeTruthy();
    expect(hero()).not.toMatch(KZ_WORDS);
  });
});

describe("HeroMrr for Kazakhstan alone", () => {
  test("Kazakhstan's figure converted, with its growth, and the US's October ignored", () => {
    render(<HeroMrr tiles={both} markets={["kz"]} />);
    // 4,840,000 at 440.
    expect(screen.getByText("$11K")).toBeTruthy();
    expect(screen.getByText("Sep 2026")).toBeTruthy();
    expect(screen.queryByText("partial")).toBeNull();
    expect(screen.getByText(/10(\.0)?%/)).toBeTruthy();
    expect(screen.getByText(/per \$1, the Aug 2026 rate\./).textContent).toBe(
      "Converted at ₸440 per $1, the Aug 2026 rate.",
    );
    expect(hero()).not.toMatch(US_WORDS);
  });

  test("with no figure, it says where the figure comes from and offers no US form", () => {
    render(<HeroMrr tiles={both.filter((t) => t.scope === "us")} markets={["kz"]} />);
    expect(screen.getByText("No value yet")).toBeTruthy();
    expect(
      screen.getByText(
        "MRR is the primary metric this scorecard is built around. It arrives with the CFO workbook.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(hero()).not.toMatch(US_WORDS);
    // The copy above is only true while this holds; if ownership changes, this fails first.
    expect(supplyOf(getMetric("mrr")!, "kz").how).toBe("source");
  });

  test("with no rate there is no dollar figure, and nothing is 'left out' of a total", () => {
    render(<HeroMrr tiles={both.filter((t) => t.key !== "fx_usd_kzt")} markets={["kz"]} />);
    expect(screen.getByText("partial")).toBeTruthy();
    expect(
      screen.getByText(
        "There is no dollar figure until a USD/KZT rate arrives with the CFO workbook.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/left out/)).toBeNull();
    expect(hero()).not.toMatch(US_WORDS);
  });
});

describe("HeroMrr follows the company chosen in the sidebar", () => {
  test("with no company chosen it is both markets, as before", () => {
    render(<HeroMrr tiles={both} />);
    expect(screen.getByText("partial")).toBeTruthy();
    expect(screen.getByText(/Kazakhstan has no MRR figure for Oct 2026 yet\./)).toBeTruthy();
  });

  test.each([
    ["us", "$5,500", KZ_WORDS],
    ["kz", "$11K", US_WORDS],
  ])("%s: its own figure, even when handed every tile", (company, value, never) => {
    window.localStorage.setItem("startup-os:company", company);
    render(
      <CompanyProvider>
        <HeroMrr tiles={both} />
      </CompanyProvider>,
    );
    expect(screen.getByText(value)).toBeTruthy();
    expect(screen.queryByText("partial")).toBeNull();
    expect(hero()).not.toMatch(never);
  });
});
