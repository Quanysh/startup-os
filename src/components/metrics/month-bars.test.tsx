// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test } from "vitest";
import { MonthBars, type BarRow } from "./month-bars";

afterEach(cleanup);

const SERIES = [
  { id: "in", label: "Cash in", color: "var(--chart-1)" },
  { id: "out", label: "Cash out", color: "var(--chart-2)" },
];
const ROWS: BarRow[] = [
  { periodStart: "2026-08-01", values: { in: 100_000, out: 20_000 } },
  { periodStart: "2026-09-01", values: { in: 12_000, out: null } },
];
const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
const chart = (mode: "grouped" | "stacked", rows = ROWS) =>
  render(<MonthBars title="Cash in and out" series={SERIES} rows={rows} mode={mode} format={usd} />);
const height = (el: Element) => (el as HTMLElement).style.height;

describe("MonthBars", () => {
  test("is a figure captioned with its title", () => {
    chart("grouped");
    expect(within(screen.getByRole("figure")).getByText("Cash in and out")).toBeTruthy();
  });

  test("names every series in a legend", () => {
    chart("grouped");
    const legend = screen.getByRole("list", { name: "Legend" });
    expect(within(legend).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Cash in",
      "Cash out",
    ]);
  });

  test("describes each month in words", () => {
    chart("grouped");
    expect(screen.getByLabelText("Aug 2026: Cash in $100,000, Cash out $20,000")).toBeTruthy();
  });

  test("a missing figure is named and draws no bar, rather than a zero", () => {
    chart("grouped");
    const september = screen.getByLabelText("Sep 2026: Cash in $12,000, Cash out no figure");
    expect(september.querySelectorAll("[data-series]")).toHaveLength(1);
  });

  test("grouped bars are sized against the largest value on the chart", () => {
    chart("grouped");
    const august = screen.getByLabelText(/^Aug 2026/);
    expect(height(august.querySelector('[data-series="in"]')!)).toBe("100%");
    expect(height(august.querySelector('[data-series="out"]')!)).toBe("20%");
  });

  test("stacked bars are sized against the largest month total", () => {
    chart("stacked", [
      { periodStart: "2026-08-01", values: { in: 60, out: 40 } },
      { periodStart: "2026-09-01", values: { in: 25, out: 25 } },
    ]);
    const september = screen.getByLabelText(/^Sep 2026/);
    expect(height(september.querySelector('[data-series="in"]')!)).toBe("25%");
    expect(height(september.querySelector('[data-series="out"]')!)).toBe("25%");
  });

  test("a month with a note says so and is drawn apart from the others", () => {
    chart("grouped", [
      { periodStart: "2026-09-01", values: { in: 10, out: 5 } },
      { periodStart: "2026-10-01", values: { in: 4, out: 2 }, note: "so far" },
    ]);
    const october = screen.getByLabelText("Oct 2026 (so far): Cash in $4, Cash out $2");
    expect(october.getAttribute("data-noted")).toBe("true");
    expect(screen.getByLabelText(/^Sep 2026/).getAttribute("data-noted")).toBeNull();
    expect(within(screen.getByRole("table")).getByText("Oct 2026 (so far)")).toBeTruthy();
  });

  test("focusing a month shows its figures", async () => {
    const user = userEvent.setup();
    const { container } = chart("grouped");
    expect(container.querySelector("[data-tooltip]")).toBeNull();
    await user.tab();
    const tip = container.querySelector("[data-tooltip]");
    expect(tip?.textContent).toContain("Aug 2026");
    expect(tip?.textContent).toContain("$100,000");
    expect(tip?.getAttribute("aria-hidden")).toBe("true");
  });

  test("the same numbers are available as a table", () => {
    chart("grouped");
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(rows[2]?.textContent).toContain("no figure");
  });

  test("the first month and every January carry the year", () => {
    const thirteen = Array.from({ length: 13 }, (_, i) => {
      const date = new Date(Date.UTC(2025, 9 + i, 1));
      return { periodStart: date.toISOString().slice(0, 10), values: { in: 1, out: 1 } };
    });
    const { container } = chart("grouped", thirteen);
    const labels = [...container.querySelectorAll("[data-axis] li")].map((li) => li.textContent);
    expect(labels[0]).toBe("Oct ’25");
    expect(labels[3]).toBe("Jan ’26");
    expect(labels[12]).toBe("Oct");
  });

  test("with nothing to chart it says so", () => {
    chart("grouped", []);
    expect(screen.getByText("Nothing to chart yet.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

const tooltip = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-tooltip]");
const faded = (el: Element) => el.classList.contains("opacity-50");
const KEY = /^Lighter bars:/;

describe("MonthBars: the frame and the tooltip", () => {
  test("it brings no panel of its own: the page supplies one", () => {
    chart("grouped");
    const classes = screen.getByRole("figure").className;
    for (const frame of ["bg-panel", "shadow-soft", "rounded-card", "p-5"]) {
      expect(classes).not.toContain(frame);
    }
  });

  test("the tooltip sits above a short month's bars and never rises out of the plot", async () => {
    const user = userEvent.setup();
    const { container } = chart("grouped", [
      { periodStart: "2026-08-01", values: { in: 100, out: 20 } },
      { periodStart: "2026-09-01", values: { in: 25, out: null } },
    ]);
    // The plot is 160px high and a two-series tooltip 70px, so its bottom may
    // not pass 160 - 70 = 90px. August peaks at 100%: 160 + 8 would be 168px.
    await user.tab();
    expect(tooltip(container)?.textContent).toContain("Aug 2026");
    expect(tooltip(container)?.style.bottom).toBe("90px");
    // September peaks at 25% of 160px = 40px, plus the 8px gap.
    await user.keyboard("{ArrowRight}");
    expect(tooltip(container)?.textContent).toContain("Sep 2026");
    expect(tooltip(container)?.style.bottom).toBe("48px");
  });

  test("hovering a month shows its figures and leaving hides them", async () => {
    const user = userEvent.setup();
    const { container } = chart("grouped");
    const september = screen.getByLabelText(/^Sep 2026/);
    await user.hover(september);
    expect(tooltip(container)?.textContent).toContain("Sep 2026");
    expect(tooltip(container)?.textContent).toContain("no figure");
    await user.unhover(september);
    expect(tooltip(container)).toBeNull();
  });

  test("a tap shows a month's figures even where a tap does not focus", () => {
    const { container } = chart("grouped");
    const september = screen.getByLabelText(/^Sep 2026/);
    fireEvent.click(september);
    expect(document.activeElement).toBe(september);
    expect(tooltip(container)?.textContent).toContain("Sep 2026");
  });
});

describe("MonthBars: the scale", () => {
  test("a negative figure neither inflates nor shrinks the stacked scale, and draws no bar", () => {
    chart("stacked", [
      { periodStart: "2026-08-01", values: { in: -20, out: 40 } },
      { periodStart: "2026-09-01", values: { in: 20, out: 10 } },
    ]);
    const august = screen.getByLabelText("Aug 2026: Cash in $-20, Cash out $40");
    expect(height(august.querySelector('[data-series="out"]')!)).toBe("100%");
    expect(august.querySelector('[data-series="in"]')).toBeNull();
  });

  test("heights are rounded to two decimals", () => {
    chart("stacked", [{ periodStart: "2026-08-01", values: { in: 1, out: 2 } }]);
    const august = screen.getByLabelText(/^Aug 2026/);
    expect(height(august.querySelector('[data-series="in"]')!)).toBe("33.33%");
    expect(height(august.querySelector('[data-series="out"]')!)).toBe("66.67%");
  });

  test("a zero is stated and draws nothing at all", () => {
    chart("grouped", [{ periodStart: "2026-08-01", values: { in: 0, out: 5 } }]);
    const august = screen.getByLabelText("Aug 2026: Cash in $0, Cash out $5");
    expect(august.querySelectorAll("[data-series]")).toHaveLength(1);
    expect(august.querySelector("[data-missing]")).toBeNull();
  });

  test("a figure that is not a finite number is missing, and the other months still draw", () => {
    chart("grouped", [
      { periodStart: "2026-07-01", values: { in: Number.NaN, out: 10 } },
      { periodStart: "2026-08-01", values: { in: Number.POSITIVE_INFINITY, out: 5 } },
      { periodStart: "2026-09-01", values: { in: 20, out: 5 } },
    ]);
    const july = screen.getByLabelText("Jul 2026: Cash in no figure, Cash out $10");
    expect(july.querySelector('[data-series="in"]')).toBeNull();
    expect(height(july.querySelector('[data-series="out"]')!)).toBe("50%");
    expect(screen.getByLabelText("Aug 2026: Cash in no figure, Cash out $5")).toBeTruthy();
    const september = screen.getByLabelText(/^Sep 2026/);
    expect(height(september.querySelector('[data-series="in"]')!)).toBe("100%");
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows[1]?.textContent).toBe("Jul 2026no figure$10");
  });
});

describe("MonthBars: grouped and stacked", () => {
  const BOTH: BarRow[] = [{ periodStart: "2026-08-01", values: { in: 60, out: 40 } }];

  test("grouped draws the two bars side by side, each in its own lane", () => {
    chart("grouped", BOTH);
    const august = screen.getByLabelText(/^Aug 2026/);
    expect(august.querySelector("[data-pile]")).toBeNull();
    const bars = [...august.querySelectorAll("[data-series]")];
    expect(bars.map((bar) => bar.getAttribute("data-series"))).toEqual(["in", "out"]);
    expect(bars.every((bar) => bar.parentElement === august)).toBe(true);
  });

  test("stacked draws one pile per month holding every segment", () => {
    chart("stacked", BOTH);
    const august = screen.getByLabelText(/^Aug 2026/);
    const piles = august.querySelectorAll("[data-pile]");
    expect(piles).toHaveLength(1);
    expect(
      [...piles[0]!.querySelectorAll("[data-series]")].map((s) => s.getAttribute("data-series")),
    ).toEqual(["in", "out"]);
    expect(august.querySelectorAll("[data-series]")).toHaveLength(2);
  });

  test("bars and swatches keep their colour in forced-colours mode", async () => {
    const user = userEvent.setup();
    for (const mode of ["grouped", "stacked"] as const) {
      const { container } = chart(mode, BOTH);
      await user.tab();
      const painted = [
        ...container.querySelectorAll("[data-series]"),
        ...within(screen.getByRole("list", { name: "Legend" }))
          .getAllByRole("listitem")
          .map((li) => li.firstElementChild!),
        ...tooltip(container)!.querySelectorAll("[data-swatch]"),
      ];
      expect(painted).toHaveLength(6);
      for (const el of painted) expect(el.classList.contains("forced-color-adjust-none")).toBe(true);
      cleanup();
    }
  });
});

describe("MonthBars: months that are not like the others", () => {
  const NOTED: BarRow[] = [
    { periodStart: "2026-09-01", values: { in: 10, out: 5 } },
    { periodStart: "2026-10-01", values: { in: 4, out: 2 }, note: "so far" },
  ];

  test.each(["grouped", "stacked"] as const)(
    "a noted month's bars are drawn at half strength (%s)",
    (mode) => {
      chart(mode, NOTED);
      const bars = (name: RegExp) => [...screen.getByLabelText(name).querySelectorAll("[data-series]")];
      expect(bars(/^Oct 2026/).map(faded)).toEqual([true, true]);
      expect(bars(/^Sep 2026/).map(faded)).toEqual([false, false]);
    },
  );

  test("a noted month's tooltip carries the note, and a key says what lighter bars mean", async () => {
    const user = userEvent.setup();
    const { container } = chart("grouped", NOTED);
    expect(screen.getByText(KEY).textContent).toBe("Lighter bars: so far");
    await user.hover(screen.getByLabelText(/^Oct 2026/));
    expect(tooltip(container)?.textContent).toContain("Oct 2026so far");
  });

  test("with no month drawn lighter there is no key", () => {
    chart("grouped");
    expect(screen.queryByText(KEY)).toBeNull();
  });

  test("the key names only notes that drew something", () => {
    chart("grouped", [
      { periodStart: "2026-09-01", values: { in: 10, out: 5 } },
      { periodStart: "2026-10-01", values: { in: null, out: null }, note: "partial" },
    ]);
    expect(screen.queryByText(KEY)).toBeNull();
  });

  test("grouped: a missing figure leaves a mark in its lane, which a zero does not", () => {
    chart("grouped", [
      { periodStart: "2026-08-01", values: { in: 0, out: 20 } },
      { periodStart: "2026-09-01", values: { in: 12, out: null } },
    ]);
    const marks = screen.getByLabelText(/^Sep 2026/).querySelectorAll("[data-missing]");
    expect(marks).toHaveLength(1);
    expect(marks[0]?.getAttribute("data-missing")).toBe("out");
    expect(marks[0]?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByLabelText(/^Aug 2026/).querySelector("[data-missing]")).toBeNull();
    // Grouped bars are compared one by one, so a missing one fades nothing.
    expect(faded(screen.getByLabelText(/^Sep 2026/).querySelector('[data-series="in"]')!)).toBe(false);
    expect(screen.queryByText(KEY)).toBeNull();
  });

  test("stacked: a missing figure alone does not make a pile partial; whether a month is whole is the caller's to say", () => {
    chart("stacked", [
      { periodStart: "2026-08-01", values: { in: 60, out: 40 } },
      { periodStart: "2026-09-01", values: { in: 55, out: null } },
    ]);
    const september = screen.getByLabelText("Sep 2026: Cash in $55, Cash out no figure");
    expect(september.querySelectorAll("[data-series]")).toHaveLength(1);
    expect(faded(september.querySelector('[data-series="in"]')!)).toBe(false);
    expect(september.getAttribute("data-noted")).toBeNull();
    expect(screen.queryByText(KEY)).toBeNull();
    // The words still say which figure is not there.
    expect(within(screen.getByRole("table")).getAllByRole("row")[2]?.textContent).toBe(
      "Sep 2026$55no figure",
    );
  });

  test("stacked: a pile the caller notes as partial is drawn lighter, and the key says why", () => {
    chart("stacked", [
      { periodStart: "2026-08-01", values: { in: 60, out: 40 } },
      { periodStart: "2026-09-01", values: { in: 55, out: null }, note: "partial" },
    ]);
    const september = screen.getByLabelText("Sep 2026 (partial): Cash in $55, Cash out no figure");
    expect(faded(september.querySelector('[data-series="in"]')!)).toBe(true);
    expect(faded(screen.getByLabelText(/^Aug 2026/).querySelector('[data-series="in"]')!)).toBe(false);
    expect(screen.getByText(KEY).textContent).toBe("Lighter bars: partial");
  });
});

describe("MonthBars: keyboard and assistive technology", () => {
  const THREE: BarRow[] = [
    { periodStart: "2026-07-01", values: { in: 5, out: 3 } },
    { periodStart: "2026-08-01", values: { in: 7, out: 4 } },
    { periodStart: "2026-09-01", values: { in: 9, out: 6 } },
  ];
  const stops = () =>
    screen.getAllByRole("img").map((column) => column.getAttribute("tabindex"));

  test("the chart is one tab stop: a second tab leaves it and hides the tooltip", async () => {
    const user = userEvent.setup();
    const { container } = chart("grouped", THREE);
    expect(stops()).toEqual(["0", "-1", "-1"]);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText(/^Jul 2026/));
    await user.tab();
    expect(screen.getByRole("figure").contains(document.activeElement)).toBe(false);
    expect(tooltip(container)).toBeNull();
  });

  test("arrow keys, Home and End move between months and show each one's figures", async () => {
    const user = userEvent.setup();
    const { container } = chart("grouped", THREE);
    await user.tab();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByLabelText(/^Aug 2026/));
    expect(tooltip(container)?.textContent).toContain("Aug 2026");
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(screen.getByLabelText(/^Sep 2026/));
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByLabelText(/^Sep 2026/));
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(screen.getByLabelText(/^Aug 2026/));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(screen.getByLabelText(/^Jul 2026/));
    expect(tooltip(container)?.textContent).toContain("Jul 2026");
  });

  test("the tab stop is the month last focused", async () => {
    const user = userEvent.setup();
    chart("grouped", THREE);
    await user.tab();
    await user.keyboard("{End}");
    expect(stops()).toEqual(["-1", "-1", "0"]);
    await user.tab();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByLabelText(/^Sep 2026/));
  });

  test("Escape hides the tooltip without moving focus", async () => {
    const user = userEvent.setup();
    const { container } = chart("grouped", THREE);
    await user.tab();
    expect(tooltip(container)).not.toBeNull();
    await user.keyboard("{Escape}");
    expect(tooltip(container)).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText(/^Jul 2026/));
  });

  test("the months are one named group, which points at a hidden hint about the arrow keys once", () => {
    chart("grouped", THREE);
    const hint = screen.getByText("Use the left and right arrow keys to move between months.");
    expect(hint.classList.contains("sr-only")).toBe(true);
    const group = screen.getByRole("group", { name: "Cash in and out" });
    expect(group.getAttribute("aria-describedby")).toBe(hint.id);
    const columns = screen.getAllByRole("img");
    expect(columns).toHaveLength(3);
    for (const column of columns) {
      expect(group.contains(column)).toBe(true);
      // Said once on the group, not thirteen times over.
      expect(column.hasAttribute("aria-describedby")).toBe(false);
    }
  });

  test("the axis is hidden from assistive technology and the table from sight", () => {
    const { container } = chart("grouped");
    expect(container.querySelector("[data-axis]")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("table").closest(".sr-only")).not.toBeNull();
  });
});

