import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { PERSON_DUPLICATE_REASONS, TASK_DUPLICATE_WORDS } from "./tasks";
import { OWNER, modules, signInAsEngineer, signInAsOwner, type TestBackend } from "./test.setup";

// A person adding a card near an open one (convex/lib/duplicates.ts) is
// warned and may add it anyway; nobody is refused. Bots keep the refusal
// (convex/mcpTools.test.ts). Every title here is made up.

const NOW = Date.UTC(2026, 9, 20, 12);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const seed = (t: TestBackend, title: string, company?: "us" | "kz") =>
  t.run((ctx) => ctx.db.insert("tasks", { title, kind: "task", column: "backlog", order: 0, ...(company ? { company } : null) }));
const tasks = (t: TestBackend) => t.run((ctx) => ctx.db.query("tasks").collect());

/** What a coded warning carries, or null for any other outcome. */
async function warning(run: Promise<unknown>) {
  try {
    await run;
    return null;
  } catch (error) {
    if (!(error instanceof ConvexError)) throw error;
    // convex-test hands the data on as its JSON; a client gets it parsed.
    const data: unknown = typeof error.data === "string" ? JSON.parse(error.data) : error.data;
    return data as { words: string; refusal: { code: string; matches: { id: string; title: string }[] } };
  }
}

describe("the board's add form", () => {
  test("asked to warn, a near card is not added: the warning names the open card", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const open = await seed(t, "Send the pilot contract to the clinic", "us");
    const said = await warning(
      owner.mutation(api.tasks.create, { title: "Send pilot contract to clinic", company: "us", duplicates: "warn" }),
    );
    expect(said).toEqual({
      words: TASK_DUPLICATE_WORDS.possible,
      refusal: { code: "possible_duplicate", matches: [{ id: open, title: "Send the pilot contract to the clinic" }] },
    });
    expect(await tasks(t)).toHaveLength(1);
  });

  test("confirmed, it is added, marked as past the warning", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const open = await seed(t, "Send the pilot contract to the clinic", "us");
    const id = await owner.mutation(api.tasks.create, { title: "Send pilot contract to clinic", company: "us", duplicates: "confirmed" });
    const card = (await tasks(t)).find((row) => row._id === id);
    expect(card).toMatchObject({ duplicateOf: [open], forceReason: PERSON_DUPLICATE_REASONS.board });
  });

  test("nothing near: added at once, unmarked", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await seed(t, "Renew the domain", "us");
    const id = await owner.mutation(api.tasks.create, { title: "Hire a designer", company: "us", duplicates: "warn" });
    expect((await tasks(t)).find((row) => row._id === id)?.duplicateOf).toBeUndefined();
  });

  test("a card of a company the caller is not on is never named, and does not warn them", async () => {
    const t = convexTest(schema, modules);
    await signInAsOwner(t);
    const engineer = await signInAsEngineer(t, ["kz"]);
    await seed(t, "Send the pilot contract to the clinic", "us");
    expect(await warning(engineer.mutation(api.tasks.create, { title: "Send the pilot contract to the clinic", duplicates: "warn" }))).toBeNull();
  });
});

describe("Memory's Add to board", () => {
  test("warns as the board does, and adds once confirmed", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const open = await seed(t, "Draft the partner agreement", "us");
    const id: Id<"meetingNotes"> = await owner.mutation(api.meetingNotes.create, {
      company: "us",
      kind: "leadership",
      heldOn: "2026-10-20",
      title: "Weekly",
      notes: "",
      attendees: [],
      outsideAttendees: [],
      actionItems: ["Draft the partner agreement"],
    });
    const said = await warning(owner.mutation(api.meetingNotes.addActionToBoard, { id, index: 0, duplicates: "warn" }));
    expect(said?.refusal.matches).toEqual([{ id: open, title: "Draft the partner agreement" }]);
    const taskId = await owner.mutation(api.meetingNotes.addActionToBoard, { id, index: 0, duplicates: "confirmed" });
    expect((await tasks(t)).find((row) => row._id === taskId)).toMatchObject({
      duplicateOf: [open],
      forceReason: PERSON_DUPLICATE_REASONS.memory,
    });
  });
});

describe("Suggest a change", () => {
  test("is never warned (the sender may not read the board): the card is added and marked", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const open = await seed(t, "The goals page should show last quarter");
    await owner.mutation(api.suggestions.create, { text: "The goals page should show last quarter" });
    const made = (await tasks(t)).find((row) => row.origin?.source === "suggestion");
    expect(made).toMatchObject({ duplicateOf: [open], forceReason: PERSON_DUPLICATE_REASONS.suggestion });
  });
});
