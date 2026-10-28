import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { MAX_NOTES_LENGTH, MAX_TITLE_LENGTH } from "./lib/limits";
import schema from "./schema";
import { OWNER, modules, signInAsOwner } from "./test.setup";

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const TODAY = "2026-10-12";
type Owner = Awaited<ReturnType<typeof signInAsOwner>>;

const start = async () => {
  const t = convexTest(schema, modules);
  const owner = await signInAsOwner(t);
  return { t, owner };
};
const all = (owner: Owner) => owner.query(api.obligations.list, {});
const only = async (owner: Owner) => (await all(owner))[0]!;
const add = (owner: Owner, extra: Record<string, unknown> = {}) =>
  owner.mutation(api.obligations.create, {
    category: "corporate_tax",
    title: "Delaware annual report and franchise tax",
    ...extra,
  } as never);

describe("obligations.create", () => {
  test("a new item is open, undated, unconfirmed and does not repeat", async () => {
    const { owner } = await start();
    await add(owner, { title: "  Annual board consent  " });
    expect(await only(owner)).toMatchObject({
      category: "corporate_tax",
      title: "Annual board consent",
      due: null,
      dueConfirmed: false,
      recurrence: "none",
      status: "open",
      evidenceUrl: null,
      note: null,
      sourceUrl: null,
      lastDoneAt: null,
    });
  });

  test("a date typed in is unconfirmed until the owner says otherwise", async () => {
    const { owner } = await start();
    await add(owner, { due: "2027-03-01" });
    expect(await only(owner)).toMatchObject({ due: "2027-03-01", dueConfirmed: false });
    await add(owner, { title: "Second", due: "2027-04-15", dueConfirmed: true });
    expect((await all(owner)).find((o) => o.title === "Second")).toMatchObject({
      dueConfirmed: true,
    });
  });

  test("a date cannot be confirmed when there is none", async () => {
    const { owner } = await start();
    await expect(add(owner, { dueConfirmed: true })).rejects.toThrow(
      "A date can be confirmed only once there is one.",
    );
  });

  test.each([
    [{ title: "   " }, "A compliance item needs a title."],
    [{ title: "x".repeat(MAX_TITLE_LENGTH + 1) }, "That title is too long"],
    [{ due: "2027-02-30" }, "The due date is not a date."],
    [{ note: "x".repeat(MAX_NOTES_LENGTH + 1) }, "That note is too long"],
    [{ evidenceUrl: "javascript:alert(1)" }, "An evidence link must be a full https:// address."],
    [{ evidenceUrl: "http://example.com/report.pdf" }, "An evidence link must be a full https:// address."],
  ])("%j is refused", async (extra, message) => {
    const { owner } = await start();
    await expect(add(owner, extra)).rejects.toThrow(message);
    expect(await all(owner)).toEqual([]);
  });

  test("a signed-out caller is refused", async () => {
    const { t } = await start();
    await expect(
      t.mutation(api.obligations.create, { category: "soc2", title: "x" }),
    ).rejects.toThrow("not_allowed");
    await expect(t.query(api.obligations.list, {})).rejects.toThrow("not_allowed");
  });
});

describe("obligations.list", () => {
  test("by category in the fixed order, then by date with undated last, then by title", async () => {
    const { owner } = await start();
    await add(owner, { category: "contracts", title: "Lease" });
    await add(owner, { category: "hipaa", title: "B undated" });
    await add(owner, { category: "hipaa", title: "A undated" });
    await add(owner, { category: "hipaa", title: "Later", due: "2027-06-01" });
    await add(owner, { category: "hipaa", title: "Sooner", due: "2027-01-01" });
    await add(owner, { category: "soc2", title: "Report" });
    expect((await all(owner)).map((o) => o.title)).toEqual([
      "Sooner",
      "Later",
      "A undated",
      "B undated",
      "Report",
      "Lease",
    ]);
  });
});