describe("MonthBars: a total in the stacked tooltip", () => {
  const lines = (container: HTMLElement) =>
    [...tooltip(container)!.querySelectorAll("li")].map((li) =>
      [...li.children].map((cell) => cell.textContent).filter(Boolean).join(" "),
    );

  test("a pile's tooltip ends with its total", async () => {
    const user = userEvent.setup();
    const { container } = chart("stacked", [
      { periodStart: "2026-08-01", values: { in: 60, out: 40 } },
    ]);
    await user.tab();
    expect(lines(container)).toEqual(["Cash in $60", "Cash out $40", "Total $100"]);
  });

  test("a figure missing from a month the caller calls whole does not qualify its total", async () => {
    const user = userEvent.setup();
    const { container } = chart("stacked", [
      { periodStart: "2026-08-01", values: { in: 60, out: 40 } },
      { periodStart: "2026-09-01", values: { in: 55, out: null } },
    ]);
    await user.hover(screen.getByLabelText(/^Sep 2026/));
    expect(lines(container)).toEqual(["Cash in $55", "Cash out no figure", "Total $55"]);
  });

  test("in a noted month with a figure missing it is a partial total", async () => {
    const user = userEvent.setup();
    const { container } = chart("stacked", [
      { periodStart: "2026-08-01", values: { in: 60, out: 40 } },
      { periodStart: "2026-09-01", values: { in: 55, out: null }, note: "partial" },
    ]);
    await user.hover(screen.getByLabelText(/^Sep 2026/));
    expect(lines(container)).toEqual(["Cash in $55", "Cash out no figure", "Partial total $55"]);
    expect(tooltip(container)?.textContent).not.toContain("so far");
  });

  test("a noted month with every figure in is still a plain total: the note already says the rest", async () => {
    const user = userEvent.setup();
    const { container } = chart("stacked", [
      { periodStart: "2026-10-01", values: { in: 4, out: 2 }, note: "so far" },
    ]);
    await user.tab();
    expect(lines(container)).toEqual(["Cash in $4", "Cash out $2", "Total $6"]);
  });

  test("with no figure at all there is nothing to total, and no $0 is invented", async () => {
    const user = userEvent.setup();
    const { container } = chart("stacked", [
      { periodStart: "2026-08-01", values: { in: 60, out: 40 } },
      { periodStart: "2026-09-01", values: { in: null, out: null } },
    ]);
    await user.hover(screen.getByLabelText(/^Sep 2026/));
    expect(lines(container)).toEqual(["Cash in no figure", "Cash out no figure"]);
    expect(tooltip(container)?.textContent).not.toContain("$0");
  });

  test("grouped bars are read one by one: no total", async () => {
    const user = userEvent.setup();
    const { container } = chart("grouped", [
      { periodStart: "2026-08-01", values: { in: 60, out: 40 } },
    ]);
    await user.tab();
    expect(lines(container)).toEqual(["Cash in $60", "Cash out $40"]);
    expect(tooltip(container)?.textContent).not.toContain("Total");
  });

  test("a single stacked series is its own total", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MonthBars
        title="MRR by market"
        series={[SERIES[0]!]}
        rows={[{ periodStart: "2026-08-01", values: { in: 60 } }]}
        mode="stacked"
        format={usd}
      />,
    );
    await user.tab();
    expect(lines(container)).toEqual(["Cash in $60"]);
  });

  test("the taller tooltip still stays inside the plot", async () => {
    const user = userEvent.setup();
    const { container } = chart("stacked", [
      { periodStart: "2026-08-01", values: { in: 60, out: 40 } },
    ]);
    // Three lines: 16 + 16 + 4 + 3 * 16 + 2 * 2 = 88px, so its bottom may not pass 160 - 88.
    await user.tab();
    expect(tooltip(container)?.style.bottom).toBe("72px");
  });
});

