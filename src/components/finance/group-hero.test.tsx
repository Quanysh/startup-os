// @vitest-environment jsdom
// The group's hero: what each figure under the group's is, and, where one is
// missing, what it lacks and where it is entered. The page's own assembly is
// in src/app/(app)/finance/page.test.tsx. Every figure here is made up.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { AREAS, type Area } from "@convex/lib/roles";
import { ViewerProvider } from "@/components/viewer-provider";
import { groupFigures, type CompanyFigures } from "@/lib/finance/group";
import { GroupHero } from "./group-hero";
import { forgetCountUps } from "./motion";

afterEach(() => {
  cleanup();
  forgetCountUps();
});

const NOW = Date.UTC(2026, 8, 2, 12);
const RATE = { rate: 500, periodStart: "2026-08-01" };
// At ₸500 per $1. Startup's bank burned $28,000 in August, $20,000 of it sent to
// Globex; Globex burned ₸12.5M of its own.
const STARTUP: CompanyFigures = {
  cash: { amount: 500_000, periodStart: "2026-09-01" },
  netBurn: { amount: 28_000, months: ["2026-06-01", "2026-07-01", "2026-08-01"] },
  groupBurn: { amount: 8_000, months: ["2026-06-01", "2026-07-01", "2026-08-01"] },
  unsent: [],
  mrr: { amount: 5_500, periodStart: "2026-08-01" },
};
const GLOBEX: CompanyFigures = {
  cash: { amount: 47_500_000, periodStart: "2026-08-31" },
  netBurn: { amount: 12_500_000, months: ["2026-06-01", "2026-07-01", "2026-08-01"] },
  groupBurn: { amount: 12_500_000, months: ["2026-06-01", "2026-07-01", "2026-08-01"] },
  unsent: [],
  mrr: { amount: 4_000_000, periodStart: "2026-08-01" },
};

const show = (
  us: CompanyFigures = STARTUP,
  kz: CompanyFigures = GLOBEX,
  rate: typeof RATE | null = RATE,
  areas: readonly Area[] = AREAS,
) =>
  render(
    <ViewerProvider viewer={{ role: "cofounder", companies: ["us", "kz"], areas, email: null, name: null }}>
      <GroupHero group={groupFigures(us, kz, rate?.rate ?? null)} us={us} kz={kz} rate={rate} now={NOW} />
    </ViewerProvider>,
  );
const figure = (label: string) =>
  within(
    within(screen.getByRole("region", { name: "Group, in US dollars" }))
      .getByRole("heading", { name: label })
      .closest("article")!,
  );
const lines = (label: string) =>
  Array.from(
    within(screen.getByRole("region", { name: "Group, in US dollars" }))
      .getByRole("heading", { name: label })
      .closest("article")!
      .querySelectorAll("p"),
    (p) => p.textContent,
  );
const splitOf = (label: string) =>
  Array.from(
    within(screen.getByRole("region", { name: "Group, in US dollars" }))
      .getByRole("heading", { name: label })
      .closest("article")!
      .querySelectorAll("dl dt"),
    (dt) => `${dt.textContent}: ${dt.nextElementSibling!.textContent}`,
  );

describe("the split: Startup's own spending and Globex's own burn", () => {
  test("net burn: each company's part, which add up to the group's, each said for what it is", () => {
    show();
    // $8,000 + ₸12.5M ÷ 500 = $33,000: Startup's whole $28,000 plus Globex's ₸2.5M fall, as before.
    expect(lines("Net burn")[0]).toBe("$33K / mo");
    expect(splitOf("Net burn")).toEqual(["Startup: $8,000 / mo", "Globex: ₸12.5M / mo"]);
    expect(lines("Net burn")).toContain("Startup's is its own spending: its net burn from Mercury less what it sent Globex.");
    expect(lines("Net burn")).toContain(
      "Globex's is from its month-end balances, with what Startup sent it taken out as financing, not counted as income.",
    );
  });

  test("runway: each company's own, as its own lens gives it, and said which", () => {
    show();
    // Startup's bank: $500K ÷ $28K. Globex without new money from Startup: ₸47.5M ÷ ₸12.5M.
    expect(splitOf("Runway")).toEqual(["Startup: 17.9 mo", "Globex: 3.8 mo"]);
    expect(lines("Runway")).toContain(
      "Each company's own: Startup's counts what it sends Globex; Globex's is without new money from Startup.",
    );
  });

  test("a month with no figure of what Startup sent is left out of both parts, and said", () => {
    const months = ["2026-06-01", "2026-07-01"];
    show(
      { ...STARTUP, groupBurn: { amount: 8_000, months }, unsent: [{ month: "2026-08-01", lacks: "sent" }] },
      { ...GLOBEX, netBurn: { amount: 12_500_000, months }, groupBurn: { amount: 12_500_000, months }, unsent: [{ month: "2026-08-01", lacks: "sent" }] },
    );
    expect(lines("Net burn")).toContain(
      "Aug 2026 has no whole figure from Mercury of what Startup sent Globex, so it is left out of both companies' parts.",
    );
  });
});