describe("when an item last changed (the Compliance header's last change)", () => {
  test("made, it is when it was made; edited or finished, when that happened", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 1));
    const { owner } = await start();
    const id = await add(owner, { recurrence: "annual", due: "2026-10-12" });
    const made = (await only(owner)).changedAt;
    expect(made).toBeGreaterThanOrEqual(Date.UTC(2026, 9, 1));
    vi.setSystemTime(Date.UTC(2026, 9, 5));
    await owner.mutation(api.obligations.update, { id, note: "Franchise tax too" });
    expect((await only(owner)).changedAt).toBe(Date.UTC(2026, 9, 5));
    vi.setSystemTime(Date.UTC(2026, 9, 9));
    await owner.mutation(api.obligations.complete, { id, today: TODAY, expectedDue: "2026-10-12" });
    expect((await only(owner)).changedAt).toBe(Date.UTC(2026, 9, 9));
  });
});

describe("obligations.update", () => {
  test("changes the fields given and leaves the rest", async () => {
    const { owner } = await start();
    const id = await add(owner, { due: "2027-03-01", note: "Franchise tax too" });
    await owner.mutation(api.obligations.update, {
      id,
      status: "in_progress",
      evidenceUrl: " https://drive.example.com/receipt ",
      recurrence: "annual",
    });
    expect(await only(owner)).toMatchObject({
      status: "in_progress",
      evidenceUrl: "https://drive.example.com/receipt",
      recurrence: "annual",
      due: "2027-03-01",
      note: "Franchise tax too",
    });
  });

  test("null clears a date, a note and a link; clearing the date unconfirms it", async () => {
    const { owner } = await start();
    const id = await add(owner, {
      due: "2027-03-01",
      dueConfirmed: true,
      note: "n",
      evidenceUrl: "https://example.com/e",
    });
    await owner.mutation(api.obligations.update, { id, due: null, note: null, evidenceUrl: null });
    expect(await only(owner)).toMatchObject({
      due: null,
      dueConfirmed: false,
      note: null,
      evidenceUrl: null,
    });
  });

  test("changing a confirmed date leaves it unconfirmed unless confirmed again", async () => {
    // The confirmation was of the old date.
    const { owner } = await start();
    const id = await add(owner, { due: "2027-03-01", dueConfirmed: true });
    await owner.mutation(api.obligations.update, { id, due: "2027-03-15" });
    expect(await only(owner)).toMatchObject({ due: "2027-03-15", dueConfirmed: false });
    await owner.mutation(api.obligations.update, { id, due: "2027-03-20", dueConfirmed: true });
    expect(await only(owner)).toMatchObject({ due: "2027-03-20", dueConfirmed: true });
    // Saving the same date again does not unconfirm it.
    await owner.mutation(api.obligations.update, { id, due: "2027-03-20" });
    expect((await only(owner)).dueConfirmed).toBe(true);
  });

  test("a date can be confirmed on its own", async () => {
    const { owner } = await start();
    const id = await add(owner, { due: "2027-03-01" });
    await owner.mutation(api.obligations.update, { id, dueConfirmed: true });
    expect((await only(owner)).dueConfirmed).toBe(true);
  });

  test("but not while there is no date", async () => {
    const { owner } = await start();
    const id = await add(owner);
    await expect(
      owner.mutation(api.obligations.update, { id, dueConfirmed: true }),
    ).rejects.toThrow("A date can be confirmed only once there is one.");
  });

  test("done is reached by finishing, not by editing", async () => {
    const { owner } = await start();
    const id = await add(owner);
    await expect(owner.mutation(api.obligations.update, { id, status: "done" })).rejects.toThrow(
      'Use "Mark done" to finish an item: it also schedules the next one.',
    );
  });

  test("a finished item can be reopened", async () => {
    const { owner } = await start();
    const id = await add(owner);
    await owner.mutation(api.obligations.complete, { id, today: TODAY, expectedDue: null });
    await owner.mutation(api.obligations.update, { id, status: "open" });
    expect((await only(owner)).status).toBe("open");
  });

  test("a bad link is refused, and an item that is gone says so", async () => {
    const { owner } = await start();
    const id = await add(owner);
    await expect(
      owner.mutation(api.obligations.update, { id, evidenceUrl: "data:text/html,x" }),
    ).rejects.toThrow("An evidence link must be a full https:// address.");
    await owner.mutation(api.obligations.remove, { id });
    await expect(owner.mutation(api.obligations.update, { id, title: "x" })).rejects.toThrow(
      "That item no longer exists.",
    );
  });
});

