import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { MAX_IMPORT_ROWS } from "./lib/limits";
import schema from "./schema";
import { OWNER, modules, signInAsOwner } from "./test.setup";

// `deals.importProspects`: a prospect list loaded onto the US board in one
// go. Internal (run by `pnpm import:prospects`, never by the browser), and
// held to the same cleaning as a deal typed in, with refusals that name a row
// by its place in the list and never by what it holds.

const AT = Date.parse("2026-10-15T09:00:00Z");
const NO_CONTACT =
  "Leave email addresses and phone numbers out: the only person a deal names is its contact, by name.";

type Row = {
  name: string;
  contact?: string;
  stage: string;
  nextStep?: string;
  notes?: string;
  priority?: string;
  region?: string;
  physicians?: number;
  locations?: number;
  sources?: string[];
};
const run = (t: ReturnType<typeof convexTest>, rows: Row[], market: "us" | "kz" = "us") =>
  t.mutation(internal.deals.importProspects, { market, rows: rows as never });

const lead = (name: string, extra: Partial<Row> = {}): Row => ({ name, stage: "lead", ...extra });

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
  vi.useFakeTimers();
  vi.setSystemTime(AT);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("deals.importProspects", () => {
  test("adds each row as a deal made here, at the end of its stage, with its details", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.deals.create, { market: "us", name: "Austin Vertical" });

    expect(
      await run(t, [
        lead("Boise Vertical", {
          contact: "Dr. Casey Placeholder",
          nextStep: "Ask for a demo",
          notes: "Made-up research: 59 physicians, uses athenahealth.",
          priority: "high",
          region: "ID",
          physicians: 59,
          locations: 29,
          sources: ["Made-up market scan", "Sample list"],
        }),
        { name: "Cleveland Vertical", stage: "qualified", priority: "low" },
        lead("Denver Vertical"),
      ]),
    ).toEqual({ added: 3, skipped: 0 });

    const board = await owner.query(api.deals.board, { market: "us" });
    expect(board.lead.map((d) => d.name)).toEqual(["Austin Vertical", "Boise Vertical", "Denver Vertical"]);
    expect(board.qualified.map((d) => d.name)).toEqual(["Cleveland Vertical"]);
    expect(board.lead[1]).toMatchObject({
      mirrored: false,
      source: "manual",
      contact: "Dr. Casey Placeholder",
      nextStep: "Ask for a demo",
      notes: "Made-up research: 59 physicians, uses athenahealth.",
      priority: "high",
      region: "ID",
      physicians: 59,
      locations: 29,
      sources: ["Made-up market scan", "Sample list"],
      lastActivityAt: AT,
      closedAt: null,
      amount: null,
    });
    const stored = await t.run((ctx) => ctx.db.query("deals").collect());
    for (const deal of stored) expect(deal.externalId).toBe(deal._id);
    // Each stage's order runs on from the cards already there.
    const orders = stored.filter((d) => d.stage === "lead").map((d) => d.order);
    expect(orders).toEqual([0, 1, 2]);
  });

  test("skips a name already on the US board, whatever its capitals, and a repeat in the list", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.deals.create, { market: "us", name: "Austin Vertical" });
    const archived = await owner.mutation(api.deals.create, { market: "us", name: "Boise Vertical" });
    await owner.mutation(api.deals.archive, { id: archived });
    // The same name in Kazakhstan is another clinic.
    await t.run((ctx) =>
      ctx.db.insert("deals", {
        source: "kz_crm",
        externalId: "crm-1",
        market: "kz",
        name: "Cleveland Vertical",
        stage: "lead",
        order: 0,
      }),
    );

    expect(
      await run(t, [
        lead("  austin   VERTICAL "),
        lead("BOISE VERTICAL"),
        lead("Cleveland Vertical"),
        lead("cleveland vertical"),
      ]),
    ).toEqual({ added: 1, skipped: 3 });
    const names = (await owner.query(api.deals.board, { market: "us" })).lead.map((d) => d.name);
    expect(names).toEqual(["Austin Vertical", "Cleveland Vertical"]);
    // Run again: nothing new.
    expect(await run(t, [lead("Cleveland Vertical")])).toEqual({ added: 0, skipped: 1 });
  });

  test.each([
    ["contact", { contact: "jo@example.test" }],
    ["contact", { contact: "Jo Sample (555) 123-4567" }],
    ["notes", { notes: "Front desk: +1 555 123 4567" }],
    ["notes", { notes: "Write to office.manager@example-clinic.test for pricing" }],
    ["next step", { nextStep: "Call 555.123.4567" }],
    ["name", { name: "SECRET Clinic 555-123-4567" }],
  ])("refuses an address or a phone number in the %s, naming the row and nothing else", async (_field, extra) => {
    const t = convexTest(schema, modules);
    const error = await run(t, [lead("Austin Vertical"), lead("SECRET Clinic", extra)]).then(
      () => null,
      (e: Error) => e,
    );
    expect(error?.message).toContain(`Row 2: ${NO_CONTACT}`);
    expect(error?.message).not.toMatch(/SECRET|555|example/);
    // A refusal anywhere writes nothing at all.
    expect(await t.run((ctx) => ctx.db.query("deals").collect())).toEqual([]);
  });

  test.each([
    ["a later stage", { stage: "demo" }, "Row 1: An imported deal starts as a lead or qualified."],
    ["a blank name", { name: "  " }, "Row 1: A deal needs a company name."],
    ["a long name", { name: "x".repeat(121) }, "Row 1: That name is too long (120 characters at most)."],
    ["another priority", { priority: "urgent" }, "Row 1: A priority is high, medium or low."],
    [
      "a negative count",
      { physicians: -3 },
      "Row 1: The number of physicians must be a whole number the OS can store.",
    ],
    ["a long region", { region: "x".repeat(41) }, "Row 1: That region is too long (40 characters at most)."],
    ["long notes", { notes: "x".repeat(5_001) }, "Row 1: That note is too long (5000 characters at most)."],
  ])("refuses a row the board would refuse: %s", async (_label, extra, message) => {
    const t = convexTest(schema, modules);
    await expect(run(t, [{ ...lead("Austin Vertical"), ...extra }])).rejects.toThrow(message);
    expect(await t.run((ctx) => ctx.db.query("deals").collect())).toEqual([]);
  });

  test("takes a bounded list, for Startup's market only", async () => {
    const t = convexTest(schema, modules);
    const many = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, n) => lead(`Made-up Vertical ${n}`));
    await expect(run(t, many)).rejects.toThrow(
      `At most ${MAX_IMPORT_ROWS} rows can be imported at once.`,
    );
    await expect(run(t, [lead("Almaty Dental")], "kz")).rejects.toThrow(
      "Kazakhstan deals come from the Kazakhstan CRM and cannot be added here.",
    );
    expect(await run(t, [])).toEqual({ added: 0, skipped: 0 });
    expect(await t.run((ctx) => ctx.db.query("deals").collect())).toEqual([]);
  });

  test("is not a function the browser can call", async () => {
    const { importProspects } = (await import("./deals")) as unknown as Record<
      string,
      { isPublic?: boolean; isInternal?: boolean; isMutation?: boolean }
    >;
    expect(importProspects!.isInternal).toBe(true);
    expect(importProspects!.isMutation).toBe(true);
    expect(importProspects!.isPublic).not.toBe(true);
  });
});
