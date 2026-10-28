import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { ISO_CONTROLS, ISO_DUTIES, ISO_FINDINGS, ISO_ITEMS } from "./lib/isoPack";
import { MAX_NOTES_LENGTH, MAX_TITLE_LENGTH } from "./lib/limits";
import { isCanonicalPeriodStart } from "./lib/periods";
import schema from "./schema";
import { OWNER, modules, signInAsCofounder, signInAsOwner } from "./test.setup";

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the ISO 27001 pack", () => {
  test("every item is Globex's ISO category, keyed once, within the limits", () => {
    const keys = ISO_ITEMS.map((i) => i.seedKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const item of ISO_ITEMS) {
      expect(item.seedKey).toMatch(/^iso-/);
      expect(item.category).toBe("iso27001");
      expect(item.title.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
      expect(item.note.length).toBeLessThanOrEqual(MAX_NOTES_LENGTH);
      if (item.due !== undefined) expect(isCanonicalPeriodStart("day", item.due)).toBe(true);
    }
  });

  test("every recurring duty repeats, and every finding does not", () => {
    expect(ISO_DUTIES.every((d) => d.recurrence !== undefined && d.recurrence !== "none")).toBe(true);
    expect(ISO_FINDINGS.every((f) => f.recurrence === undefined)).toBe(true);
  });

  test("no item says the company meets the standard, and none names a person", () => {
    const words = ISO_ITEMS.map((i) => `${i.title} ${i.note}`).join(" ");
    expect(words).not.toMatch(/\bcompliant\b|\bcompliance\b|\bcertified\b|\bcovered\b|\bwe are\b|\bis in place\b/i);
    // Roles only: the documents name who holds each. No surname, in Latin or Cyrillic.
    expect(words).not.toMatch(/\b\p{Lu}\p{Ll}+(?:ov|ova|ev|eva|in|ina|uly|kyzy)\b/u);
    expect(words).not.toMatch(/\p{Lu}\p{Ll}+(?:ов|ова|ев|ева|ин|ина|ұлы|қызы)(?!\p{L})/u);
  });

  test("84 applicable controls, each once, the excluded ones left out", () => {
    const ids = ISO_CONTROLS.map((c) => c.controlId);
    expect(ids).toHaveLength(84);
    expect(new Set(ids).size).toBe(84);
    for (const excluded of ["A.7.1", "A.7.2", "A.7.3", "A.7.4", "A.7.5", "A.7.6", "A.7.11", "A.7.12", "A.8.30"]) {
      expect(ids).not.toContain(excluded);
    }
  });
});

describe("isoPack.add", () => {
  test("adds the items open and unconfirmed, and the controls with their evidence missing", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    expect(await owner.mutation(api.isoPack.add, {})).toEqual({ items: ISO_ITEMS.length, controls: 84 });

    const rows = (await owner.query(api.obligations.list, {})).filter((o) => o.category === "iso27001");
    expect(rows).toHaveLength(ISO_ITEMS.length);
    expect(rows.every((o) => o.status === "open" && !o.dueConfirmed)).toBe(true);
    // Each row as its item has it: its date (if the pack fixes one) and its rhythm, unconfirmed.
    const review = ISO_ITEMS.find((i) => i.title.startsWith("Management review of"))!;
    expect(rows.find((o) => o.title === review.title)).toMatchObject({
      due: review.due ?? null,
      recurrence: review.recurrence,
      dueConfirmed: false,
    });

    const controls = (await owner.query(api.evidence.controls, {})).filter((c) => c.framework === "iso27001");
    expect(controls).toHaveLength(84);
    const backup = controls.find((c) => c.controlId === "A.8.13")!;
    expect(backup.items.map((i) => i.status)).toEqual(["missing", "missing"]);
    // Nothing is counted as evidenced: every item is still to find.
    expect(controls.every((c) => c.items.every((i) => i.status === "missing"))).toBe(true);
  });

  test("adding it twice adds nothing and leaves edits alone", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.isoPack.add, {});
    const first = (await owner.query(api.obligations.list, {})).find((o) => o.category === "iso27001")!;
    await owner.mutation(api.obligations.update, { id: first.id, title: "Renamed by the owner" });
    expect(await owner.mutation(api.isoPack.add, {})).toEqual({ items: 0, controls: 0 });
    const titles = (await owner.query(api.obligations.list, {})).map((o) => o.title);
    expect(titles).toContain("Renamed by the owner");
  });

  test("someone on Startup alone is refused, and sees none of it", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.isoPack.add, {});
    const startup = await signInAsCofounder(t, ["us"]);
    await expect(startup.mutation(api.isoPack.add, {})).rejects.toThrow("not_allowed");
    expect((await startup.query(api.obligations.list, {})).some((o) => o.category === "iso27001")).toBe(false);
    expect((await startup.query(api.evidence.controls, {})).some((c) => c.framework === "iso27001")).toBe(false);
  });

  test("someone on Globex alone sees it, and none of HIPAA or SOC 2", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.starterChecklist.add, { today: "2026-10-19" });
    await owner.mutation(api.isoPack.add, {});
    const globex = await signInAsCofounder(t, ["kz"]);
    const categories = new Set((await globex.query(api.obligations.list, {})).map((o) => o.category));
    expect(categories.has("iso27001")).toBe(true);
    expect(categories.has("hipaa") || categories.has("soc2")).toBe(false);
  });
});
