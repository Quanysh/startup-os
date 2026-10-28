import { describe, expect, test } from "vitest";
import { presentIntel } from "@convex/lib/dealIntel";
import {
  EMPTY_DRAFT,
  draftOf,
  editOf,
  initialsOf,
  researchedLabel,
  signalDateLabel,
} from "./intel-view";

describe("initialsOf", () => {
  test.each([
    ["Dr. Robin Sample", "RS"],
    ["Pat Example", "PE"],
    ["Jo", "J"],
    ["  maria  de la Cruz ", "MC"],
    ["Prof Alex Placeholder-Smith", "AP"],
    ["Dr.", "?"],
    ["Élodie Mock", "ÉM"],
  ])("%s → %s", (name, initials) => expect(initialsOf(name)).toBe(initials));
});

describe("dates", () => {
  test("a signal's month or day, with its year", () => {
    expect(signalDateLabel("2026-09")).toBe("Sep 2026");
    expect(signalDateLabel("2026-09-02")).toBe("Sep 2, 2026");
    expect(signalDateLabel(undefined)).toBeNull();
  });

  test("the day research was done", () => {
    expect(researchedLabel("2026-10-01")).toBe("Researched Oct 1, 2026");
  });
});

const BASE = presentIntel({
  summary: "Made-up summary",
  ehr: "athenahealth",
  billingModel: "outsourced",
  specialties: ["Spine", "Hand"],
  competitors: [{ name: "Made-up RCM" }],
  signals: [{ date: "2026-09", kind: "hiring", text: "Made-up", source: "Made-up board" }],
  people: [{ name: "Pat Example", role: "Administrator", note: "Made-up" }],
  fit: { score: 80, reasons: ["Large"] },
  sources: [{ title: "Made-up scan", url: "https://claude.ai/artifact/made-up-1" }],
  updatedAt: 1,
});

describe("the editor's draft", () => {
  test("is the intelligence as text, and nothing when there is none", () => {
    expect(draftOf(null)).toEqual(EMPTY_DRAFT);
    const draft = draftOf(BASE);
    expect(draft).toMatchObject({
      summary: "Made-up summary",
      ehr: "athenahealth",
      billingModel: "outsourced",
      specialties: "Spine\nHand",
      fitScore: "80",
      fitReasons: "Large",
      competitors: [{ name: "Made-up RCM", note: "" }],
      signals: [{ date: "2026-09", kind: "hiring", text: "Made-up", source: "Made-up board" }],
      people: [{ name: "Pat Example", role: "Administrator", note: "Made-up" }],
      sources: [{ title: "Made-up scan", url: "https://claude.ai/artifact/made-up-1" }],
      angle: "",
    });
  });

  test("an untouched draft sends nothing", () => {
    expect(editOf(draftOf(BASE), draftOf(BASE))).toEqual({});
    expect(editOf(EMPTY_DRAFT, EMPTY_DRAFT)).toEqual({});
  });

  test("sends only what changed: text, lists, rows and the fit, and null for what was emptied", () => {
    const base = draftOf(BASE);
    const draft = {
      ...base,
      summary: "",
      angle: "Made-up angle",
      specialties: "Spine\n\n Hand \nSports",
      competitors: [...base.competitors, { name: " ", note: " " }],
      people: [],
      fitScore: "85",
      sources: [{ title: "Made-up scan", url: "https://claude.ai/artifact/made-up-2" }],
    };
    expect(editOf(draft, base)).toEqual({
      summary: null,
      angle: "Made-up angle",
      specialties: ["Spine", "Hand", "Sports"],
      people: null,
      fit: { score: 85, reasons: ["Large"] },
      sources: [{ title: "Made-up scan", url: "https://claude.ai/artifact/made-up-2" }],
    });
  });

  test("a fit score left blank clears the fit; one that is not a number is sent for the check to refuse", () => {
    const base = draftOf(BASE);
    expect(editOf({ ...base, fitScore: " " }, base)).toEqual({ fit: null });
    expect(editOf({ ...base, fitScore: "high" }, base).fit!.score).toBeNaN();
  });

  test("a signal's blank date is none", () => {
    const base = draftOf(BASE);
    const signals = [{ date: " ", kind: "news", text: "Made-up", source: "Made-up" }];
    expect(editOf({ ...base, signals }, base).signals).toEqual([
      { date: null, kind: "news", text: "Made-up", source: "Made-up" },
    ]);
  });
});
