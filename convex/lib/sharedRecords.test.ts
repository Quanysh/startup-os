import { describe, expect, test } from "vitest";
import {
  SHARED_CAPS,
  parseSharedRecords,
  sharedKeyOf,
  sharedRefusal,
  type SharedRecord,
} from "./sharedRecords";

// Apollo's two shared lists as they are pushed. Every sequence and stage name
// is made up; one that must never be echoed carries the word SECRET.

// A Wednesday.
const NOW = Date.UTC(2026, 9, 14, 6);
const options = { empty: false, now: NOW };

const sequence = (sequenceId: string, over: Record<string, unknown> = {}) => ({
  sequenceId,
  name: "Made-up outreach",
  active: true,
  archived: false,
  steps: 7,
  createdAt: "2026-03-13",
  lastUsedAt: "2026-03-17",
  delivered: 24,
  opened: 1,
  replied: 0,
  bounced: 1,
  unsubscribed: 1,
  clicked: 0,
  ...over,
});
const stage = (entity: string, name: string, count: number, over: Record<string, unknown> = {}) => ({
  entity,
  stage: name,
  count,
  ...over,
});

const issuesOf = (result: ReturnType<typeof parseSharedRecords>) =>
  result.ok ? [] : result.issues;

describe("parseSharedRecords: sequences", () => {
  test("a sequence becomes the stored record, field for field", () => {
    const result = parseSharedRecords("apollo", "sequence", [sequence("69b49cd9")], options);
    expect(result).toEqual({
      ok: true,
      rows: [
        {
          kind: "sequence",
          sequenceId: "69b49cd9",
          name: "Made-up outreach",
          active: true,
          archived: false,
          steps: 7,
          createdAt: "2026-03-13",
          lastUsedAt: "2026-03-17",
          delivered: 24,
          opened: 1,
          replied: 0,
          bounced: 1,
          unsubscribed: 1,
          clicked: 0,
        },
      ],
    });
  });

  test("a sequence never used, with clicks not tracked and no name: the optional fields stay absent", () => {
    const row = sequence("seq1", { name: undefined, lastUsedAt: undefined, clicked: undefined });
    const result = parseSharedRecords("apollo", "sequence", [row], options);
    expect(result.ok && result.rows[0]).toEqual({
      kind: "sequence",
      sequenceId: "seq1",
      name: "(no name)",
      active: true,
      archived: false,
      steps: 7,
      createdAt: "2026-03-13",
      delivered: 24,
      opened: 1,
      replied: 0,
      bounced: 1,
      unsubscribed: 1,
    });
  });

  test("a name is cleaned and cut as other mirrored text is", () => {
    const hidden = "Made‮up​ outreach\n two";
    const long = "x".repeat(300);
    const result = parseSharedRecords(
      "apollo",
      "sequence",
      [sequence("a", { name: hidden }), sequence("b", { name: long })],
      options,
    );
    expect(result.ok && result.rows.map((row) => (row as { name: string }).name)).toEqual([
      "Made up outreach two",
      `${"x".repeat(199)}…`,
    ]);
  });

  test("strict: a field the OS did not ask for refuses the push, and its name is not echoed", () => {
    for (const extra of [
      { contacts: [{ name: "SECRET Person" }] },
      { ownerName: "SECRET Person" },
      { "SECRET Person": 1 },
      { emailBody: "SECRET" },
    ]) {
      const result = parseSharedRecords("apollo", "sequence", [sequence("a", extra)], options);
      expect(issuesOf(result)).toEqual([
        { path: "records.0", message: "has a field the OS does not accept" },
      ]);
      expect(JSON.stringify(result)).not.toContain("SECRET");
    }
  });

  test.each([
    ["sequenceId", { sequenceId: "has a space" }, "is not in the expected form"],
    ["sequenceId", { sequenceId: "x".repeat(SHARED_CAPS.id + 1) }, "is too long or too large"],
    ["active", { active: "yes" }, "is missing or of the wrong type"],
    ["archived", { archived: undefined }, "is missing or of the wrong type"],
    ["steps", { steps: 2.5 }, "is missing or of the wrong type"],
    ["steps", { steps: SHARED_CAPS.steps + 1 }, "is too long or too large"],
    ["delivered", { delivered: -1 }, "is empty or too small"],
    ["delivered", { delivered: SHARED_CAPS.count + 1 }, "is too long or too large"],
    ["replied", { replied: undefined }, "is missing or of the wrong type"],
    ["clicked", { clicked: 1.5 }, "is missing or of the wrong type"],
    ["createdAt", { createdAt: "2026-02-30" }, "is not a real date (YYYY-MM-DD)"],
    ["createdAt", { createdAt: "2026-03-13T10:00:00Z" }, "is not a real date (YYYY-MM-DD)"],
    ["lastUsedAt", { lastUsedAt: "17 March" }, "is not a real date (YYYY-MM-DD)"],
    ["createdAt", { createdAt: "2026-10-16" }, "is in the future"],
    ["lastUsedAt", { lastUsedAt: "2027-01-01" }, "is in the future"],
    ["opened", { opened: 25 }, "is more than delivered"],
    ["replied", { replied: 25 }, "is more than delivered"],
    ["name", { name: "x".repeat(5001) }, "is too long or too large"],
  ])("a bad %s refuses the push by path, in fixed words", (field, over, message) => {
    const result = parseSharedRecords(
      "apollo",
      "sequence",
      [sequence("good"), sequence("bad", over)],
      options,
    );
    expect(issuesOf(result)).toEqual([{ path: `records.1.${field}`, message }]);
  });

  test("a date may be a day ahead of the server's: the reader's clock is not this one", () => {
    const row = sequence("a", { lastUsedAt: "2026-10-15" });
    expect(parseSharedRecords("apollo", "sequence", [row], options).ok).toBe(true);
  });

  test("the same sequence twice refuses the push", () => {
    const result = parseSharedRecords("apollo", "sequence", [sequence("a"), sequence("a")], options);
    expect(issuesOf(result)).toEqual([
      { path: "records.1.sequenceId", message: "repeats the id of an earlier record" },
    ]);
  });

  test("more sequences than the list may hold", () => {
    const rows = Array.from({ length: SHARED_CAPS.sequence + 1 }, (_, i) => sequence(`s${i}`));
    expect(issuesOf(parseSharedRecords("apollo", "sequence", rows, options))).toEqual([
      { path: "records", message: `At most ${SHARED_CAPS.sequence} records of this kind in one push.` },
    ]);
  });

  test("rows of the other kind are refused, each by path", () => {
    const result = parseSharedRecords("apollo", "sequence", [stage("contact", "Cold", 735)], options);
    expect(result.ok).toBe(false);
    expect(issuesOf(result).every((issue) => issue.path.startsWith("records.0"))).toBe(true);
  });
});

