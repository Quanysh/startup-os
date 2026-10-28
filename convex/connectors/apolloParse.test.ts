import { describe, expect, test } from "vitest";
import { validateSnapshots } from "../lib/snapshotRules";
import { ConnectorError } from "./errors";
import { SEQUENCES, page, sequence } from "./apollo.fixtures";
import { parseSequences, toSnapshots, totalsOf } from "./apolloParse";

// 06:20 UTC, Monday 12 October 2026.
const NOW = Date.UTC(2026, 9, 12, 6, 20);

describe("parseSequences", () => {
  test("keeps three counters a sequence and the paging figures, and nothing else", () => {
    expect(parseSequences(page(SEQUENCES, 1, 1, 3))).toEqual({
      totalPages: 1,
      totalEntries: 3,
      sequences: [
        { delivered: 120, opened: 60, replied: 5 },
        { delivered: 80, opened: 20, replied: 3 },
        { delivered: 40, opened: 10, replied: 0 },
      ],
    });
  });

  test("no sequence name, id, owner or step survives the parser", () => {
    const kept = JSON.stringify(parseSequences(page(SEQUENCES, 1, 1, 3)));
    for (const leaked of ["Fixture Sequence", "user-fixture-1", "step-1", "manual_email"]) {
      expect(kept).not.toContain(leaked);
    }
  });

  test("a response in another shape is refused, naming where and quoting nothing", () => {
    expect(() => parseSequences({ sequences: [] })).toThrow(
      "Apollo's sequences response is not in the expected shape (pagination).",
    );
    const drifted = page(
      [sequence("a", 120, 60, 5, { unique_replied: "Dr. Jane Example replied" })],
      1,
      1,
      1,
    );
    let thrown: unknown;
    try {
      parseSequences(drifted);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConnectorError);
    expect((thrown as Error).message).toBe(
      "Apollo's sequences response is not in the expected shape (emailer_campaigns.0.unique_replied).",
    );
  });

  test("a counter that is missing or null fails the read: an unknown count is not a zero", () => {
    for (const value of [null, undefined, -1, 2.5]) {
      expect(() =>
        parseSequences(page([sequence("a", 120, 60, 5, { unique_delivered: value })], 1, 1, 1)),
      ).toThrow(
        "Apollo's sequences response is not in the expected shape (emailer_campaigns.0.unique_delivered).",
      );
    }
  });

  test("a null counter is refused whichever of the three it is, never read as zero", () => {
    for (const field of ["unique_delivered", "unique_opened", "unique_replied"]) {
      expect(() =>
        parseSequences(page([sequence("a", 120, 60, 5, { [field]: null })], 1, 1, 1)),
      ).toThrow(
        `Apollo's sequences response is not in the expected shape (emailer_campaigns.0.${field}).`,
      );
    }
  });

  test("a sequence sent without its statistics fails the read", () => {
    expect(() =>
      parseSequences(page([sequence("a", 0, 0, 0, { loaded_stats: false })], 1, 1, 1)),
    ).toThrow("Apollo sent a sequence without its statistics.");
  });

  test("a response that does not say whether statistics were loaded is accepted", () => {
    // The reference does not list `loaded_stats`; a live response carried it.
    const { loaded_stats: _left, ...bare } = sequence("a", 7, 2, 1);
    expect(parseSequences(page([bare], 1, 1, 1)).sequences).toEqual([
      { delivered: 7, opened: 2, replied: 1 },
    ]);
  });
});

describe("totalsOf", () => {
  test("adds every sequence, archived ones included", () => {
    expect(totalsOf(parseSequences(page(SEQUENCES, 1, 1, 3)).sequences)).toEqual({
      delivered: 240,
      opened: 90,
      replied: 8,
    });
  });
});

describe("toSnapshots", () => {
  const rows = toSnapshots({ delivered: 240, opened: 90, replied: 8 }, NOW);

  test("three totals in this week's bucket that the registry accepts from apollo", () => {
    expect(rows).toEqual([
      { key: "outbound_delivered", scope: "us", period: "week", periodStart: "2026-10-12", value: 240 },
      { key: "outbound_opened", scope: "us", period: "week", periodStart: "2026-10-12", value: 90 },
      { key: "outbound_replied", scope: "us", period: "week", periodStart: "2026-10-12", value: 8 },
    ]);
    expect(validateSnapshots("apollo", rows, undefined, { now: NOW })).toEqual([]);
  });

  test("a Sunday read lands in the week that is ending, not the next", () => {
    const sunday = Date.UTC(2026, 9, 18, 6, 20);
    expect(toSnapshots({ delivered: 1, opened: 0, replied: 0 }, sunday)[0]?.periodStart).toBe(
      "2026-10-12",
    );
  });
});