describe("a missing figure says what it lacks, and where it is entered", () => {
  test("Globex's balance: its month-end balance, linked to the form", () => {
    show(STARTUP, { ...GLOBEX, cash: null });
    expect(lines("Cash")).toContain("Globex's month-end balance is not on record yet.");
    expect(figure("Cash").getByRole("link", { name: "month-end balance" }).getAttribute("href")).toBe(
      "/finance?metric=cash&scope=kz#record-a-figure",
    );
    // The runway waits for it, and says which figure.
    expect(lines("Runway")).toContain("Needs group cash first.");
  });

  test("a viewer who cannot enter figures reads the same sentence, with no link", () => {
    show(STARTUP, { ...GLOBEX, cash: null }, RATE, ["finance"]);
    expect(lines("Cash")).toContain("Globex's month-end balance is not on record yet.");
    expect(figure("Cash").queryByRole("link")).toBeNull();
  });

  test("Startup's balance arrives with Mercury: nothing to enter", () => {
    show({ ...STARTUP, cash: null }, GLOBEX);
    expect(lines("Cash")).toContain("Startup's balance arrives with Mercury.");
    expect(figure("Cash").queryByRole("link")).toBeNull();
  });

  test("MRR: Startup's is typed in, linked; Globex's arrives with the CFO workbook", () => {
    show({ ...STARTUP, mrr: null }, { ...GLOBEX, mrr: null });
    expect(lines("MRR")).toEqual(
      expect.arrayContaining(["Startup's MRR figure is not on record yet.", "Globex's MRR arrives with the CFO workbook."]),
    );
    expect(figure("MRR").getByRole("link", { name: "MRR figure" }).getAttribute("href")).toBe(
      "/finance?metric=mrr&scope=us#record-a-figure",
    );
  });

  test("net burn: Startup's waits for Mercury; Globex's for its balances, linked", () => {
    const none = { netBurn: null, groupBurn: null };
    show({ ...STARTUP, ...none }, { ...GLOBEX, ...none });
    expect(lines("Net burn")).toEqual(
      expect.arrayContaining([
        "Startup's net burn needs a month Mercury has read to its end.",
        "Globex's net burn needs its month-end balance at two month-ends in a row.",
      ]),
    );
    expect(figure("Net burn").getByRole("link", { name: "month-end balance" }).getAttribute("href")).toBe(
      "/finance?metric=cash&scope=kz#record-a-figure",
    );
    expect(lines("Runway")).toContain("Needs group net burn first.");
  });

  test("net burn: a part that waits only for what Startup sent says so, with the months", () => {
    const august = [{ month: "2026-08-01", lacks: "sent" as const }];
    show({ ...STARTUP, groupBurn: null, unsent: august }, { ...GLOBEX, netBurn: null, groupBurn: null, unsent: august });
    expect(lines("Net burn")).toEqual(
      expect.arrayContaining([
        "Startup's part needs Mercury's figure for what it sent Globex in Aug 2026.",
        "Globex's net burn needs Mercury's figure for what Startup sent it in Aug 2026.",
      ]),
    );
  });

  test("no rate: the CFO workbook's rate, as before, under every figure", () => {
    show(STARTUP, GLOBEX, null);
    for (const label of ["Cash", "Net burn", "Runway", "MRR"]) {
      expect(lines(label)).toContain("Needs a USD/KZT rate to add Globex's tenge: it arrives with the CFO workbook.");
    }
  });

  test("no note says only that a company 'has no figure'", () => {
    show({ ...STARTUP, cash: null, mrr: null, netBurn: null, groupBurn: null }, { ...GLOBEX, cash: null, mrr: null });
    expect(screen.queryByText(/has no figure yet/)).toBeNull();
  });
});
