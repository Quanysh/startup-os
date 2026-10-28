// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { SequenceRow, StageCount } from "@/lib/metrics/apollo";
import { MIN_DELIVERED_FOR_VERDICT } from "@/lib/metrics/gtm";
import type { Tile } from "@/lib/metrics/scorecard";
import { ApolloSections, type ApolloLists } from "./apollo-sections";

afterEach(cleanup);

// Wednesday 14 October 2026: this week began on Monday the 12th, last week on the 5th.
const NOW = Date.UTC(2026, 9, 14, 9);
const DAY = 24 * 60 * 60 * 1000;
const ARRIVES = /arrives? with the daily Apollo read\.$/;

const made = (key: string, points: [string, number][]): Tile => {
  const last = points.at(-1);
  return {
    key,
    scope: "us",
    firstPeriodStart: points[0]?.[0] ?? null,
    latest: last
      ? { value: last[1], periodStart: last[0], currency: null, source: "apollo", syncedAt: NOW }
      : null,
    series: points.map(([periodStart, value]) => ({ periodStart, value })),
  };
};
const KEYS = [
  "apollo_contacts",
  "apollo_accounts",
  "apollo_tasks_open",
  "apollo_tasks_overdue",
  "apollo_contacts_added",
  "apollo_calls",
] as const;
type Series = Partial<Record<(typeof KEYS)[number], [string, number][]>>;
const tilesOf = (series: Series): Tile[] => KEYS.map((key) => made(key, series[key] ?? []));

const seq = (sequenceId: string, over: Partial<SequenceRow> = {}): SequenceRow => ({
  sequenceId,
  name: `Sequence ${sequenceId}`,
  active: true,
  archived: false,
  steps: 7,
  createdAt: "2026-03-13",
  lastUsedAt: "2026-10-12",
  delivered: 24,
  opened: 1,
  replied: 0,
  bounced: 1,
  unsubscribed: 1,
  ...over,
});
const STAGES: StageCount[] = [
  { entity: "contact", stage: "Cold", count: 735 },
  { entity: "contact", stage: "Approaching", count: 24 },
  { entity: "contact", stage: "Do Not Contact", count: 1 },
  { entity: "account", stage: "Cold", count: 546 },
];
const lists = (
  sequences: SequenceRow[] = [],
  stages: StageCount[] = [],
  at: { sequences?: number; stages?: number } = {},
): ApolloLists => ({
  sequences: { readAt: sequences.length === 0 ? null : (at.sequences ?? NOW - 3600_000), rows: sequences },
  stages: { readAt: stages.length === 0 ? null : (at.stages ?? NOW - 3600_000), rows: stages },
  lastOkAt: NOW - 3600_000,
});
const NOTHING = lists();
const FULL: Series = {
  apollo_contacts: [["2026-10-12", 760]],
  apollo_accounts: [["2026-10-12", 546]],
  apollo_tasks_open: [["2026-10-12", 23]],
  apollo_tasks_overdue: [["2026-10-12", 23]],
  apollo_contacts_added: [
    ["2026-09-21", 0],
    ["2026-09-28", 0],
    ["2026-10-05", 710],
  ],
  apollo_calls: [
    ["2026-09-21", 0],
    ["2026-09-28", 0],
    ["2026-10-05", 0],
  ],
};

const show = (series: Series, given: ApolloLists | "loading" = NOTHING, now = NOW) =>
  render(
    <ApolloSections
      tiles={tilesOf(series)}
      now={now}
      lists={given === "loading" ? undefined : given}
    />,
  );
const section = (name: string) =>
  within(screen.getByRole("heading", { level: 3, name }).closest("section")!);
const tile = (label: string) =>
  within(screen.getByRole("heading", { name: label }).closest("article")!);
const cells = (row: HTMLElement) => [...row.querySelectorAll("th,td")].map((cell) => cell.textContent);

