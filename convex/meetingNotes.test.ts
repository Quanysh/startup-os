import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { MEMORY_WORDS } from "./lib/memory";
import schema from "./schema";
import {
  OWNER,
  addMember,
  memberEmail,
  modules,
  signInAsCofounder,
  signInAsOwner,
  signInWithAreas,
} from "./test.setup";

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const base = {
  company: "us" as const,
  kind: "leadership" as const,
  heldOn: "2026-10-07",
  title: "Weekly leadership",
  notes: "We talked about pricing.",
  attendees: [] as string[],
  outsideAttendees: [] as string[],
  actionItems: [] as string[],
};

describe("meeting notes", () => {
  test("are kept cleaned, listed by date, and read whole one at a time", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const id = await owner.mutation(api.meetingNotes.create, {
      ...base,
      notes: "Line one\n\n\n<script>x</script>",
      outsideAttendees: ["Ada Example"],
      attendees: [OWNER],
      actionItems: ["Send the deck", ""],
    });
    await owner.mutation(api.meetingNotes.create, { ...base, heldOn: "2026-10-09", title: "Later" });
    const rows = await owner.query(api.meetingNotes.list, {});
    expect(rows.map((row) => row.title)).toEqual(["Later", "Weekly leadership"]);
    const one = await owner.query(api.meetingNotes.get, { id });
    expect(one).toMatchObject({
      notes: "Line one\n\n<script>x</script>",
      outsideAttendees: ["Ada Example"],
      attendees: [{ email: OWNER }],
      actionItems: [{ text: "Send the deck", taskId: null }],
    });
  });

  test("an outside attendee's address is refused, and not quoted back", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(
      owner.mutation(api.meetingNotes.create, { ...base, outsideAttendees: ["ada@example.test"] }),
    ).rejects.toThrow(MEMORY_WORDS.noAddresses);
  });

  test("a teammate attendee must be on that company", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await addMember(t, { email: "kz.only@gmail.com", role: "engineer", companies: ["kz"] });
    await expect(
      owner.mutation(api.meetingNotes.create, { ...base, attendees: ["kz.only@gmail.com"] }),
    ).rejects.toThrow(MEMORY_WORDS.cannotAttend);
  });

  test("notes over 10,000 characters are refused", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(
      owner.mutation(api.meetingNotes.create, { ...base, notes: "x".repeat(10_001) }),
    ).rejects.toThrow("too long");
  });

  test("an action item goes to the board once, as a card of the meeting's company, and its holder is told", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const cofounder = memberEmail("cofounder");
    await addMember(t, { email: cofounder, role: "cofounder" });
    await t.run((ctx) => ctx.db.insert("users", { email: cofounder, emailVerificationTime: 1 }));
    const id = await owner.mutation(api.meetingNotes.create, { ...base, actionItems: ["Send the deck"] });
    const taskId = await owner.mutation(api.meetingNotes.addActionToBoard, { id, index: 0, assignee: cofounder });
    const task = await t.run((ctx) => ctx.db.get(taskId));
    expect(task).toMatchObject({ title: "Send the deck", company: "us", assignee: cofounder, column: "backlog" });
    const told = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(told.map((row) => row.kind)).toEqual(["assigned"]);
    expect((await owner.query(api.meetingNotes.get, { id })).actionItems[0]!.taskId).toBe(taskId);
    await expect(
      owner.mutation(api.meetingNotes.addActionToBoard, { id, index: 0 }),
    ).rejects.toThrow(MEMORY_WORDS.itemOnBoard);
    await expect(
      owner.mutation(api.meetingNotes.addActionToBoard, { id, index: 5 }),
    ).rejects.toThrow(MEMORY_WORDS.itemGone);
  });

  test("adding to the board needs the board too", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const id = await owner.mutation(api.meetingNotes.create, { ...base, actionItems: ["Send the deck"] });
    const memoryOnly = await signInWithAreas(t, "engineer", ["memory"]);
    await expect(
      memoryOnly.mutation(api.meetingNotes.addActionToBoard, { id, index: 0 }),
    ).rejects.toThrow("not_allowed");
  });

  test("a teammate on Globex alone is sent no Startup meeting and cannot touch one", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const id = await owner.mutation(api.meetingNotes.create, base);
    const kz = await signInAsCofounder(t, ["kz"]);
    expect(await kz.query(api.meetingNotes.list, {})).toEqual([]);
    await expect(kz.query(api.meetingNotes.get, { id })).rejects.toThrow("not_allowed");
    await expect(kz.mutation(api.meetingNotes.update, { id, ...base })).rejects.toThrow("not_allowed");
    await expect(kz.mutation(api.meetingNotes.remove, { id })).rejects.toThrow("not_allowed");
    await expect(kz.mutation(api.meetingNotes.addActionToBoard, { id, index: 0 })).rejects.toThrow("not_allowed");
  });

  test("notes made from one of the owner's Fireflies meetings remember which, for the owner alone", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const id = await owner.mutation(api.meetingNotes.create, { ...base, firefliesId: "ff-owner_1" });
    await owner.mutation(api.meetingNotes.create, { ...base, title: "Typed" });
    const rows = await owner.query(api.meetingNotes.list, {});
    expect(rows.find((row) => row.id === id)?.firefliesId).toBe("ff-owner_1");
    expect(rows.find((row) => row.title === "Typed")?.firefliesId).toBeUndefined();
    // An edit keeps it.
    await owner.mutation(api.meetingNotes.update, { id, ...base, title: "Edited" });
    expect((await owner.query(api.meetingNotes.list, {})).find((row) => row.id === id)?.firefliesId).toBe(
      "ff-owner_1",
    );
    // A teammate with Memory is sent no Fireflies id, and cannot set one: the import is the owner's.
    const cofounder = await signInAsCofounder(t, ["us"]);
    expect((await cofounder.query(api.meetingNotes.list, {})).every((row) => !("firefliesId" in row))).toBe(true);
    await expect(
      cofounder.mutation(api.meetingNotes.create, { ...base, firefliesId: "ff-owner_1" }),
    ).rejects.toThrow("not_allowed");
    // Only an id's shape is kept.
    await expect(
      owner.mutation(api.meetingNotes.create, { ...base, firefliesId: "<b>x</b>" }),
    ).rejects.toThrow(MEMORY_WORDS.importGone);
  });

  test("the owner's Fireflies meetings are offered to import: title and date, then the summary and action items, never a transcript or who was there", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const meeting = (owner?: string) => ({
      kind: "meeting" as const,
      meetingId: owner === undefined ? "ff-owner" : "ff-teammate",
      title: owner === undefined ? "Made-up investor call" : "SECRET teammate call",
      heldAt: Date.UTC(2026, 9, 6, 15),
      durationMinutes: 30,
      participants: [{ name: "Ada Example", address: "ada@example.test" }],
      overview: "We agreed on a pilot.",
      actionItems: ["Send the pilot terms"],
    });
    const cofounder = memberEmail("cofounder");
    const teammate = await signInWithAreas(t, "cofounder", ["memory", "today"]);
    await t.run(async (ctx) => {
      const userId = (await ctx.db.query("users").withIndex("email", (q) => q.eq("email", cofounder)).first())!._id;
      await ctx.db.insert("mirrorRecords", {
        source: "fireflies",
        externalId: "ff-owner",
        sortAt: Date.UTC(2026, 9, 6, 15),
        syncedAt: 1,
        record: meeting(),
      });
      await ctx.db.insert("mirrorRecords", {
        owner: cofounder,
        userId,
        source: "fireflies",
        externalId: "ff-teammate",
        sortAt: Date.UTC(2026, 9, 6, 15),
        syncedAt: 1,
        record: meeting(cofounder),
      });
    });
    const offered = await owner.query(api.workTools.importableMeetings, {});
    expect(offered).toEqual([{ meetingId: "ff-owner", title: "Made-up investor call", heldAt: Date.UTC(2026, 9, 6, 15) }]);
    const draft = await owner.query(api.workTools.meetingToImport, { meetingId: "ff-owner" });
    expect(draft).toEqual({
      title: "Made-up investor call",
      heldOn: "2026-10-06",
      notes: "We agreed on a pilot.",
      actionItems: ["Send the pilot terms"],
    });
    expect(JSON.stringify(draft)).not.toContain("ada@example.test");
    // Nothing is saved until the owner saves.
    expect(await owner.query(api.meetingNotes.list, {})).toEqual([]);
    await expect(owner.query(api.workTools.meetingToImport, { meetingId: "ff-teammate" })).rejects.toThrow(
      MEMORY_WORDS.importGone,
    );
    // A teammate with the memory page is offered none of it.
    await expect(teammate.query(api.workTools.importableMeetings, {})).rejects.toThrow("not_owner");
    await expect(teammate.query(api.workTools.meetingToImport, { meetingId: "ff-owner" })).rejects.toThrow(
      "not_owner",
    );
  });

  test("an edit keeps the cards already made for items still there", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const id = await owner.mutation(api.meetingNotes.create, { ...base, actionItems: ["Send the deck"] });
    const taskId = await owner.mutation(api.meetingNotes.addActionToBoard, { id, index: 0 });
    await owner.mutation(api.meetingNotes.update, { id, ...base, actionItems: ["Send the deck", "Call Ada"] });
    const one = await owner.query(api.meetingNotes.get, { id });
    expect(one.actionItems).toEqual([
      { text: "Send the deck", taskId },
      { text: "Call Ada", taskId: null },
    ]);
  });
});
