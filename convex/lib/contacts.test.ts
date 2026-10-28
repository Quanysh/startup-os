import { describe, expect, test } from "vitest";
import {
  CONTACT_WORDS,
  categoriesFor,
  cleanContactNotes,
  withNote,
  categoryFits,
  cleanEmail,
  cleanEmails,
  duplicateCandidates,
  introPaths,
  normalizedName,
  normalizedOrg,
  type IntroRow,
} from "./contacts";

describe("normalizedName", () => {
  test("lowercases, strips accents, punctuation and courtesy titles", () => {
    expect(normalizedName("Dr. Jane Smith, MD")).toBe("jane smith");
    expect(normalizedName("José  O'Neil")).toBe("jose o neil");
    expect(normalizedName("Prof. Ann PhD")).toBe("ann");
    expect(normalizedName("Drake Anderson")).toBe("drake anderson");
  });

  test("an organisation keeps titles that are part of its name", () => {
    expect(normalizedOrg("MD Anderson")).toBe("md anderson");
    expect(normalizedName("MD Anderson")).toBe("anderson");
  });
});

describe("cleanEmail", () => {
  test("lowercases a real address and refuses one that is not, without repeating it", () => {
    expect(cleanEmail("  Dana.Example@Clinic.TEST ")).toBe("dana.example@clinic.test");
    const probe = "probe-address@example.test";
    expect(() => cleanEmail(`not an address ${probe}`)).toThrow(CONTACT_WORDS.emailInvalid);
    try {
      cleanEmail(`not an address ${probe}`);
    } catch (error) {
      expect(String(error)).not.toContain(probe);
    }
  });

  test("drops a repeated address and keeps the order", () => {
    expect(cleanEmails(["B@x.test", "a@x.test", "A@x.test"])).toEqual(["b@x.test", "a@x.test"]);
  });
});

describe("duplicateCandidates", () => {
  test("groups a shared email and the same normalized name", () => {
    const rows = [
      { id: "a", emails: ["shared@x.test"], normalizedName: "jane smith" },
      { id: "b", emails: ["shared@x.test", "other@x.test"], normalizedName: "jane smith" },
      { id: "c", emails: ["only@x.test"], normalizedName: "other person" },
    ];
    expect(duplicateCandidates(rows)).toEqual([
      { reason: "email", ids: ["a", "b"] },
      { reason: "name", ids: ["a", "b"] },
    ]);
  });
});

describe("introPaths", () => {
  const rows: IntroRow[] = [
    {
      id: "introducer",
      name: "Ada Introducer",
      org: "Startup",
      canIntroTo: ["initech", "board"],
      introducedBy: null,
      lastContactAt: 200,
    },
    {
      id: "quiet",
      name: "Bea Quiet",
      org: null,
      canIntroTo: ["Initech Health"],
      introducedBy: null,
      lastContactAt: null,
    },
    {
      id: "target",
      name: "Cara Target",
      org: "Initech Health",
      canIntroTo: [],
      introducedBy: "introducer",
      lastContactAt: 100,
    },
  ];

  test("ranks who can introduce, or who introduced someone at that organisation", () => {
    expect(introPaths(rows, "initech").map((row) => row.id)).toEqual(["introducer"]);
    expect(introPaths(rows, "Initech Health").map((row) => row.id)).toEqual(["introducer", "quiet"]);
    expect(introPaths(rows, "target").map((row) => row.id)).toEqual(["introducer", "quiet"]);
    expect(introPaths(rows, "board").map((row) => row.id)).toEqual(["introducer"]);
    expect(introPaths(rows, "nobody")).toEqual([]);
  });
});

describe("categories by company", () => {
  test("Customer is Startup's and Clinic is Globex's", () => {
    expect(categoriesFor("us")).toContain("customer");
    expect(categoriesFor("us")).not.toContain("kz_clinic");
    expect(categoriesFor("kz")).toContain("kz_clinic");
    expect(categoriesFor("kz")).not.toContain("customer");
  });

  test("the rest belong to both", () => {
    for (const shared of ["investor", "partner", "advisor", "vendor", "other"] as const) {
      expect(categoryFits(shared, "us")).toBe(true);
      expect(categoryFits(shared, "kz")).toBe(true);
    }
    expect(categoryFits("customer", "kz")).toBe(false);
    expect(categoryFits("kz_clinic", "us")).toBe(false);
  });
});

describe("withNote", () => {
  test("puts the newest note on top, dated", () => {
    expect(withNote(undefined, "  Met at HLTH ", "2026-10-27")).toBe("2026-10-27 — Met at HLTH");
    expect(withNote("2026-10-20 — First call", "Sent the deck", "2026-10-27")).toBe(
      "2026-10-27 — Sent the deck\n\n2026-10-20 — First call",
    );
  });

  test("refuses an empty note and one that overflows the notes", () => {
    expect(() => withNote(undefined, "   ", "2026-10-27")).toThrow(CONTACT_WORDS.noteEmpty);
    expect(() => withNote("x".repeat(4_990), "a long enough note", "2026-10-27")).toThrow(CONTACT_WORDS.noteFull);
  });
});

describe("cleanContactNotes", () => {
  test("keeps line breaks, at most one blank line in a row, and tidies each line", () => {
    expect(cleanContactNotes("  First  line \r\nSecond\u200B line\n\n\n\nThird\t\tline  ")).toBe(
      "First line\nSecond line\n\nThird line",
    );
    expect(cleanContactNotes(" \n \n ")).toBeUndefined();
  });
});
