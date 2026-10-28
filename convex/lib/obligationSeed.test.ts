import { describe, expect, test } from "vitest";
import { MAX_NOTES_LENGTH, MAX_TITLE_LENGTH } from "./limits";
import { OBLIGATION_CATEGORIES } from "./obligationShape";
import { starterItems } from "./obligationSeed";

const items = starterItems("2026-10-12");

describe("starter checklist", () => {
  test("28 items, each with its own key", () => {
    expect(items).toHaveLength(28);
    expect(new Set(items.map((i) => i.seedKey)).size).toBe(28);
  });

  test("every category has something in it, but Globex's ISO 27001 (its own pack)", () => {
    for (const { id } of OBLIGATION_CATEGORIES) {
      if (id === "iso27001") continue;
      expect(items.some((i) => i.category === id), id).toBe(true);
    }
  });

  test("the only date is Delaware's, and it carries its source", () => {
    const dated = items.filter((i) => i.due !== undefined);
    expect(dated.map((i) => i.seedKey)).toEqual(["corp-de-franchise"]);
    expect(dated[0]).toMatchObject({
      due: "2027-03-01",
      recurrence: "annual",
      sourceUrl: "https://corp.delaware.gov/paytaxes/",
    });
  });

  test("nothing without a source has a date or a recurrence", () => {
    // No invented dates, and no invented rhythm either.
    for (const item of items.filter((i) => i.sourceUrl === undefined)) {
      expect(item.due, item.seedKey).toBeUndefined();
      expect(item.recurrence, item.seedKey).toBeUndefined();
    }
  });

  test("every source is an https link", () => {
    for (const item of items.filter((i) => i.sourceUrl !== undefined)) {
      expect(item.sourceUrl, item.seedKey).toMatch(/^https:\/\//);
    }
  });

  test("no item says the company is compliant, certified or covered", () => {
    const words = items.map((i) => `${i.title} ${i.note ?? ""}`).join("\n");
    expect(words).not.toMatch(/\bcompliant\b|\bcertified\b|\bwe are\b|\bis in place\b/i);
  });

  test("titles and notes fit the same caps as anything typed in", () => {
    for (const item of items) {
      expect(item.title.length, item.seedKey).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
      expect((item.note ?? "").length, item.seedKey).toBeLessThanOrEqual(MAX_NOTES_LENGTH);
    }
  });

  test.each([
    ["2026-10-12", "2027-03-01"],
    ["2027-03-01", "2027-03-01"],
    ["2027-03-02", "2028-03-01"],
    ["2027-01-15", "2027-03-01"],
  ])("added on %s, the next March 1 is %s", (today, due) => {
    expect(starterItems(today).find((i) => i.seedKey === "corp-de-franchise")?.due).toBe(due);
  });

  test("no item asks for one obligation per clinic: a title would then name a clinic", () => {
    // Obligation titles are free text. Clinic contract dates live with the
    // clinics, on /customers, and one item points there.
    const clinics = items.filter((item) => item.seedKey === "contract-clinics");
    expect(clinics).toMatchObject([
      {
        seedKey: "contract-clinics",
        category: "contracts",
        title: "Clinic contract renewals: reviewed against the contract dates on the Customers page",
        note: "Each clinic's contract date arrives with the client register and shows in its details on /customers. Keep this as one item: do not add an item per clinic, so that no obligation is titled with a clinic's name.",
      },
    ]);
    // A single item with no date: nothing here is a deadline.
    expect(clinics[0]).not.toHaveProperty("due");
    for (const item of items) {
      expect(`${item.title} ${item.note ?? ""}`, item.seedKey).not.toMatch(
        /as its own item|one item per|an item for each/i,
      );
    }
  });
});
