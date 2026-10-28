import { describe, expect, test } from "vitest";
import {
  INTEL_FIELDS,
  INTEL_LIMITS,
  NO_LINKS_OR_CONTACTS,
  agentIntelOf,
  cleanIntelEdit,
  cleanIntelRows,
  intelSummaryOf,
  isArtifactUrl,
  looksLikeLink,
  newestSignals,
  presentIntel,
  type IntelEdit,
} from "./dealIntel";

// A US deal's sales intelligence (convex/dealIntel.ts): what research found
// about a practice, cleaned once here for the server, the import and the
// editor alike. Every refusal is a fixed sentence: it never quotes a value.

const ARTIFACT = "https://claude.ai/artifact/0a1b2c3d-made-up-1";

const ok = (edit: IntelEdit) => {
  const result = cleanIntelEdit(edit);
  if (!result.ok) throw new Error(`refused: ${result.problem}`);
  return result.patch;
};
const refused = (edit: IntelEdit) => {
  const result = cleanIntelEdit(edit);
  if (result.ok) throw new Error("was let through");
  return result.problem;
};

describe("isArtifactUrl", () => {
  test.each([
    ARTIFACT,
    "https://claude.ai/artifact/abc123",
    "https://claude.ai/artifact/ABC_def-0123456789",
  ])("takes %s", (url) => expect(isArtifactUrl(url)).toBe(true));

  test.each([
    "http://claude.ai/artifact/abc123",
    "https://claude.ai/artifact/",
    "https://claude.ai/artifact/abc/def",
    "https://claude.ai/artifact/abc?x=1",
    "https://claude.ai/artifact/abc#top",
    "https://claude.ai.example.com/artifact/abc",
    "https://evil.test/https://claude.ai/artifact/abc",
    "https://user@claude.ai/artifact/abc",
    "https://claude.ai:8443/artifact/abc",
    "https://claude.ai/chat/abc",
    "javascript:alert(1)//claude.ai/artifact/abc",
    " https://claude.ai/artifact/abc",
    `https://claude.ai/artifact/${"a".repeat(129)}`,
    "",
    7,
    null,
  ])("refuses %s", (url) => expect(isArtifactUrl(url)).toBe(false));
});

describe("looksLikeLink", () => {
  test.each([
    "see https://example.test/page",
    "http://x.y",
    "www.example-vertical.com",
    "their site, examplevertical.com, says so",
    "ExampleVertical.health",
    "ftp://files.example.test",
  ])("finds one in %s", (text) => expect(looksLikeLink(text)).toBe(true));

  test.each([
    "athenahealth",
    "Uses eClinicalWorks and Epic for the hospital side.",
    "Example Vertical Inc. bought St. Louis Bone & Joint in 2025.",
    "Ph.D. on staff, e.g. a sports medicine fellow",
    "Revenue grew 3.5x in U.S. markets",
    "A company named example.company? no",
    "Node.js",
  ])("finds none in %s", (text) => expect(looksLikeLink(text)).toBe(false));
});

