import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { PROPOSAL_WORDS } from "./lib/agents";
import { AGENT_TEXT_CUT } from "./lib/memory";
import { GITHUB_TOKEN, NOW, call, ownerWithToken, seed } from "./mcp.kit";
import schema from "./schema";
import { OWNER, modules, type TestBackend } from "./test.setup";

// Company memory as the owner's agents see it: the `decisions` and `meetings`
// read tools, bounded, with no attendee text; and the `decision_record`
// proposal, which only the owner's approval turns into a decision.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
  vi.stubEnv("INGEST_TOKEN_GITHUB", GITHUB_TOKEN);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const OUTSIDE = "Outside Person Example";

async function world() {
  const t = convexTest(schema, modules);
  await seed(t);
  const { owner, token } = await ownerWithToken(t, "act");
  const meeting = await owner.mutation(api.meetingNotes.create, {
    company: "us",
    kind: "investor",
    heldOn: "2026-10-07",
    title: "Example investor call",
    notes: "n".repeat(AGENT_TEXT_CUT + 300),
    attendees: [OWNER],
    outsideAttendees: [OUTSIDE],
    actionItems: ["Send the example deck"],
  });
  const kzMeeting = await owner.mutation(api.meetingNotes.create, {
    company: "kz",
    kind: "leadership",
    heldOn: "2026-10-08",
    title: "Example kz meeting",
    notes: "",
    attendees: [],
    outsideAttendees: [],
    actionItems: [],
  });
  await owner.mutation(api.decisions.create, {
    company: "us",
    title: "Example decision",
    decision: "d".repeat(900),
    context: "Example context",
    owner: OWNER,
    decidedOn: "2026-10-07",
    status: "decided",
    revisitOn: "2026-10-20",
    meetingId: meeting,
  });
  return { t, owner, token, meeting, kzMeeting };
}

const propose = (t: TestBackend, token: string, payload: Record<string, unknown>, company = "us", key = "chief_of_staff:decision_record:example") =>
  call(t, token, "propose", {
    agent: "chief_of_staff",
    company,
    kind: "decision_record",
    reason: "The meeting notes say this was decided.",
    dedupeKey: key,
    payload,
  });

describe("the memory read tools", () => {
  test("decisions: the app's rows, each text cut to 500 characters", async () => {
    const { t, token } = await world();
    const reply = await call(t, token, "decisions", { company: "us" });
    const rows = reply.output.rows as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: "Example decision",
      context: "Example context",
      owner: OWNER,
      status: "decided",
      decidedOn: "2026-10-07",
      revisitOn: "2026-10-20",
    });
    expect((rows[0]!.decision as string).length).toBe(AGENT_TEXT_CUT);
    expect((await call(t, token, "decisions", { company: "kz" })).output.rows).toEqual([]);
  });

  test("meetings: titles, dates, cut notes and action items, and no attendee of any kind", async () => {
    const { t, token } = await world();
    const reply = await call(t, token, "meetings", {});
    const rows = reply.output.rows as Record<string, unknown>[];
    expect(rows.map((row) => row.title)).toEqual(["Example kz meeting", "Example investor call"]);
    const us = rows[1]!;
    expect((us.notes as string).length).toBe(AGENT_TEXT_CUT);
    expect(us.actionItems).toEqual([{ text: "Send the example deck", onBoard: false }]);
    expect(us.decisions).toEqual(["Example decision"]);
    expect(reply.text).not.toContain(OUTSIDE);
    expect(reply.text).not.toContain(OWNER);
    expect(Object.keys(us).sort()).toEqual(
      ["actionItems", "company", "decisions", "heldOn", "id", "kind", "notes", "title"].sort(),
    );
  });
});

describe("decision_record", () => {
  test("proposing stores nothing but the proposal; approving records the decision, decided, as the agent's", async () => {
    const { t, owner, token, meeting } = await world();
    const made = await propose(t, token, {
      title: "Example: hire a second engineer",
      decision: "We hire a second engineer in Q1.",
      context: "From the investor call.",
      ownerEmail: OWNER,
      revisitOn: "2027-01-15",
      meetingId: meeting,
    });
    expect(made.isError).toBe(false);
    const before = await owner.query(api.decisions.list, { company: "us" });
    expect(before.map((row) => row.title)).toEqual(["Example decision"]);
    const result = await owner.mutation(api.assistant.approve, { id: made.output.id as Id<"proposals"> });
    expect(result).toHaveProperty("decisionId");
    const after = await owner.query(api.decisions.list, { company: "us" });
    const recorded = after.find((row) => row.title === "Example: hire a second engineer");
    expect(recorded).toMatchObject({
      status: "decided",
      decision: "We hire a second engineer in Q1.",
      context: "From the investor call.",
      revisitOn: "2027-01-15",
      meetingId: meeting,
      byAgent: "chief_of_staff",
      decidedOn: "2026-10-14",
      owner: { email: OWNER },
    });
  });

  test("a meeting of the other company, an owner who cannot own it, or a stray field is refused", async () => {
    const { t, token, kzMeeting } = await world();
    const base = { title: "Example", decision: "Example decided." };
    expect((await propose(t, token, { ...base, meetingId: kzMeeting })).said).toBe(PROPOSAL_WORDS.meetingElsewhere);
    expect((await propose(t, token, { ...base, ownerEmail: "nobody@example.test" })).said).toBe(
      PROPOSAL_WORDS.cannotOwn,
    );
    expect((await propose(t, token, { ...base, body: "x" })).isError).toBe(true);
    expect((await propose(t, token, { ...base, revisitOn: "soon" })).isError).toBe(true);
  });

  test("the same key twice is a repeat", async () => {
    const { t, token } = await world();
    const base = { title: "Example", decision: "Example decided." };
    expect((await propose(t, token, base)).isError).toBe(false);
    expect((await propose(t, token, base)).said).toBe(PROPOSAL_WORDS.repeatOpen);
  });
});

