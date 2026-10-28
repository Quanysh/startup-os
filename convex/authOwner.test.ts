import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { googleProfile, isOwnerEmail, resolveOwnerUser } from "./authOwner";
import schema from "./schema";
import { modules } from "./test.setup";

const OWNER = "founder@example.test";

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// A verified Google profile. Workspace accounts carry their domain in
// `hostedDomain`; consumer Gmail accounts carry none.
const verified = (email: string) => {
  const domain = email.split("@")[1]!.toLowerCase();
  return {
    email,
    emailVerified: true,
    name: "Founder",
    ...(domain === "gmail.com" ? null : { hostedDomain: domain }),
  };
};

describe("isOwnerEmail", () => {
  test("true for an address on the allow-list", () => {
    expect(isOwnerEmail(OWNER)).toBe(true);
  });

  test("ignores case and surrounding whitespace on both sides", () => {
    vi.stubEnv("OWNER_EMAILS", "  Founder@Example.test , second@example.test ");
    expect(isOwnerEmail("FOUNDER@example.test")).toBe(true);
    expect(isOwnerEmail(" second@example.test ")).toBe(true);
  });

  test("false for another address on the same domain", () => {
    expect(isOwnerEmail("someone-else@example.test")).toBe(false);
  });

  test("false for everyone when the allow-list is unset", () => {
    vi.stubEnv("OWNER_EMAILS", "");
    expect(isOwnerEmail(OWNER)).toBe(false);
    expect(isOwnerEmail("")).toBe(false);
  });

  test("false for a missing email", () => {
    expect(isOwnerEmail(undefined)).toBe(false);
    expect(isOwnerEmail(null)).toBe(false);
  });
});