describe("MonthBars: an empty note", () => {
  const EMPTY: BarRow[] = [
    { periodStart: "2026-09-01", values: { in: 10, out: 5 } },
    { periodStart: "2026-10-01", values: { in: 4, out: 2 }, note: "" },
  ];

  test.each(["grouped", "stacked"] as const)("is no note at all (%s)", async (mode) => {
    const user = userEvent.setup();
    const { container } = chart(mode, EMPTY);
    const october = screen.getByLabelText(/^Oct 2026/);
    expect(october.getAttribute("aria-label")).toBe("Oct 2026: Cash in $4, Cash out $2");
    expect(october.getAttribute("data-noted")).toBeNull();
    expect([...october.querySelectorAll("[data-series]")].map(faded)).toEqual([false, false]);
    expect(screen.queryByText(KEY)).toBeNull();
    expect(within(screen.getByRole("table")).getByText("Oct 2026")).toBeTruthy();
    await user.hover(october);
    expect(tooltip(container)?.querySelector("p")?.textContent).toBe("Oct 2026");
  });
});

describe("MonthBars: a stacked month with nothing in it", () => {
  test("every segment missing leaves one mark at the baseline, so it is not read as a zero month", () => {
    chart("stacked", [
      { periodStart: "2026-07-01", values: { in: 60, out: 40 } },
      { periodStart: "2026-08-01", values: { in: 0, out: 0 } },
      { periodStart: "2026-09-01", values: { in: null, out: null } },
    ]);
    const september = screen.getByLabelText("Sep 2026: Cash in no figure, Cash out no figure");
    const marks = september.querySelectorAll("[data-missing]");
    expect(marks).toHaveLength(1);
    expect(marks[0]?.getAttribute("aria-hidden")).toBe("true");
    expect(marks[0]?.closest("[data-pile]")).not.toBeNull();
    expect(september.querySelector("[data-series]")).toBeNull();
    // A true zero month draws nothing at all.
    expect(screen.getByLabelText(/^Aug 2026/).querySelector("[data-missing]")).toBeNull();
    expect(screen.getByLabelText(/^Jul 2026/).querySelector("[data-missing]")).toBeNull();
  });

  test("a pile missing only one segment has no mark: what is there is drawn", () => {
    chart("stacked", [
      { periodStart: "2026-08-01", values: { in: 60, out: 40 } },
      { periodStart: "2026-09-01", values: { in: 55, out: null } },
    ]);
    expect(screen.getByLabelText(/^Sep 2026/).querySelector("[data-missing]")).toBeNull();
  });
});

