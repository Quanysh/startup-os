import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { describeCards } from "./pipelineCards.kit";
import schema from "./schema";
import { OWNER, modules, signInAsOwner, type TestBackend } from "./test.setup";

// A mirrored investor as a push from Visible would have left it.
const seedMirrored = (t: TestBackend, fields: Record<string, unknown> = {}) =>
  t.run((ctx) =>
    ctx.db.insert("investors", {
      source: "visible",
      externalId: `visible-${Math.random()}`,
      name: "Mirrored Co",
      stage: "target",
      sourceStage: "Researching",
      order: 0,
      ...fields,
    }),
  );

describeCards({
  table: "investors",
  noun: "investor",
  blankName: "An investor needs a name.",
  stages: {
    first: "target",
    second: "contacted",
    third: "meeting",
    closed: "committed",
    foreign: "demo",
  },
  mirror: { source: "visible", named: "Visible", writesBack: true },
  refs: api.investors,
  boardArgs: {},
  seedMirrored,
});

describe("investors: the board", () => {
  beforeEach(() => {
    vi.stubEnv("OWNER_EMAILS", OWNER);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("the board has every stage, and unmapped, even when empty", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    expect(await owner.query(api.investors.board, {})).toEqual({
      target: [],
      contacted: [],
      meeting: [],
      diligence: [],
      committed: [],
      passed: [],
      unmapped: [],
    });
  });

  test("an investor can be added by hand, the fallback when Visible cannot be read", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.investors.create, { name: "Seedline Capital", amount: 250_000 });
    const [card] = (await owner.query(api.investors.board, {})).target;
    expect(card).toMatchObject({ name: "Seedline Capital", amount: 250_000, mirrored: false });
  });
});