describe("resolveOwnerUser", () => {
  test("creates the owner's user with a verified email", async () => {
    const t = convexTest(schema, modules);
    const user = await t.run(async (ctx) => {
      const id = await resolveOwnerUser(ctx.db, {
        existingUserId: null,
        profile: verified(OWNER),
      });
      return await ctx.db.get(id);
    });
    expect(user?.email).toBe(OWNER);
    expect(user?.emailVerificationTime).toBeTypeOf("number");
  });

  test("refuses an email outside the allow-list and writes nothing", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.run((ctx) =>
        resolveOwnerUser(ctx.db, {
          existingUserId: null,
          profile: verified("stranger@gmail.com"),
        }),
      ),
    ).rejects.toThrow("not_owner");
    const users = await t.run((ctx) => ctx.db.query("users").collect());
    expect(users).toEqual([]);
  });

  test("refuses the owner's address when Google has not verified it", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.run((ctx) =>
        resolveOwnerUser(ctx.db, {
          existingUserId: null,
          profile: { email: OWNER, emailVerified: false },
        }),
      ),
    ).rejects.toThrow("not_owner");
  });

  test("refuses when the verified flag is absent", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.run((ctx) =>
        resolveOwnerUser(ctx.db, { existingUserId: null, profile: { email: OWNER } }),
      ),
    ).rejects.toThrow("not_owner");
  });

  test("a repeat sign-in returns the same user", async () => {
    const t = convexTest(schema, modules);
    const { first, second, count } = await t.run(async (ctx) => {
      const first = await resolveOwnerUser(ctx.db, {
        existingUserId: null,
        profile: verified(OWNER),
      });
      const second = await resolveOwnerUser(ctx.db, {
        existingUserId: first,
        profile: verified(OWNER),
      });
      return { first, second, count: (await ctx.db.query("users").collect()).length };
    });
    expect(second).toBe(first);
    expect(count).toBe(1);
  });

  test("a second Google account presenting the owner's email is refused", async () => {
    // The first Google identity to sign in with the address claims it. A
    // different identity arrives with no existing link (existingUserId null)
    // while a user row for that email already exists.
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      resolveOwnerUser(ctx.db, { existingUserId: null, profile: verified(OWNER) }),
    );
    await expect(
      t.run((ctx) =>
        resolveOwnerUser(ctx.db, {
          existingUserId: null,
          profile: verified("Founder@Example.test"),
        }),
      ),
    ).rejects.toThrow("not_owner");
    const users = await t.run((ctx) => ctx.db.query("users").collect());
    expect(users).toHaveLength(1);
  });

  test("a returning identity presenting an address another user holds is refused, and both rows are untouched", async () => {
    // Two people, each with their own Google identity and user row. The
    // second's identity comes back showing the first's address (a renamed or
    // re-aliased account). Its link is found, so `existingUserId` is set; the
    // address is still not theirs to take.
    const SECOND = "second@example.test";
    vi.stubEnv("OWNER_EMAILS", `${OWNER} ${SECOND}`);
    const t = convexTest(schema, modules);
    const { first, second } = await t.run(async (ctx) => ({
      first: await resolveOwnerUser(ctx.db, { existingUserId: null, profile: verified(OWNER) }),
      second: await resolveOwnerUser(ctx.db, { existingUserId: null, profile: verified(SECOND) }),
    }));
    const before = await t.run((ctx) => ctx.db.query("users").collect());
    expect(before).toHaveLength(2);

    await expect(
      t.run((ctx) =>
        resolveOwnerUser(ctx.db, {
          existingUserId: second,
          profile: { ...verified("Founder@Example.test"), name: "Taken Over" },
        }),
      ),
    ).rejects.toThrow("not_owner");

    const after = await t.run((ctx) => ctx.db.query("users").collect());
    expect(after).toEqual(before);
    expect(after.find((user) => user._id === first)?.email).toBe(OWNER);
    expect(after.find((user) => user._id === second)?.email).toBe(SECOND);
  });

  test("an ordinary returning sign-in still works beside another user, and takes the new name", async () => {
    const SECOND = "second@example.test";
    vi.stubEnv("OWNER_EMAILS", `${OWNER} ${SECOND}`);
    const t = convexTest(schema, modules);
    const { first, second, again } = await t.run(async (ctx) => {
      const first = await resolveOwnerUser(ctx.db, {
        existingUserId: null,
        profile: verified(OWNER),
      });
      const second = await resolveOwnerUser(ctx.db, {
        existingUserId: null,
        profile: verified(SECOND),
      });
      const again = await resolveOwnerUser(ctx.db, {
        existingUserId: second,
        profile: { ...verified("Second@Example.test"), name: "Renamed" },
      });
      return { first, second, again };
    });
    expect(again).toBe(second);
    const users = await t.run((ctx) => ctx.db.query("users").collect());
    expect(users).toHaveLength(2);
    expect(users.find((user) => user._id === second)).toMatchObject({
      email: SECOND,
      name: "Renamed",
    });
    expect(users.find((user) => user._id === first)).toMatchObject({
      email: OWNER,
      name: "Founder",
    });
  });

  test("a returning identity may move to an allowed address nobody holds", async () => {
    const MOVED = "moved@example.test";
    vi.stubEnv("OWNER_EMAILS", `${OWNER} ${MOVED}`);
    const t = convexTest(schema, modules);
    const user = await t.run(async (ctx) => {
      const id = await resolveOwnerUser(ctx.db, {
        existingUserId: null,
        profile: verified(OWNER),
      });
      await resolveOwnerUser(ctx.db, { existingUserId: id, profile: verified(MOVED) });
      return await ctx.db.get(id);
    });
    expect(user?.email).toBe(MOVED);
  });

  test("a Gmail owner needs no hosted domain", async () => {
    vi.stubEnv("OWNER_EMAILS", "founder@gmail.com");
    const t = convexTest(schema, modules);
    const id = await t.run((ctx) =>
      resolveOwnerUser(ctx.db, {
        existingUserId: null,
        profile: { email: "founder@gmail.com", emailVerified: true },
      }),
    );
    expect(id).toBeTypeOf("string");
  });

  test("a non-Gmail address is refused unless Google vouches for its domain", async () => {
    // Google is authoritative for an address only when it is @gmail.com or a
    // Workspace account for that domain. Otherwise "verified" means someone
    // once proved control of the mailbox, which is not the same thing.
    const t = convexTest(schema, modules);
    await expect(
      t.run((ctx) =>
        resolveOwnerUser(ctx.db, {
          existingUserId: null,
          profile: { email: OWNER, emailVerified: true },
        }),
      ),
    ).rejects.toThrow("not_owner");
  });

  test("a hosted domain that does not match the address is refused", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.run((ctx) =>
        resolveOwnerUser(ctx.db, {
          existingUserId: null,
          profile: { email: OWNER, emailVerified: true, hostedDomain: "evil.example" },
        }),
      ),
    ).rejects.toThrow("not_owner");
  });

  test("a user removed from the allow-list is refused on the next sign-in", async () => {
    const t = convexTest(schema, modules);
    const id = await t.run((ctx) =>
      resolveOwnerUser(ctx.db, { existingUserId: null, profile: verified(OWNER) }),
    );
    vi.stubEnv("OWNER_EMAILS", "someone-new@example.test");
    await expect(
      t.run((ctx) =>
        resolveOwnerUser(ctx.db, { existingUserId: id, profile: verified(OWNER) }),
      ),
    ).rejects.toThrow("not_owner");
  });
});

describe("googleProfile", () => {
  const claims = {
    sub: "1234567890",
    name: "Founder",
    email: "founder@example.test",
    picture: "https://example.com/p.png",
    email_verified: true,
    hd: "example.test",
  };

  test("carries Google's verified flag and hosted domain through to the callback", () => {
    expect(googleProfile(claims)).toEqual({
      id: "1234567890",
      name: "Founder",
      email: "founder@example.test",
      image: "https://example.com/p.png",
      emailVerified: true,
      hostedDomain: "example.test",
    });
  });

  test("anything but a literal true is not verified", () => {
    expect(googleProfile({ ...claims, email_verified: "true" }).emailVerified).toBe(false);
    expect(googleProfile({ ...claims, email_verified: undefined }).emailVerified).toBe(false);
  });

  test("a consumer account has no hosted domain", () => {
    expect(googleProfile({ ...claims, hd: undefined }).hostedDomain).toBeUndefined();
  });
});