describe("note_create and decision_create", () => {
  test("note_create adds the note the /memory page would, and answers with its id", async () => {
    const { t, owner, token } = await world();
    const reply = await call(t, token, "note_create", {
      company: "kz",
      kind: "customer",
      heldOn: "2026-10-12",
      title: "  Example clinic call ",
      notes: "Line one.\nLine two.",
      actionItems: ["Send the example quote", "  "],
    });
    expect(reply.isError).toBe(false);
    expect(reply.output).toMatchObject({ created: true, truncated: false });
    const row = await t.run((ctx) => ctx.db.get(reply.output.id));
    expect(row).toMatchObject({
      company: "kz",
      kind: "customer",
      heldOn: "2026-10-12",
      title: "Example clinic call",
      notes: "Line one.\nLine two.",
      attendees: [],
      outsideAttendees: [],
      actionItems: [{ text: "Send the example quote" }],
    });
    const listed = await owner.query(api.meetingNotes.list, {});
    expect(listed.map((m) => m.id)).toContain(reply.output.id);
  });

  test("note_create is held to the page's limits and rejects stray fields", async () => {
    const { t, token } = await world();
    const ok = { company: "us", kind: "board", heldOn: "2026-10-12", title: "Example", notes: "x" };
    expect((await call(t, token, "note_create", { ...ok, notes: "n".repeat(10_001) })).isError).toBe(true);
    expect((await call(t, token, "note_create", { ...ok, heldOn: "2026-02-31" })).isError).toBe(true);
    expect((await call(t, token, "note_create", { ...ok, title: "   " })).isError).toBe(true);
    expect((await call(t, token, "note_create", { ...ok, kind: "party" })).isError).toBe(true);
    expect((await call(t, token, "note_create", { ...ok, attendees: ["a@example.test"] })).isError).toBe(true);
    expect((await call(t, token, "note_create", { ...ok, actionItems: Array(31).fill("x") })).isError).toBe(true);
  });

  test("decision_create records a decision as the page does, defaulting to decided today", async () => {
    const { t, owner, token } = await world();
    const reply = await call(t, token, "decision_create", {
      company: "us",
      title: " Example pricing ",
      decision: "Keep the example price.",
      context: "Because example.",
      revisitOn: "2027-01-05",
      tags: ["Pricing", "pricing", "q1"],
    });
    expect(reply.isError).toBe(false);
    expect(reply.output).toMatchObject({ created: true });
    const row = await t.run((ctx) => ctx.db.get(reply.output.id));
    expect(row).toMatchObject({
      company: "us",
      title: "Example pricing",
      decision: "Keep the example price.",
      context: "Because example.",
      status: "decided",
      decidedOn: new Date(NOW).toISOString().slice(0, 10),
      revisitOn: "2027-01-05",
      tags: ["pricing", "q1"],
    });
    const listed = await owner.query(api.decisions.list, {});
    expect(listed.map((d) => d.id)).toContain(reply.output.id);
  });

  test("decision_create is held to the page's limits", async () => {
    const { t, token } = await world();
    const ok = { company: "us", title: "Example", decision: "Example decided." };
    expect((await call(t, token, "decision_create", { ...ok, decision: "d".repeat(1_001) })).isError).toBe(true);
    expect((await call(t, token, "decision_create", { ...ok, context: "c".repeat(2_001) })).isError).toBe(true);
    expect((await call(t, token, "decision_create", { ...ok, tags: Array(9).fill("t") })).isError).toBe(true);
    expect((await call(t, token, "decision_create", { ...ok, status: "maybe" })).isError).toBe(true);
    expect((await call(t, token, "decision_create", { ...ok, revisitOn: "soon" })).isError).toBe(true);
    expect((await call(t, token, "decision_create", { ...ok, ownerEmail: "a@example.test" })).isError).toBe(true);
  });

  test("a read-only token is refused both, and writes nothing", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const { token } = await ownerWithToken(t, "read");
    const before = await t.run(async (ctx) => (await ctx.db.query("decisions").collect()).length);
    const note = await call(t, token, "note_create", { company: "us", kind: "board", heldOn: "2026-10-12", title: "x", notes: "x" });
    const decision = await call(t, token, "decision_create", { company: "us", title: "x", decision: "x" });
    expect(note.isError).toBe(true);
    expect(decision.isError).toBe(true);
    expect(await t.run(async (ctx) => (await ctx.db.query("decisions").collect()).length)).toBe(before);
    expect(await t.run(async (ctx) => (await ctx.db.query("meetingNotes").collect()).length)).toBe(0);
  });
});
