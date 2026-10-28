import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { OWNER, modules, signInAs, signInAsOwner } from "../test.setup";

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const manualCash = {
  key: "cash",
  scope: "kz",
  date: "2026-10-12",
  value: 1_000_000,
  currency: "KZT",
};

describe("owner gate on queries", () => {
  test("a signed-out caller is refused", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.metrics.scorecard, {})).rejects.toThrow("not_allowed");
  });

  test("a signed-in user who is not on the allow-list is refused", async () => {
    const t = convexTest(schema, modules);
    const stranger = await signInAs(t, {
      email: "stranger@gmail.com",
      emailVerificationTime: 1,
    });
    await expect(stranger.query(api.metrics.scorecard, {})).rejects.toThrow("not_allowed");
  });

  test("the owner's address without a verified email is refused", async () => {
    const t = convexTest(schema, modules);
    const unverified = await signInAs(t, { email: OWNER });
    await expect(unverified.query(api.metrics.scorecard, {})).rejects.toThrow("not_allowed");
  });

  test("an existing session loses access when the allow-list changes", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.query(api.metrics.scorecard, {});
    vi.stubEnv("OWNER_EMAILS", "");
    await expect(owner.query(api.metrics.scorecard, {})).rejects.toThrow("not_allowed");
  });

  test("signing out takes effect at once, not when the token expires", async () => {
    // The token stays cryptographically valid for up to an hour after
    // sign-out. The gate also requires its session to still exist.
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.query(api.metrics.scorecard, {});
    await t.run(async (ctx) => {
      for (const session of await ctx.db.query("authSessions").collect()) {
        await ctx.db.delete(session._id);
      }
    });
    await expect(owner.query(api.metrics.scorecard, {})).rejects.toThrow("not_allowed");
  });

  test("a token naming a session that never existed is refused", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { email: OWNER, emailVerificationTime: 1 }),
    );
    const forged = t.withIdentity({ subject: `${userId}|not-a-session-id` });
    await expect(forged.query(api.metrics.scorecard, {})).rejects.toThrow("not_allowed");
  });

  test("the owner gets an answer", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(owner.query(api.metrics.scorecard, {})).resolves.toBeDefined();
  });
});

describe("the gate on mutations", () => {
  // Typing a number in goes with the `settings` area, which a stranger lacks.
  test("someone who is not let in cannot write, and nothing is stored", async () => {
    const t = convexTest(schema, modules);
    const stranger = await signInAs(t, {
      email: "stranger@gmail.com",
      emailVerificationTime: 1,
    });
    await expect(stranger.mutation(api.snapshots.setManual, manualCash)).rejects.toThrow(
      "not_allowed",
    );
    const rows = await t.run((ctx) => ctx.db.query("metricSnapshots").collect());
    expect(rows).toEqual([]);
  });

  test("a signed-out caller cannot write", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.snapshots.setManual, manualCash)).rejects.toThrow(
      "not_allowed",
    );
  });

  // What is the owner's alone: the owner's own Telegram username.
  test("an owner-only mutation refuses a stranger and a signed-out caller, and stores nothing", async () => {
    const t = convexTest(schema, modules);
    const stranger = await signInAs(t, {
      email: "stranger@gmail.com",
      emailVerificationTime: 1,
    });
    await expect(
      stranger.mutation(api.telegram.setMine, { telegram: "someone" }),
    ).rejects.toThrow("not_owner");
    await expect(t.mutation(api.telegram.setMine, { telegram: "someone" })).rejects.toThrow(
      "not_owner",
    );
    expect(await t.run((ctx) => ctx.db.query("telegramSettings").collect())).toEqual([]);
  });
});

describe("viewer.me", () => {
  test("null when signed out", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.viewer.me, {})).toBeNull();
  });

  test("says not let in, and nothing else, for a signed-in stranger", async () => {
    const t = convexTest(schema, modules);
    const stranger = await signInAs(t, {
      email: "stranger@gmail.com",
      emailVerificationTime: 1,
    });
    expect(await stranger.query(api.viewer.me, {})).toEqual({ isOwner: false, isMember: false });
  });

  test("returns the owner's profile", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    expect(await owner.query(api.viewer.me, {})).toMatchObject({
      isOwner: true,
      email: OWNER,
    });
  });
});
