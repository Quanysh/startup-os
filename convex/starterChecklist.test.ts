import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { OWNER, modules, signInAsOwner } from "./test.setup";

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const TODAY = "2026-10-12";

describe("starterChecklist.add", () => {
  test("adds every item, open and unconfirmed, with no date except the one fixed by law", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    expect(await owner.mutation(api.starterChecklist.add, { today: TODAY })).toEqual({ added: 28 });
    const rows = await owner.query(api.obligations.list, {});
    expect(rows).toHaveLength(28);
    expect(rows.every((o) => o.status === "open" && o.evidenceUrl === null)).toBe(true);
    const dated = rows.filter((o) => o.due !== null);
    expect(dated).toHaveLength(1);
    expect(dated[0]).toMatchObject({
      title: "Delaware annual report and franchise tax",
      due: "2027-03-01",
      // The date is Delaware's, from the page the item links to. Whether it
      // applies to this company is the owner's to confirm.
      dueConfirmed: false,
      recurrence: "annual",
      sourceUrl: "https://corp.delaware.gov/paytaxes/",
    });
    // Nothing the checklist adds is a deadline until the owner says so.
    expect(rows.every((o) => !o.dueConfirmed)).toBe(true);
  });

  test("adding it twice adds nothing, and leaves the owner's edits alone", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.starterChecklist.add, { today: TODAY });
    const first = (await owner.query(api.obligations.list, {}))[0]!;
    await owner.mutation(api.obligations.update, { id: first.id, title: "Renamed by the owner" });
    expect(await owner.mutation(api.starterChecklist.add, { today: TODAY })).toEqual({ added: 0 });
    const rows = await owner.query(api.obligations.list, {});
    expect(rows).toHaveLength(28);
    expect(rows.some((o) => o.title === "Renamed by the owner")).toBe(true);
  });

  test("an item the owner deleted comes back only if they ask for the list again", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.starterChecklist.add, { today: TODAY });
    const first = (await owner.query(api.obligations.list, {}))[0]!;
    await owner.mutation(api.obligations.remove, { id: first.id });
    expect(await owner.query(api.obligations.list, {})).toHaveLength(27);
    expect(await owner.mutation(api.starterChecklist.add, { today: TODAY })).toEqual({ added: 1 });
  });

  test("today must be a date, and a signed-out caller is refused", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(owner.mutation(api.starterChecklist.add, { today: "soon" })).rejects.toThrow(
      "Today's date did not arrive as a date.",
    );
    await expect(t.mutation(api.starterChecklist.add, { today: TODAY })).rejects.toThrow("not_allowed");
  });
});