describe("cleanIntelEdit", () => {
  test("trims, cleans and keeps what is given; leaves out what is not", () => {
    const patch = ok({
      summary: "  A made-up group​ of 59 physicians ‮ in TX.  ",
      ehr: " athenahealth ",
      billingModel: "outsourced",
      specialties: ["Spine", " ", "Sports medicine", "Spine"],
      competitors: [{ name: " Example RCM ", note: " Their current vendor " }, { name: "Other" }],
      signals: [{ date: "2026-03", kind: "hiring", text: "Hiring a revenue cycle director", source: "Made-up job board" }],
      people: [{ name: "Dr. Casey Placeholder", role: "Managing partner", note: null }],
      fit: { score: 82, reasons: ["Large group", " ", "Outsourced billing"] },
      sources: [{ title: " Made-up market scan ", url: ARTIFACT }],
      researchedAt: "2026-10-01",
    });
    expect(patch).toEqual({
      summary: "A made-up group of 59 physicians in TX.",
      ehr: "athenahealth",
      billingModel: "outsourced",
      specialties: ["Spine", "Sports medicine"],
      competitors: [{ name: "Example RCM", note: "Their current vendor" }, { name: "Other" }],
      signals: [
        { date: "2026-03", kind: "hiring", text: "Hiring a revenue cycle director", source: "Made-up job board" },
      ],
      people: [{ name: "Dr. Casey Placeholder", role: "Managing partner" }],
      fit: { score: 82, reasons: ["Large group", "Outsourced billing"] },
      sources: [{ title: "Made-up market scan", url: ARTIFACT }],
      researchedAt: "2026-10-01",
    });
    expect(Object.keys(patch)).not.toContain("angle");
  });

  test("null, blank text and an empty list clear a field (undefined in the patch)", () => {
    const patch = ok({ summary: null, angle: "   ", painPoints: [], sources: null, fit: null, risks: [" "] });
    expect(patch).toEqual({
      summary: undefined,
      angle: undefined,
      painPoints: undefined,
      sources: undefined,
      fit: undefined,
      risks: undefined,
    });
    expect(Object.keys(patch).sort()).toEqual(["angle", "fit", "painPoints", "risks", "sources", "summary"]);
  });

  test("text fields keep to one line, and the summary may hold paragraphs", () => {
    expect(ok({ angle: "one\ntwo" }).angle).toBe("one two");
    expect(ok({ summary: "one\n\n\n\ntwo\n" }).summary).toBe("one\n\ntwo");
  });

  test.each([
    ["summary", "The summary", INTEL_LIMITS.summary],
    ["ownership", "The ownership", INTEL_LIMITS.ownership],
    ["ehr", "The EHR", INTEL_LIMITS.system],
    ["pm", "The practice management system", INTEL_LIMITS.system],
    ["rcmVendor", "The RCM vendor", INTEL_LIMITS.system],
    ["workersComp", "The workers' comp note", INTEL_LIMITS.workersComp],
    ["angle", "The angle", INTEL_LIMITS.angle],
    ["nextBestAction", "The next best action", INTEL_LIMITS.nextBestAction],
  ] as const)("%s over its limit is refused, never cut", (field, label, max) => {
    expect(ok({ [field]: "a".repeat(max) })[field]).toHaveLength(max);
    expect(refused({ [field]: "a".repeat(max + 1) })).toBe(
      `${label} is too long (${max} characters at most).`,
    );
  });

  test.each([
    ["specialties", INTEL_LIMITS.specialties, "8 specialties"],
    ["ancillaries", INTEL_LIMITS.ancillaries, "8 ancillaries"],
    ["painPoints", INTEL_LIMITS.painPoints, "5 pain points"],
    ["talkingPoints", INTEL_LIMITS.talkingPoints, "4 talking points"],
    ["risks", INTEL_LIMITS.risks, "3 risks"],
  ] as const)("%s: at most so many, each short", (field, max, words) => {
    const list = Array.from({ length: max }, (_, i) => `Made-up ${i}`);
    expect(ok({ [field]: list })[field]).toEqual(list);
    expect(refused({ [field]: [...list, "one more"] })).toBe(`The intelligence lists ${words} at most.`);
    const long = field === "specialties" || field === "ancillaries" ? INTEL_LIMITS.tag : INTEL_LIMITS.point;
    expect(refused({ [field]: ["a".repeat(long + 1)] })).toMatch(
      new RegExp(`is too long \\(${long} characters at most\\)\\.$`),
    );
  });

  test("the lists of things", () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ name: `Made-up ${i}` }));
    expect(refused({ competitors: [...eight, { name: "Ninth" }] })).toBe(
      "The intelligence lists 8 competitors at most.",
    );
    expect(refused({ competitors: [{ name: " " }] })).toBe("A competitor needs a name.");
    expect(refused({ competitors: [{ name: "a".repeat(61) }] })).toBe(
      "A competitor's name is too long (60 characters at most).",
    );
    expect(refused({ competitors: [{ name: "A", note: "a".repeat(161) }] })).toBe(
      "A competitor's note is too long (160 characters at most).",
    );
    const signal = { kind: "news", text: "Made-up news", source: "Made-up paper" };
    expect(refused({ signals: Array.from({ length: 9 }, () => signal) })).toBe(
      "The intelligence lists 8 signals at most.",
    );
    expect(refused({ signals: [{ ...signal, kind: "rumour" }] })).toBe(
      "A signal is hiring, funding, acquisition, technology, leadership, growth, news or a meeting.",
    );
    expect(refused({ signals: [{ ...signal, text: " " }] })).toBe("A signal needs its text and its source.");
    expect(refused({ signals: [{ ...signal, source: "" }] })).toBe("A signal needs its text and its source.");
    expect(refused({ signals: [{ ...signal, text: "a".repeat(201) }] })).toBe(
      "A signal's text is too long (200 characters at most).",
    );
    expect(refused({ signals: [{ ...signal, source: "a".repeat(121) }] })).toBe(
      "A signal's source is too long (120 characters at most).",
    );
    const person = { name: "Pat Example", role: "Practice administrator" };
    expect(refused({ people: Array.from({ length: 7 }, () => person) })).toBe(
      "The intelligence lists 6 people at most.",
    );
    expect(refused({ people: [{ ...person, role: " " }] })).toBe("A person needs a name and a role.");
    expect(refused({ people: [{ ...person, name: "a".repeat(81) }] })).toBe(
      "A person's name is too long (80 characters at most).",
    );
    expect(refused({ people: [{ ...person, note: "a".repeat(161) }] })).toBe(
      "A person's note is too long (160 characters at most).",
    );
    const source = { title: "Made-up scan", url: ARTIFACT };
    expect(refused({ sources: Array.from({ length: 13 }, (_, i) => ({ ...source, title: `S${i}` })) })).toBe(
      "The intelligence lists 12 sources at most.",
    );
    expect(refused({ sources: [{ ...source, title: " " }] })).toBe("A source needs a title.");
    expect(refused({ sources: [{ ...source, title: "a".repeat(121) }] })).toBe(
      "A source's title is too long (120 characters at most).",
    );
  });

  test.each(["2026-03", "2026-03-31", "2024-02-29"])("a signal's date may be %s", (date) => {
    expect(ok({ signals: [{ date, kind: "news", text: "Made-up", source: "Made-up" }] }).signals![0]!.date).toBe(date);
  });

  test.each(["2026", "2026-13", "2026-02-30", "2025-02-29", "03/2026", "2026-3", "last spring"])(
    "a signal's date of %s is refused",
    (date) => {
      expect(refused({ signals: [{ date, kind: "news", text: "Made-up", source: "Made-up" }] })).toBe(
        "A signal's date is written YYYY-MM or YYYY-MM-DD.",
      );
    },
  );

  test("a blank signal date is no date", () => {
    expect(ok({ signals: [{ date: " ", kind: "meeting", text: "Made-up", source: "Made-up" }] }).signals).toEqual([
      { kind: "meeting", text: "Made-up", source: "Made-up" },
    ]);
  });

  test.each([
    [{ billingModel: "in house" }, "A billing model is in-house, outsourced or hybrid."],
    [{ fit: { score: 101, reasons: [] } }, "A fit score is a whole number from 0 to 100."],
    [{ fit: { score: -1, reasons: [] } }, "A fit score is a whole number from 0 to 100."],
    [{ fit: { score: 7.5, reasons: [] } }, "A fit score is a whole number from 0 to 100."],
    [{ fit: { score: Number.NaN, reasons: [] } }, "A fit score is a whole number from 0 to 100."],
    [{ fit: { score: 5, reasons: ["a", "b", "c", "d"] } }, "A fit score gives 3 reasons at most."],
    [{ fit: { score: 5, reasons: ["a".repeat(161)] } }, "A fit reason is too long (160 characters at most)."],
    [{ researchedAt: "2026-10" }, "The research date is written YYYY-MM-DD."],
    [{ researchedAt: "2026-02-30" }, "The research date is written YYYY-MM-DD."],
    [{ sources: [{ title: "Made-up", url: "https://example.test/report" }] }, "A source links to a claude.ai artifact (https://claude.ai/artifact/…), and to nothing else."],
  ] as const)("%o is refused", (edit, said) => expect(refused(edit as IntelEdit)).toBe(said));

  test("a fit of 0 and of 100 are kept", () => {
    expect(ok({ fit: { score: 0, reasons: [] } }).fit).toEqual({ score: 0, reasons: [] });
    expect(ok({ fit: { score: 100, reasons: [] } }).fit).toEqual({ score: 100, reasons: [] });
  });

  // Every field a person or research wrote: no address, no number, no link.
  const LEAKS = ["write to pat@example.test", "call (555) 123-4567", "see www.example-vertical.com", "https://example.test"];
  const EVERY_TEXT: ((leak: string) => IntelEdit)[] = [
    (leak) => ({ summary: leak }),
    (leak) => ({ ownership: leak }),
    (leak) => ({ ehr: leak }),
    (leak) => ({ pm: leak }),
    (leak) => ({ rcmVendor: leak }),
    (leak) => ({ workersComp: leak }),
    (leak) => ({ angle: leak }),
    (leak) => ({ nextBestAction: leak }),
    (leak) => ({ specialties: [leak] }),
    (leak) => ({ ancillaries: [leak] }),
    (leak) => ({ painPoints: [leak] }),
    (leak) => ({ talkingPoints: [leak] }),
    (leak) => ({ risks: [leak] }),
    (leak) => ({ competitors: [{ name: leak }] }),
    (leak) => ({ competitors: [{ name: "Made-up", note: leak }] }),
    (leak) => ({ signals: [{ kind: "news", text: leak, source: "Made-up" }] }),
    (leak) => ({ signals: [{ kind: "news", text: "Made-up", source: leak }] }),
    (leak) => ({ people: [{ name: leak, role: "Made-up" }] }),
    (leak) => ({ people: [{ name: "Made-up", role: leak }] }),
    (leak) => ({ people: [{ name: "Made-up", role: "Made-up", note: leak }] }),
    (leak) => ({ fit: { score: 5, reasons: [leak] } }),
    (leak) => ({ sources: [{ title: leak, url: ARTIFACT }] }),
  ];
  test("every text field refuses an address, a phone number or a link, in fixed words", () => {
    for (const [index, make] of EVERY_TEXT.entries()) {
      for (const leak of LEAKS) {
        const said = refused(make(leak));
        expect([index, said]).toEqual([index, NO_LINKS_OR_CONTACTS]);
        expect(said).not.toContain(leak);
      }
    }
  });

  test("covers every field", () => {
    expect([...INTEL_FIELDS].sort()).toEqual(
      [
        "summary",
        "ownership",
        "ehr",
        "pm",
        "billingModel",
        "rcmVendor",
        "specialties",
        "ancillaries",
        "workersComp",
        "competitors",
        "signals",
        "people",
        "painPoints",
        "talkingPoints",
        "risks",
        "angle",
        "nextBestAction",
        "fit",
        "sources",
        "researchedAt",
      ].sort(),
    );
  });
});