describe("parseSharedRecords: stage counts", () => {
  test("contacts and accounts by stage become the stored records", () => {
    const rows = [stage("contact", "Cold", 735), stage("contact", "Approaching", 24), stage("account", "Cold", 546)];
    expect(parseSharedRecords("apollo", "stage_count", rows, options)).toEqual({
      ok: true,
      rows: [
        { kind: "stage_count", entity: "contact", stage: "Cold", count: 735 },
        { kind: "stage_count", entity: "contact", stage: "Approaching", count: 24 },
        { kind: "stage_count", entity: "account", stage: "Cold", count: 546 },
      ],
    });
  });

  test("strict: a person's name has no field", () => {
    const result = parseSharedRecords(
      "apollo",
      "stage_count",
      [stage("contact", "Cold", 1, { contactName: "SECRET Person" })],
      options,
    );
    expect(issuesOf(result)).toEqual([
      { path: "records.0", message: "has a field the OS does not accept" },
    ]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  test.each([
    ["entity", { entity: "person" }, "is not one of the allowed values"],
    ["stage", { stage: undefined }, "is missing or of the wrong type"],
    ["stage", { stage: " ​ " }, "is empty"],
    ["stage", { stage: "x".repeat(5001) }, "is too long or too large"],
    ["count", { count: 1.5 }, "is missing or of the wrong type"],
    ["count", { count: -1 }, "is empty or too small"],
    ["count", { count: SHARED_CAPS.count + 1 }, "is too long or too large"],
    ["count", { count: "735" }, "is missing or of the wrong type"],
  ])("a bad %s refuses the push by path, in fixed words", (field, over, message) => {
    const rows = [stage("contact", "Cold", 735), stage("contact", "Warm", 1, over)];
    expect(issuesOf(parseSharedRecords("apollo", "stage_count", rows, options))).toEqual([
      { path: `records.1.${field}`, message },
    ]);
  });

  test("a stage named twice for one entity is refused, however it is cased; the same name for the other entity is not", () => {
    const twice = [stage("contact", "Cold", 1), stage("account", "Cold", 2), stage("contact", " cold ", 3)];
    expect(issuesOf(parseSharedRecords("apollo", "stage_count", twice, options))).toEqual([
      { path: "records.2.stage", message: "repeats an earlier stage" },
    ]);
  });

  test("more stages than the list may hold", () => {
    const rows = Array.from({ length: SHARED_CAPS.stage_count + 1 }, (_, i) => stage("contact", `S${i}`, i));
    expect(issuesOf(parseSharedRecords("apollo", "stage_count", rows, options))).toEqual([
      {
        path: "records",
        message: `At most ${SHARED_CAPS.stage_count} records of this kind in one push.`,
      },
    ]);
  });
});

describe("parseSharedRecords: an empty list", () => {
  test.each(["sequence", "stage_count"] as const)(
    "%s: refused without `empty`, and refused with it: nothing there is a failed read",
    (kind) => {
      expect(issuesOf(parseSharedRecords("apollo", kind, [], options))).toEqual([
        {
          path: "records",
          message:
            'An empty list is a failed read. Where nothing waiting is the real answer, send "empty": true with it.',
        },
      ]);
      expect(issuesOf(parseSharedRecords("apollo", kind, [], { empty: true, now: NOW }))).toEqual([
        {
          path: "empty",
          message: "An empty push is never accepted from this source: nothing there is a failed read.",
        },
      ]);
    },
  );
});

describe("sharedKeyOf", () => {
  test("the two kinds cannot share an id, and a stage is keyed by entity and name", () => {
    const parsed = parseSharedRecords("apollo", "sequence", [sequence("abc")], options);
    const seq = parsed.ok ? parsed.rows[0]! : null;
    expect(sharedKeyOf(seq!)).toEqual({
      externalId: "sequence:abc",
      sortAt: Date.UTC(2026, 2, 17),
    });
    expect(sharedKeyOf({ kind: "stage_count", entity: "contact", stage: "Cold", count: 735 })).toEqual({
      externalId: "stage:contact:cold",
      sortAt: 735,
    });
    expect(
      sharedKeyOf({ kind: "stage_count", entity: "account", stage: "Cold", count: 546 }).externalId,
    ).toBe("stage:account:cold");
  });

  test("a sequence never used sorts by when it was made", () => {
    const parsed = parseSharedRecords(
      "apollo",
      "sequence",
      [sequence("abc", { lastUsedAt: undefined })],
      options,
    );
    expect(parsed.ok && sharedKeyOf(parsed.rows[0]!).sortAt).toBe(Date.UTC(2026, 2, 13));
  });
});

describe("sharedRefusal: the guard the write itself applies", () => {
  const seq: SharedRecord = {
    kind: "sequence",
    sequenceId: "abc",
    name: "Made-up outreach",
    active: true,
    archived: false,
    steps: 7,
    createdAt: "2026-03-13",
    delivered: 24,
    opened: 1,
    replied: 0,
    bounced: 1,
    unsubscribed: 1,
  };
  const cold: SharedRecord = { kind: "stage_count", entity: "contact", stage: "Cold", count: 735 };
  const BROKE = (bad: number, of: number) =>
    `${bad} of ${of} records broke the size and shape rules, so nothing was written.`;

  test("what the parser produces passes", () => {
    expect(sharedRefusal("sequence", [seq])).toBeNull();
    expect(sharedRefusal("stage_count", [cold])).toBeNull();
  });

  test("an empty batch is never written", () => {
    expect(sharedRefusal("sequence", [])).toBe("An empty list is never written for this source.");
    expect(sharedRefusal("stage_count", [])).toBe("An empty list is never written for this source.");
  });

  test("a row of the other kind", () => {
    expect(sharedRefusal("sequence", [seq, cold])).toBe(BROKE(1, 2));
    expect(sharedRefusal("stage_count", [seq])).toBe(BROKE(1, 1));
  });

  test("a repeated row, and one that was never cleaned", () => {
    expect(sharedRefusal("sequence", [seq, seq])).toBe(BROKE(1, 2));
    expect(sharedRefusal("stage_count", [cold, { ...cold, stage: "COLD" }])).toBe(BROKE(1, 2));
    expect(sharedRefusal("sequence", [{ ...seq, name: "SECRET‮name" }])).toBe(BROKE(1, 1));
    expect(sharedRefusal("sequence", [{ ...seq, name: "x".repeat(201) }])).toBe(BROKE(1, 1));
    expect(sharedRefusal("stage_count", [{ ...cold, stage: "" }])).toBe(BROKE(1, 1));
  });

  test("a number or a date that could not be true", () => {
    expect(sharedRefusal("sequence", [{ ...seq, delivered: 1.5 }])).toBe(BROKE(1, 1));
    expect(sharedRefusal("sequence", [{ ...seq, replied: 25 }])).toBe(BROKE(1, 1));
    expect(sharedRefusal("sequence", [{ ...seq, createdAt: "13 March" }])).toBe(BROKE(1, 1));
    expect(sharedRefusal("sequence", [{ ...seq, sequenceId: "has space" }])).toBe(BROKE(1, 1));
    expect(sharedRefusal("stage_count", [{ ...cold, count: -1 }])).toBe(BROKE(1, 1));
  });

  test("more rows than the list may hold", () => {
    const rows = Array.from({ length: SHARED_CAPS.stage_count + 1 }, (_, i) => ({
      ...cold,
      stage: `S${i}`,
    }));
    expect(sharedRefusal("stage_count", rows)).toBe(
      `More than ${SHARED_CAPS.stage_count} records in one read.`,
    );
  });
});
