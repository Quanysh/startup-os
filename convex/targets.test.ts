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

describe("targets", () => {
  test("no targets until one is set", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    expect(await owner.query(api.targets.list, {})).toEqual([]);
  });

  test("setting a target stores it for that metric and scope", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.targets.set, { key: "mrr", scope: "us", target: 5_000 });
    expect(await owner.query(api.targets.list, {})).toEqual([
      { key: "mrr", scope: "us", target: 5_000 },
    ]);
  });

  test("setting it again replaces the value", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.targets.set, { key: "mrr", scope: "us", target: 5_000 });
    await owner.mutation(api.targets.set, { key: "mrr", scope: "us", target: 6_000 });
    const rows = await t.run((ctx) => ctx.db.query("metricTargets").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.target).toBe(6_000);
  });

  test("each scope of a metric has its own target", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.targets.set, { key: "mrr", scope: "us", target: 5_000 });
    await owner.mutation(api.targets.set, { key: "mrr", scope: "kz", target: 5_000_000 });
    expect(await owner.query(api.targets.list, {})).toHaveLength(2);
  });

  test("an unknown metric or a scope the metric lacks is refused", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(
      owner.mutation(api.targets.set, { key: "vibes", scope: "us", target: 1 }),
    ).rejects.toThrow("Unknown metric");
    await expect(
      owner.mutation(api.targets.set, { key: "mrr", scope: "company", target: 1 }),
    ).rejects.toThrow('has no "company" scope');
  });

  test("a target must be a finite number", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(
      owner.mutation(api.targets.set, { key: "mrr", scope: "us", target: Number.NaN }),
    ).rejects.toThrow("must be a number");
  });

  test("clearing removes the target", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.targets.set, { key: "mrr", scope: "us", target: 5_000 });
    await owner.mutation(api.targets.clear, { key: "mrr", scope: "us" });
    expect(await owner.query(api.targets.list, {})).toEqual([]);
  });

  test("a signed-out caller is refused", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.targets.list, {})).rejects.toThrow("not_allowed");
  });
});