describe("obligations.complete", () => {
  test("a one-off item becomes done and keeps its evidence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
    const { owner } = await start();
    const id = await add(owner, { due: "2026-10-20", evidenceUrl: "https://example.com/e" });
    await owner.mutation(api.obligations.complete, { id, today: TODAY, expectedDue: "2026-10-20" });
    expect(await only(owner)).toMatchObject({
      status: "done",
      due: "2026-10-20",
      evidenceUrl: "https://example.com/e",
      lastDoneAt: Date.parse("2026-10-12T10:00:00Z"),
      lastDoneFor: "2026-10-20",
    });
  });

  test("a repeating item rolls to its next date, open again, with the old evidence filed", async () => {
    const { owner } = await start();
    const id = await add(owner, {
      due: "2027-03-01",
      dueConfirmed: true,
      recurrence: "annual",
      evidenceUrl: "https://example.com/2027-receipt",
    });
    await owner.mutation(api.obligations.update, { id, status: "in_progress" });
    await owner.mutation(api.obligations.complete, { id, today: "2027-02-20", expectedDue: "2027-03-01" });
    const next = await only(owner);
    expect(next).toMatchObject({
      status: "open",
      due: "2028-03-01",
      // The date was confirmed and the rule is "every year": it stays confirmed.
      dueConfirmed: true,
      lastDoneFor: "2027-03-01",
      lastEvidenceUrl: "https://example.com/2027-receipt",
      // Next year needs its own proof.
      evidenceUrl: null,
    });
    expect(next.lastDoneAt).toBeTypeOf("number");
  });

  test.each([
    // A yearly or quarterly date is fixed by the calendar the owner already
    // confirmed. A monthly one is not carried over: it arrives unconfirmed.
    ["annual", "2027-03-01", "2028-03-01", true],
    ["quarterly", "2027-03-01", "2027-06-01", true],
    ["monthly", "2027-03-01", "2027-04-01", false],
  ] as const)(
    "a confirmed %s date rolls on to %s → %s, confirmed: %s",
    async (recurrence, due, next, confirmed) => {
      const { owner } = await start();
      const id = await add(owner, { due, dueConfirmed: true, recurrence });
      await owner.mutation(api.obligations.complete, { id, today: "2027-02-20", expectedDue: due });
      expect(await only(owner)).toMatchObject({ status: "open", due: next, dueConfirmed: confirmed });
    },
  );

  test("an unconfirmed date never becomes confirmed by rolling on, whatever the recurrence", async () => {
    for (const recurrence of ["annual", "quarterly", "monthly"] as const) {
      const { owner } = await start();
      const id = await add(owner, { due: "2027-03-01", recurrence });
      await owner.mutation(api.obligations.complete, { id, today: "2027-02-20", expectedDue: "2027-03-01" });
      expect((await only(owner)).dueConfirmed, recurrence).toBe(false);
    }
  });

  test("the list carries the day of the month a repeating date returns to", async () => {
    const { owner } = await start();
    await add(owner, { due: "2026-01-31", dueConfirmed: true, recurrence: "monthly" });
    expect((await only(owner)).anchorDay).toBe(31);
  });

  test("it rolls from the date that was due, not from the day it was finished", async () => {
    // Finished two months late: October's is still outstanding.
    const { owner } = await start();
    const id = await add(owner, { due: "2026-09-15", dueConfirmed: true, recurrence: "monthly" });
    await owner.mutation(api.obligations.complete, { id, today: "2026-11-20", expectedDue: "2026-09-15" });
    expect((await only(owner)).due).toBe("2026-10-15");
  });

  test("a date on the 31st returns to the 31st", async () => {
    const { owner } = await start();
    const id = await add(owner, { due: "2026-01-31", dueConfirmed: true, recurrence: "monthly" });
    await owner.mutation(api.obligations.complete, { id, today: "2026-01-31", expectedDue: "2026-01-31" });
    expect((await only(owner)).due).toBe("2026-02-28");
    await owner.mutation(api.obligations.complete, { id, today: "2026-02-28", expectedDue: "2026-02-28" });
    expect((await only(owner)).due).toBe("2026-03-31");
  });

  test("a repeating item with no date is scheduled from today, unconfirmed", async () => {
    const { owner } = await start();
    const id = await add(owner, { recurrence: "annual" });
    await owner.mutation(api.obligations.complete, { id, today: TODAY, expectedDue: null });
    expect(await only(owner)).toMatchObject({
      status: "open",
      due: "2027-10-12",
      // Nobody chose this date: it is a suggestion until confirmed.
      dueConfirmed: false,
      lastDoneFor: null,
    });
  });

  test("a second click on the same button does not roll the date twice", async () => {
    const { owner } = await start();
    const id = await add(owner, { due: "2027-03-01", dueConfirmed: true, recurrence: "annual" });
    const click = { id, today: "2027-02-20", expectedDue: "2027-03-01" };
    await owner.mutation(api.obligations.complete, click);
    await expect(owner.mutation(api.obligations.complete, click)).resolves.toBeNull();
    expect((await only(owner)).due).toBe("2028-03-01");
  });

  test("finishing a done item again changes nothing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
    const { owner } = await start();
    const id = await add(owner);
    await owner.mutation(api.obligations.complete, { id, today: TODAY, expectedDue: null });
    vi.setSystemTime(new Date("2026-10-13T10:00:00Z"));
    await owner.mutation(api.obligations.complete, { id, today: "2026-10-13", expectedDue: null });
    expect((await only(owner)).lastDoneAt).toBe(Date.parse("2026-10-12T10:00:00Z"));
  });

  test("an item marked not applicable cannot be finished", async () => {
    const { owner } = await start();
    const id = await add(owner);
    await owner.mutation(api.obligations.update, { id, status: "not_applicable" });
    await expect(
      owner.mutation(api.obligations.complete, { id, today: TODAY, expectedDue: null }),
    ).rejects.toThrow("That item is marked not applicable. Reopen it first.");
  });

  test("today must arrive as a date", async () => {
    const { owner } = await start();
    const id = await add(owner);
    await expect(
      owner.mutation(api.obligations.complete, { id, today: "yesterday", expectedDue: null }),
    ).rejects.toThrow("Today's date did not arrive as a date.");
  });
});

describe("obligations.remove", () => {
  test("removes the item; removing it twice is harmless", async () => {
    const { owner } = await start();
    const id = await add(owner);
    await owner.mutation(api.obligations.remove, { id });
    await expect(owner.mutation(api.obligations.remove, { id })).resolves.toBeNull();
    expect(await all(owner)).toEqual([]);
  });

  test("a signed-out caller is refused", async () => {
    const { t, owner } = await start();
    const id = await add(owner);
    await expect(t.mutation(api.obligations.remove, { id })).rejects.toThrow("not_allowed");
    await expect(
      t.mutation(api.obligations.complete, { id, today: TODAY, expectedDue: null }),
    ).rejects.toThrow("not_allowed");
    await expect(t.mutation(api.obligations.update, { id, title: "x" })).rejects.toThrow("not_allowed");
  });
});