describe("MonthBars: when the months change under it", () => {
  const month = (periodStart: string, value: number): BarRow => ({
    periodStart,
    values: { in: value, out: value },
  });
  const JUL = month("2026-07-01", 5);
  const AUG = month("2026-08-01", 7);
  const SEP = month("2026-09-01", 9);
  const OCT = month("2026-10-01", 11);
  const bars = (rows: BarRow[]) => (
    <MonthBars title="Cash in and out" series={SERIES} rows={rows} mode="grouped" format={usd} />
  );
  const stops = () => screen.getAllByRole("img").map((column) => column.getAttribute("tabindex"));

  test("the window sliding a month keeps the tooltip and the tab stop on the month that was focused", async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(bars([JUL, AUG, SEP]));
    await user.tab();
    await user.keyboard("{End}");
    expect(tooltip(container)?.textContent).toContain("Sep 2026");
    rerender(bars([AUG, SEP, OCT]));
    // September moved from the third column to the second, and so did everything about it.
    expect(document.activeElement).toBe(screen.getByLabelText(/^Sep 2026/));
    expect(tooltip(container)?.textContent).toContain("Sep 2026");
    expect(tooltip(container)?.textContent).not.toContain("Oct 2026");
    expect(stops()).toEqual(["-1", "0", "-1"]);
  });

  test("a hovered month that slides keeps its own tooltip", async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(bars([JUL, AUG, SEP]));
    await user.hover(screen.getByLabelText(/^Aug 2026/));
    rerender(bars([AUG, SEP, OCT]));
    expect(tooltip(container)?.textContent).toContain("Aug 2026");
  });

  test("when the focused month is gone there is no tooltip, and the tab stop is the first month", async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(bars([JUL, AUG, SEP]));
    await user.tab();
    await user.keyboard("{End}");
    rerender(bars([JUL, AUG]));
    expect(tooltip(container)).toBeNull();
    expect(stops()).toEqual(["0", "-1"]);
  });

  test("when the hovered month is gone there is no tooltip for another in its place", async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(bars([JUL, AUG, SEP]));
    await user.hover(screen.getByLabelText(/^Jul 2026/));
    rerender(bars([AUG, SEP, OCT]));
    expect(tooltip(container)).toBeNull();
    expect(stops()).toEqual(["0", "-1", "-1"]);
  });

  test("there is always exactly one tab stop, on a column that exists", async () => {
    const user = userEvent.setup();
    const { rerender } = render(bars([JUL, AUG, SEP]));
    await user.tab();
    await user.keyboard("{End}");
    for (const rows of [[AUG, SEP, OCT], [SEP], [JUL, AUG], [OCT]]) {
      rerender(bars(rows));
      expect(stops().filter((stop) => stop === "0")).toHaveLength(1);
    }
  });
});
