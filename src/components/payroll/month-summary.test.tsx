// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { summarise, type CurrencySummary } from "@convex/lib/payroll";
import { CircleNote, FigureCell, MonthSummary } from "./month-summary";
import type { Line, Person } from "./shared";

// Every name, salary and rate here is made up. None is a statutory figure.
//
// What the month's table cannot say in its foot: why a total is not known,
// and what a year at this month's rate comes to. The totals themselves are
// the foot's (payroll-view.test.tsx), and said nowhere else.
const OCT = "2026-10-01";

const person = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    name: `Person ${id}`,
    title: null,
    kind: "employee",
    payBasis: "net",
    monthlyGross: null,
    monthlyNet: 450_000_00,
    currency: "KZT",
    startDate: null,
    endDate: null,
    notes: null,
    order: 0,
    archivedAt: null,
    removable: true,
    ...extra,
  }) as unknown as Person;
const byGross = (id: string, extra: Record<string, unknown> = {}) =>
  person(id, { payBasis: "gross", monthlyNet: null, monthlyGross: 500_000_00, ...extra });
const line = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    name: id,
    appliesTo: "employee",
    paidBy: "employee",
    rateBp: 1000,
    lessLineIds: [],
    allowance: 0,
    baseCap: null,
    order: 0,
    active: true,
    ...extra,
  }) as unknown as Line;

const PENSION = line("pension");
const LEVY = line("levy", { paidBy: "company", rateBp: 350, order: 1 });
const LEVY_UNSET = line("levy", { paidBy: "company", rateBp: null, order: 1 });

const setsOf = (people: Person[], lines: Line[]) =>
  summarise({ people, lines, month: OCT, companyCurrency: "KZT" });
/** What the strip says for one currency's set. */
function show(set: CurrencySummary) {
  return render(<MonthSummary set={set} companyCurrency="KZT" />).container;
}
const linkTo = (name: string) => {
  const link = screen.getByRole("link", { name });
  expect(link.getAttribute("href")).toBe("#payroll-lines");
  return link;
};

afterEach(cleanup);

describe("what the month's foot cannot say", () => {
  test("every rate set: a year at this month's rate, and nothing else", () => {
    const [set] = setsOf([person("a"), byGross("b", { order: 1 })], [PENSION, LEVY]);
    const box = show(set!);
    expect(box.textContent).toBe(
      "A year at this month's rate: ₸12,420,000. That is the total cost × 12: a simple multiple, not a forecast.",
    );
    expect(screen.queryByRole("link")).toBeNull();
  });

  test("entered as net with no rate set: why, one sentence a cause, with one link to the rates", () => {
    const people = Array.from({ length: 18 }, (_, i) => person(`p${i}`, { order: i }));
    const lines = [
      ...Array.from({ length: 7 }, (_, i) => line(`w${i}`, { rateBp: null, order: i })),
      line("c0", { paidBy: "company", rateBp: null, order: 7 }),
      line("c1", { paidBy: "company", rateBp: null, order: 8 }),
    ];
    show(setsOf(people, lines)[0]!);
    const why = screen.getByText(
      /^7 withheld rates are not set, so gross cannot be worked out for 18 people\./,
    );
    expect(why.textContent).toBe(
      "7 withheld rates are not set, so gross cannot be worked out for 18 people. Set the rates below.",
    );
    expect(why.contains(linkTo("Set the rates below."))).toBe(true);
    expect(
      screen.getByText(
        "2 company-paid rates are not set, so what the company pays on top, and the total cost, cannot be worked out for 18 people.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/A year at this month's rate/)).toBeNull();
  });

  test("only a company-paid rate missing", () => {
    show(setsOf([person("a"), byGross("b", { order: 1 })], [PENSION, LEVY_UNSET])[0]!);
    expect(screen.getByText(/^1 company-paid rate is not set/).textContent).toBe(
      "1 company-paid rate is not set, so what the company pays on top, and the total cost, cannot be worked out for 2 people. Set the rate below.",
    );
    linkTo("Set the rate below.");
  });

  test("net- and gross-based with a withheld rate not set: the second cause follows the first", () => {
    const people = [person("a"), byGross("b", { order: 1 }), byGross("c", { order: 2 })];
    show(setsOf(people, [line("pension", { rateBp: null }), LEVY])[0]!);
    expect(
      screen.getByText(/^1 withheld rate is not set, so gross cannot be worked out for 1 person\./),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "For the same reason, what is withheld and net pay cannot be worked out for 2 people whose pay is entered as gross.",
      ),
    ).toBeTruthy();
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  test("entered as gross only, a withheld rate not set: the sentence stands on its own", () => {
    show(setsOf([byGross("a")], [line("pension", { rateBp: null }), LEVY])[0]!);
    expect(
      screen.getByText(
        /^1 withheld rate is not set, so what is withheld and net pay cannot be worked out for 1 person whose pay is entered as gross\./,
      ),
    ).toBeTruthy();
  });

  test("another currency and a line with a cap: not known there, and why", () => {
    const people = [person("a"), byGross("u", { currency: "USD", monthlyGross: 4_000_00, order: 1 })];
    const capped = line("levy", { paidBy: "company", rateBp: 350, baseCap: 400_000_00, order: 1 });
    const usd = setsOf(people, [PENSION, capped]).find((set) => set.currency === "USD")!;
    show(usd);
    expect(screen.getByText(/^1 person paid in US dollars has a line/).textContent).toBe(
      "1 person paid in US dollars has a line with an allowance or a cap. Those are amounts in tenge, so the line is not computed in another currency. See the lines below.",
    );
    linkTo("See the lines below.");
  });

  test("withheld rates that leave no gross are said so", () => {
    show(setsOf([person("a")], [line("all", { rateBp: 10_000 })])[0]!);
    expect(
      screen.getByText(/^For 1 person, what is withheld leaves no gross that gives the net entered\./),
    ).toBeTruthy();
    linkTo("See the lines below.");
  });

  test("nobody in the month: nothing is said", () => {
    const box = show(setsOf([], [PENSION])[0]!);
    expect(box.textContent).toBe("");
  });

  test("lines in a circle: it says where to look", () => {
    render(<CircleNote />);
    expect(screen.getByText(/^Not known yet/).textContent).toBe(
      "Not known yet: some lines subtract each other in a circle. See the lines below.",
    );
    linkTo("See the lines below.");
  });
});

describe("a total in the foot", () => {
  const totals = { people: 3, net: { sum: 0, known: 0 } } as never;
  const cell = (figure: { sum: number; known: number }, partial = false) =>
    render(<FigureCell figure={figure} totals={totals} currency="KZT" partial={partial} />).container
      .textContent;

  test("whole: the amount, in tabular figures", () => {
    const { container } = render(
      <FigureCell figure={{ sum: 1_000_00, known: 3 }} totals={totals} currency="KZT" />,
    );
    expect(container.textContent).toBe("₸1,000");
    expect(container.querySelector(".font-num")).toBeTruthy();
  });

  test("short of everyone: not known yet, never a part as the whole, and never a zero", () => {
    expect(cell({ sum: 900_00, known: 2 })).toBe("Not known yet");
    expect(cell({ sum: 0, known: 0 })).toBe("Not known yet");
  });

  test("the net keeps its part, and says whose it is", () => {
    expect(cell({ sum: 450_000_00, known: 1 }, true)).toBe("₸450,000for 1 of 3");
    expect(cell({ sum: 0, known: 0 }, true)).toBe("Not known yet");
  });
});