describe("before the first Apollo read", () => {
  test("each section says in one sentence that it arrives with the daily read; no table, tile or zero", () => {
    show({});
    for (const name of ["Sequences", "Prospects", "Tasks and calls"]) {
      const s = section(name);
      expect(s.getAllByText(ARRIVES)).toHaveLength(1);
      expect(s.queryByRole("table")).toBeNull();
      expect(s.queryByRole("article")).toBeNull();
      expect(s.queryByText("0")).toBeNull();
    }
    expect(section("Sequences").getByText("The sequence list arrives with the daily Apollo read.")).toBeTruthy();
    expect(
      section("Prospects").getByText(
        "Contacts, accounts and their stages arrive with the daily Apollo read.",
      ),
    ).toBeTruthy();
    expect(
      section("Tasks and calls").getByText(
        "Open and overdue tasks and calls arrive with the daily Apollo read.",
      ),
    ).toBeTruthy();
  });

  test("while the lists load there are placeholders, and nothing is said to be missing", () => {
    const { container } = show(FULL, "loading");
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(screen.queryByText(ARRIVES)).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("Sequences", () => {
  test("one sequence under the minimum: the counts alone, no rate, no totals row", () => {
    show({}, lists([seq("a", { name: "Practice outreach", lastUsedAt: "2026-10-12" })]));
    const table = section("Sequences").getByRole("table", { name: "Apollo sequences" });
    const [head, ...rows] = within(table).getAllByRole("row");
    expect(cells(head!)).toEqual([
      "Sequence",
      "Status",
      "Steps",
      "Delivered",
      "Opened",
      "Replied",
      "Bounced",
      "Last used",
    ]);
    expect(rows).toHaveLength(1);
    expect(cells(rows[0]!)).toEqual(["Practice outreach", "Active", "7", "24", "1", "0", "1", "Oct 12"]);
    expect(within(table).queryByText(/%/)).toBeNull();
    expect(within(table).queryByText("All sequences")).toBeNull();
    expect(
      section("Sequences").getByText(
        `Open and reply rates are given from ${MIN_DELIVERED_FOR_VERDICT} emails delivered; under that, the counts alone.`,
      ),
    ).toBeTruthy();
  });

  test("from the minimum delivered, opened and replied carry their rate", () => {
    show({}, lists([seq("a", { delivered: 240, opened: 96, replied: 12, bounced: 3 })]));
    const row = within(section("Sequences").getByRole("table")).getAllByRole("row")[1]!;
    expect(cells(row).slice(3, 7)).toEqual(["240", "96 (40%)", "12 (5%)", "3"]);
    // Every sequence has its rates, so there is nothing to explain.
    expect(section("Sequences").queryByText(/rates are given from/)).toBeNull();
  });

  test("several sequences: a totals row, with rates only if the total reaches the minimum", () => {
    show(
      {},
      lists([
        seq("a", { delivered: 240, opened: 96, replied: 12, bounced: 3 }),
        seq("b", { delivered: 60, opened: 9, replied: 3, bounced: 1 }),
      ]),
    );
    const rows = within(section("Sequences").getByRole("table")).getAllByRole("row");
    expect(rows).toHaveLength(4);
    expect(cells(rows[2]!).slice(3, 7)).toEqual(["60", "9", "3", "1"]);
    expect(cells(rows[3]!)).toEqual(["All sequences", "", "", "300", "105 (35%)", "15 (5%)", "4", ""]);
  });

  test("several small sequences: the totals row has no rate either", () => {
    show({}, lists([seq("a"), seq("b")]));
    const rows = within(section("Sequences").getByRole("table")).getAllByRole("row");
    expect(cells(rows[3]!).slice(3, 7)).toEqual(["48", "2", "0", "2"]);
  });

  test("status: active, paused and archived, each a chip with words", () => {
    show(
      {},
      lists([
        seq("a"),
        seq("b", { active: false }),
        seq("c", { archived: true }),
      ]),
    );
    const chips = [...section("Sequences").getByRole("table").querySelectorAll('[data-slot="status-chip"]')];
    expect(chips.map((chip) => [chip.textContent, chip.getAttribute("data-tone")])).toEqual([
      ["Active", "success"],
      ["Paused", "neutral"],
      ["Archived", "neutral"],
    ]);
  });

  test("an active sequence unused for 30 days or more is called idle, in the warning tone", () => {
    show(
      {},
      lists([
        seq("idle", { lastUsedAt: "2026-03-17" }),
        seq("fresh", { lastUsedAt: "2026-10-01" }),
        seq("paused", { lastUsedAt: "2026-03-17", active: false }),
        seq("never", { lastUsedAt: undefined, createdAt: "2026-10-10" }),
      ]),
    );
    const rows = within(section("Sequences").getByRole("table")).getAllByRole("row");
    const idle = within(rows[1]!).getByText("Idle 211 days");
    expect(idle.closest('[data-slot="status-chip"]')?.getAttribute("data-tone")).toBe("warning");
    expect(rows[1]!.getAttribute("data-tone")).toBe("warning");
    expect(cells(rows[1]!).at(-1)).toBe("Mar 17Idle 211 days");
    expect(cells(rows[2]!).at(-1)).toBe("Oct 1");
    expect(rows[2]!.getAttribute("data-tone")).toBeNull();
    // Paused: nobody expects it to run.
    expect(cells(rows[3]!).at(-1)).toBe("Mar 17");
    expect(cells(rows[4]!).at(-1)).toBe("Never used");
  });

  test("a list last read past its limit says how old it is", () => {
    show({}, lists([seq("a")], [], { sequences: NOW - 9 * DAY }));
    expect(
      section("Sequences").getByText("Out of date: the sequence list was last read 9 days ago."),
    ).toBeTruthy();
    cleanup();
    show({}, lists([seq("a")], [], { sequences: NOW - 2 * DAY }));
    expect(section("Sequences").queryByText(/Out of date/)).toBeNull();
  });
});

describe("Prospects", () => {
  test("contacts and accounts as tiles, each stage with its count and share", () => {
    show(FULL, lists([], STAGES));
    const s = section("Prospects");
    expect(within(s.getByRole("heading", { name: "Contacts in Apollo" }).closest("article")!).getByText("760")).toBeTruthy();
    expect(within(s.getByRole("heading", { name: "Accounts in Apollo" }).closest("article")!).getByText("546")).toBeTruthy();

    const contacts = s.getByRole("table", { name: "Contacts by stage" });
    expect(within(contacts).getAllByRole("row").map(cells)).toEqual([
      ["Stage", "Contacts", "Share"],
      ["Cold", "735", "96.7%"],
      ["Approaching", "24", "3.2%"],
      ["Do Not Contact", "1", "0.1%"],
    ]);
    const accounts = s.getByRole("table", { name: "Accounts by stage" });
    expect(within(accounts).getAllByRole("row").map(cells)).toEqual([
      ["Stage", "Accounts", "Share"],
      ["Cold", "546", "100%"],
    ]);
  });

  test("three finished weeks on record: contacts added as a weekly chart, and last week as a figure", () => {
    show(FULL, lists([], STAGES));
    const s = section("Prospects");
    expect(s.getByRole("group", { name: /Contacts added by week/ })).toBeTruthy();
    const added = tile("Contacts added last week");
    expect(added.getByText("710")).toBeTruthy();
    expect(added.getByText("The week of Oct 5.")).toBeTruthy();
  });

  test("one or two weeks on record: the latest week as a figure, and no chart of a bar or two", () => {
    for (const weeks of [
      [["2026-10-05", 710]],
      [
        ["2026-09-28", 0],
        ["2026-10-05", 710],
      ],
    ] as [string, number][][]) {
      show({ ...FULL, apollo_contacts_added: weeks }, lists([], STAGES));
      expect(section("Prospects").queryByRole("group", { name: /by week/ })).toBeNull();
      expect(tile("Contacts added last week").getByText("710")).toBeTruthy();
      cleanup();
    }
  });

  test("no count for last week: no figure, never a 0, and the newest week is named", () => {
    show({ ...FULL, apollo_contacts_added: [["2026-09-28", 5]] }, lists([], STAGES));
    const added = tile("Contacts added last week");
    expect(added.getByText("No value yet")).toBeTruthy();
    expect(added.queryByText("0")).toBeNull();
    expect(
      added.getByText("No count for last week yet: the newest is for the week of Sep 28."),
    ).toBeTruthy();
  });

  test("numbers without stages, and stages without numbers: each says what it is waiting for", () => {
    show(FULL, NOTHING);
    expect(section("Prospects").getByText("Stages arrive with the daily Apollo read.")).toBeTruthy();
    expect(section("Prospects").queryByRole("table", { name: /by stage/ })).toBeNull();
    cleanup();

    show({}, lists([], STAGES));
    const s = section("Prospects");
    expect(s.getByRole("table", { name: "Contacts by stage" })).toBeTruthy();
    const contacts = within(s.getByRole("heading", { name: "Contacts in Apollo" }).closest("article")!);
    expect(contacts.getByText("No value yet")).toBeTruthy();
    expect(contacts.queryByText("0")).toBeNull();
  });

  test("an entity Apollo lists no stage for says so, and shows no empty table", () => {
    show(FULL, lists([], STAGES.filter((row) => row.entity === "contact")));
    const s = section("Prospects");
    expect(s.queryByRole("table", { name: "Accounts by stage" })).toBeNull();
    expect(s.getByText("Apollo's report lists no stage for accounts.")).toBeTruthy();
  });

  test("stale: old stages say how old; old numbers say which week they were read in", () => {
    show(
      { ...FULL, apollo_contacts: [["2026-09-21", 700]], apollo_accounts: [["2026-09-21", 500]] },
      lists([], STAGES, { stages: NOW - 6 * DAY }),
    );
    const s = section("Prospects");
    expect(s.getByText("Out of date: stages were last read 6 days ago.")).toBeTruthy();
    expect(
      s.getByText("Out of date: contacts and accounts were last read in the week of Sep 21."),
    ).toBeTruthy();
  });

  test("current numbers carry no such line", () => {
    show(FULL, lists([], STAGES));
    expect(section("Prospects").queryByText(/Out of date/)).toBeNull();
  });
});

describe("Tasks and calls", () => {
  test("overdue above zero wears the danger tone, with words, and says whose they are", () => {
    show(FULL);
    const overdue = tile("Overdue tasks");
    expect(overdue.getByText("23")).toBeTruthy();
    const chip = overdue.getByText("Overdue").closest('[data-slot="status-chip"]');
    expect(chip?.getAttribute("data-tone")).toBe("danger");
    expect(
      overdue.getByText("Overdue tasks belong to sequences waiting on a manual step."),
    ).toBeTruthy();
    expect(tile("Open Apollo tasks").getByText("23")).toBeTruthy();
  });

  test("none overdue: a real zero, said plainly, with no danger chip", () => {
    show({ ...FULL, apollo_tasks_overdue: [["2026-10-12", 0]] });
    const overdue = tile("Overdue tasks");
    expect(overdue.getByText("0")).toBeTruthy();
    expect(overdue.getByText("No task is past its due date.")).toBeTruthy();
    expect(overdue.queryByText("Overdue")).toBeNull();
  });

  test("overdue not read yet: no value, never a 0", () => {
    show({ ...FULL, apollo_tasks_overdue: [] });
    const overdue = tile("Overdue tasks");
    expect(overdue.getByText("No value yet")).toBeTruthy();
    expect(overdue.queryByText("0")).toBeNull();
    expect(overdue.getByText("Arrives with the daily Apollo read.")).toBeTruthy();
  });

  test("calls last week: a zero Apollo reported is a zero, and weeks of zeros are not charted", () => {
    show(FULL);
    const calls = tile("Calls last week");
    expect(calls.getByText("0")).toBeTruthy();
    expect(calls.getByText("The week of Oct 5.")).toBeTruthy();
    expect(section("Tasks and calls").queryByRole("group", { name: /by week/ })).toBeNull();
    expect(calls.getByText("No call was logged in the 3 weeks on record.")).toBeTruthy();
  });

  test("calls: three weeks with a call among them are charted; two are not", () => {
    show({
      ...FULL,
      apollo_calls: [
        ["2026-09-21", 2],
        ["2026-09-28", 0],
        ["2026-10-05", 5],
      ],
    });
    expect(section("Tasks and calls").getByRole("group", { name: /Calls by week/ })).toBeTruthy();
    expect(tile("Calls last week").getByText("5")).toBeTruthy();
    cleanup();
    show({
      ...FULL,
      apollo_calls: [
        ["2026-09-28", 2],
        ["2026-10-05", 5],
      ],
    });
    expect(section("Tasks and calls").queryByRole("group", { name: /by week/ })).toBeNull();
  });

  test("stale: tasks last read in an earlier week say so, on the tile and for the section", () => {
    show({
      ...FULL,
      apollo_tasks_open: [["2026-09-21", 20]],
      apollo_tasks_overdue: [["2026-09-21", 20]],
    });
    expect(
      section("Tasks and calls").getByText("Out of date: tasks were last read in the week of Sep 21."),
    ).toBeTruthy();
    expect(
      tile("Overdue tasks").getByText("Out of date: Apollo was last read in the week of Sep 21."),
    ).toBeTruthy();
  });

  test("a missing weekly count is no figure: calls with nothing for last week", () => {
    show({ ...FULL, apollo_calls: [] });
    const calls = tile("Calls last week");
    expect(calls.getByText("No value yet")).toBeTruthy();
    expect(calls.getByText("Arrives with the daily Apollo read.")).toBeTruthy();
  });
});