describe("cleanIntelRows", () => {
  test("each row gives every field, so an import replaces a deal's intelligence whole", () => {
    const result = cleanIntelRows([{ dealName: " Example Vertical ", ehr: "athenahealth" }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.dealName).toBe("Example Vertical");
    expect(result.rows[0]!.patch.ehr).toBe("athenahealth");
    expect(Object.keys(result.rows[0]!.patch).sort()).toEqual([...INTEL_FIELDS].sort());
    expect(result.rows[0]!.patch.summary).toBeUndefined();
  });

  test("a refusal names the row by its place, counted from 1, and never what it holds", () => {
    const result = cleanIntelRows([
      { dealName: "SECRET A" },
      { dealName: "SECRET B", summary: "write to SECRET@example.test" },
    ]);
    expect(result).toEqual({ ok: false, problem: `Row 2: ${NO_LINKS_OR_CONTACTS}` });
  });

  test("a row needs its deal's name, and names a deal once", () => {
    expect(cleanIntelRows([{ dealName: " " }])).toEqual({ ok: false, problem: "Row 1: A row needs its deal's name." });
    expect(cleanIntelRows([{ dealName: "a".repeat(121) }])).toEqual({
      ok: false,
      problem: "Row 1: That name is too long (120 characters at most).",
    });
    expect(cleanIntelRows([{ dealName: "SECRET A" }, { dealName: " secret  a " }])).toEqual({
      ok: false,
      problem: "Row 2: This deal is named twice in the list.",
    });
  });
});

const STORED = {
  summary: "s".repeat(600),
  ownership: "Physician-owned",
  ehr: "athenahealth",
  billingModel: "outsourced" as const,
  competitors: [{ name: "Made-up RCM" }],
  signals: [
    { kind: "news" as const, text: "undated", source: "x" },
    { date: "2026-03", kind: "hiring" as const, text: "march", source: "x" },
    { date: "2026-03-15", kind: "growth" as const, text: "mid march", source: "x" },
    { date: "2025-11-02", kind: "funding" as const, text: "november", source: "x" },
    { date: "2026-07-01", kind: "meeting" as const, text: "july", source: "x" },
  ],
  angle: "Made-up angle",
  nextBestAction: "Made-up action",
  fit: { score: 74, reasons: ["Made-up reason"] },
  updatedAt: 5,
};

describe("what is sent", () => {
  test("newestSignals: newest first, a day before its month, undated last, at most n", () => {
    expect(newestSignals(STORED.signals, 9).map((s) => s.text)).toEqual([
      "july",
      "mid march",
      "march",
      "november",
      "undated",
    ]);
    expect(newestSignals(STORED.signals, 3).map((s) => s.text)).toEqual(["july", "mid march", "march"]);
  });

  test("presentIntel: every field, null or [] when unset", () => {
    expect(presentIntel({ updatedAt: 9 })).toEqual({
      summary: null,
      ownership: null,
      ehr: null,
      pm: null,
      billingModel: null,
      rcmVendor: null,
      specialties: [],
      ancillaries: [],
      workersComp: null,
      competitors: [],
      signals: [],
      people: [],
      painPoints: [],
      talkingPoints: [],
      risks: [],
      angle: null,
      nextBestAction: null,
      fit: null,
      sources: [],
      researchedAt: null,
      updatedAt: 9,
    });
  });

  test("intelSummaryOf: what the table's columns need", () => {
    expect(intelSummaryOf(STORED)).toEqual({
      fit: 74,
      ehr: "athenahealth",
      billingModel: "outsourced",
      ownership: "Physician-owned",
      signals: 5,
      newestSignal: "2026-07-01",
      competitors: 1,
    });
    expect(intelSummaryOf({ updatedAt: 1 })).toEqual({
      fit: null,
      ehr: null,
      billingModel: null,
      ownership: null,
      signals: 0,
      newestSignal: null,
      competitors: 0,
    });
  });

  test("agentIntelOf: the summary cut to 300, the fit's score, the newest three signals", () => {
    const sent = agentIntelOf(STORED);
    expect(sent).toEqual({
      summary: `${"s".repeat(299)}…`,
      fit: 74,
      ehr: "athenahealth",
      billingModel: "outsourced",
      ownership: "Physician-owned",
      signals: [
        { date: "2026-07-01", kind: "meeting", text: "july" },
        { date: "2026-03-15", kind: "growth", text: "mid march" },
        { date: "2026-03", kind: "hiring", text: "march" },
      ],
      angle: "Made-up angle",
      nextBestAction: "Made-up action",
    });
    expect(sent.summary).toHaveLength(300);
    expect(agentIntelOf({ updatedAt: 1, summary: "short" }).summary).toBe("short");
  });
});
