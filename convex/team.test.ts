import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { resolveOwnerUser } from "./authOwner";
import { getMember } from "./lib/owner";
import { AREAS, MAX_MEMBERS, MEMBER_ROLES, areasOf } from "./lib/roles";
import schema from "./schema";
import {
  OWNER,
  addMember,
  memberEmail,
  modules,
  signInAs,
  signInAsCofounder,
  signInAsEngineer,
  signInAsMember,
  signInAsOwner,
  signInAsSales,
  signInWithAreas,
  type TestBackend,
} from "./test.setup";

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const start = async () => {
  const t = convexTest(schema, modules);
  return { t, owner: await signInAsOwner(t) };
};
const rows = (t: TestBackend) => t.run((ctx) => ctx.db.query("members").collect());
const NEW = {
  email: "new.person@gmail.com",
  role: "sales" as const,
  companies: ["us" as const],
  areas: ["sales", "customers"],
};
const OWNERS_ONLY =
  "The owner's own mail, calendar and meeting notes, and the work-tool settings, are the owner's only.";
const NOT_A_PAGE = "That is not a page of the OS.";

describe("team.add", () => {
  test("the owner adds a teammate, stored lower-cased with who added them", async () => {
    const { t, owner } = await start();
    await owner.mutation(api.team.add, { ...NEW, email: "  New.Person@Gmail.com " });
    const [row] = await rows(t);
    expect(row).toMatchObject({
      email: "new.person@gmail.com",
      role: "sales",
      companies: ["us"],
      areas: ["sales", "customers"],
    });
    expect(row?.addedAt).toBeTypeOf("number");
    const adder = await t.run((ctx) => ctx.db.get(row!.addedBy));
    expect(adder?.email).toBe(OWNER);
  });

  test("the pages are the ones picked, not the role's: more than it starts with, or fewer", async () => {
    const { t, owner } = await start();
    await owner.mutation(api.team.add, { ...NEW, role: "engineer", areas: ["finance"] });
    expect((await rows(t))[0]).toMatchObject({ role: "engineer", areas: ["finance"] });
  });

  test("each page is stored once, in the table's order", async () => {
    const { t, owner } = await start();
    await owner.mutation(api.team.add, { ...NEW, areas: ["board", "finance", "board", "finance"] });
    expect((await rows(t))[0]?.areas).toEqual(["finance", "board"]);
  });

  test("no page at all is allowed, and is stored as none rather than left to the role", async () => {
    const { t, owner } = await start();
    await owner.mutation(api.team.add, { ...NEW, areas: [] });
    expect((await rows(t))[0]?.areas).toEqual([]);
  });

  test.each(["admin", "personal"])("%s cannot be given, in fixed words", async (area) => {
    const { t, owner } = await start();
    await expect(
      owner.mutation(api.team.add, { ...NEW, areas: ["finance", area] }),
    ).rejects.toThrow(OWNERS_ONLY);
    expect(await rows(t)).toEqual([]);
  });

  test("a made-up page is refused, and is not quoted back", async () => {
    const { t, owner } = await start();
    const attempt = owner.mutation(api.team.add, { ...NEW, areas: ["finance", "payroll-x"] });
    await expect(attempt).rejects.toThrow(NOT_A_PAGE);
    await attempt.catch((error: Error) => expect(error.message).not.toContain("payroll-x"));
    expect(await rows(t)).toEqual([]);
  });

  test("the pages must be said: there is no default", async () => {
    const { t, owner } = await start();
    const { areas: _areas, ...without } = NEW;
    await expect(owner.mutation(api.team.add, without as never)).rejects.toThrow(/Validator/);
    expect(await rows(t)).toEqual([]);
  });

  test.each([
    ["no at sign", "not-an-address"],
    ["two at signs", "a@b@gmail.com"],
    ["no domain dot", "someone@localhost"],
    ["a space inside", "some one@gmail.com"],
    ["a non-ASCII letter", "sömeone@gmail.com"],
    ["a control character", "some\u0007one@gmail.com"],
    ["a zero-width character", "some​one@gmail.com"],
    ["nothing", "   "],
    ["too long", `${"a".repeat(250)}@gmail.com`],
  ])("an address with %s is refused, and is not quoted back", async (_what, email) => {
    const { t, owner } = await start();
    const attempt = owner.mutation(api.team.add, { ...NEW, email });
    await expect(attempt).rejects.toThrow("That is not an email address.");
    await attempt.catch((error: Error) => {
      if (email.trim() !== "") expect(error.message).not.toContain(email.trim());
    });
    expect(await rows(t)).toEqual([]);
  });

  test("an owner's address cannot be added", async () => {
    const { t, owner } = await start();
    await expect(
      owner.mutation(api.team.add, { ...NEW, email: OWNER.toUpperCase() }),
    ).rejects.toThrow("That address is an owner's.");
    expect(await rows(t)).toEqual([]);
  });

  test("the same address cannot be added twice, whatever its case", async () => {
    const { t, owner } = await start();
    await owner.mutation(api.team.add, NEW);
    await expect(
      owner.mutation(api.team.add, { ...NEW, email: "NEW.PERSON@gmail.com", role: "engineer" }),
    ).rejects.toThrow("That person is already on the team.");
    expect(await rows(t)).toHaveLength(1);
  });

  test("at least one company, each stored once", async () => {
    const { t, owner } = await start();
    await expect(owner.mutation(api.team.add, { ...NEW, companies: [] })).rejects.toThrow(
      "Pick at least one company.",
    );
    await owner.mutation(api.team.add, { ...NEW, companies: ["kz", "us", "kz"] });
    expect((await rows(t))[0]?.companies).toEqual(["us", "kz"]);
  });

  test("the owner is not a role that can be given, nor is a made-up company", async () => {
    const { t, owner } = await start();
    await expect(
      owner.mutation(api.team.add, { ...NEW, role: "owner" } as never),
    ).rejects.toThrow(/Validator/);
    await expect(
      owner.mutation(api.team.add, { ...NEW, companies: ["eu"] } as never),
    ).rejects.toThrow(/Validator/);
    expect(await rows(t)).toEqual([]);
  });

  test(`the team stops at ${MAX_MEMBERS}`, async () => {
    const { t, owner } = await start();
    for (let n = 0; n < MAX_MEMBERS; n += 1) {
      await addMember(t, { email: `person${n}@gmail.com`, role: "engineer" });
    }
    await expect(owner.mutation(api.team.add, NEW)).rejects.toThrow(
      `The team is full (${MAX_MEMBERS} people at most).`,
    );
    expect(await rows(t)).toHaveLength(MAX_MEMBERS);
  });
});

describe("team.list", () => {
  test("every teammate, with whether each has signed in yet", async () => {
    const { t, owner } = await start();
    await owner.mutation(api.team.add, NEW);
    await signInAsEngineer(t, ["kz"]);
    await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", memberEmail("engineer", ["kz"])))
        .first();
      await ctx.db.patch(user!._id, { name: "Eng Ineer" });
    });
    const list = await owner.query(api.team.list, {});
    expect(list.map(({ id: _id, addedAt: _at, ...rest }) => rest)).toEqual([
      {
        email: memberEmail("engineer", ["kz"]),
        role: "engineer",
        roleName: "Engineer",
        focus: "engineering",
        github: null,
        companies: ["kz"],
        // A row from before pages could be picked: its role's.
        areas: ["product", "engineering", "board", "agents"],
        name: "Eng Ineer",
        signedIn: true,
        telegram: null,
        telegramLinked: false,
        telegramLinkedAt: null,
        // The owner's to change, and not the owner's own row: the owner has none.
        self: false,
        editable: true,
      },
      {
        email: NEW.email,
        role: "sales",
        roleName: "Sales",
        focus: "sales",
        github: null,
        companies: ["us"],
        areas: ["sales", "customers"],
        name: null,
        signedIn: false,
        telegram: null,
        telegramLinked: false,
        telegramLinkedAt: null,
        self: false,
        editable: true,
      },
    ]);
  });

  test("the pages listed are the ones the gate will open: none, when none were picked", async () => {
    const { owner } = await start();
    await owner.mutation(api.team.add, { ...NEW, role: "cofounder", areas: [] });
    expect((await owner.query(api.team.list, {}))[0]).toMatchObject({
      role: "cofounder",
      areas: [],
    });
  });
});

describe("team.update", () => {
  test("a changed role and companies hold from the teammate's next call", async () => {
    const { t, owner } = await start();
    const sales = await signInAsSales(t, ["us"]);
    await sales.query(api.deals.board, { market: "us" });
    const [row] = await rows(t);
    await owner.mutation(api.team.update, {
      id: row!._id,
      role: "engineer",
      companies: ["kz"],
      areas: ["product", "board"],
    });
    // The same session, a moment later.
    await expect(sales.query(api.deals.board, { market: "us" })).rejects.toThrow("not_allowed");
    expect(await sales.query(api.viewer.me, {})).toMatchObject({
      role: "engineer",
      companies: ["kz"],
      areas: ["product", "board"],
    });
  });

  test("changed pages hold from the next call, under the same role, both ways", async () => {
    const { t, owner } = await start();
    const engineer = await signInAsEngineer(t);
    const [row] = await rows(t);
    const set = (areas: string[]) =>
      owner.mutation(api.team.update, { id: row!._id, role: "engineer", companies: ["us", "kz"], areas });
    await expect(engineer.query(api.deals.board, { market: "us" })).rejects.toThrow("not_allowed");
    await engineer.query(api.tasks.board, {});

    // Given sales, and the board taken away.
    await set(["sales", "product"]);
    await expect(engineer.query(api.deals.board, { market: "us" })).resolves.toBeDefined();
    await expect(engineer.query(api.tasks.board, {})).rejects.toThrow("not_allowed");
    expect(await engineer.query(api.viewer.me, {})).toMatchObject({
      role: "engineer",
      areas: ["product", "sales"],
    });

    // Nothing at all: still a member, with nothing to open.
    await set([]);
    await expect(engineer.query(api.deals.board, { market: "us" })).rejects.toThrow("not_allowed");
    await expect(engineer.query(api.metrics.scorecard, {})).rejects.toThrow("not_allowed");
    expect(await engineer.query(api.viewer.me, {})).toMatchObject({ isMember: true, areas: [] });
  });

  test("changing the role alone gives nothing the list does not hold", async () => {
    const { t, owner } = await start();
    const engineer = await signInWithAreas(t, "engineer", ["product"]);
    const [row] = await rows(t);
    await owner.mutation(api.team.update, {
      id: row!._id,
      role: "cofounder",
      companies: ["us", "kz"],
      areas: ["product"],
    });
    expect(await engineer.query(api.viewer.me, {})).toMatchObject({
      role: "cofounder",
      areas: ["product"],
    });
    await expect(engineer.mutation(api.goals.create, { quarter: "2026-Q4", title: "x" })).rejects.toThrow("not_allowed");
  });

  test("the list is validated as on add, and a refused change stores nothing", async () => {
    const { t, owner } = await start();
    const id = await addMember(t, { email: NEW.email, role: "sales", areas: ["sales"] });
    const set = (areas: string[]) =>
      owner.mutation(api.team.update, { id, role: "sales", companies: ["us"], areas });
    await expect(set(["sales", "admin"])).rejects.toThrow(OWNERS_ONLY);
    await expect(set(["personal"])).rejects.toThrow(OWNERS_ONLY);
    await expect(set(["sales", "payroll-x"])).rejects.toThrow(NOT_A_PAGE);
    expect((await rows(t))[0]?.areas).toEqual(["sales"]);
    await set(["gtm", "sales", "gtm"]);
    expect((await rows(t))[0]?.areas).toEqual(["sales", "gtm"]);
  });

  test("a row from before pages could be picked gets a list of its own at its first save", async () => {
    const { t, owner } = await start();
    const id = await addMember(t, { email: NEW.email, role: "sales" });
    expect((await rows(t))[0]?.areas).toBeUndefined();
    await owner.mutation(api.team.update, { id, role: "sales", companies: ["us"], areas: ["sales"] });
    expect((await rows(t))[0]?.areas).toEqual(["sales"]);
  });

  test("it needs a company, and a row that is still there", async () => {
    const { t, owner } = await start();
    const id = await addMember(t, { email: NEW.email, role: "sales" });
    await expect(
      owner.mutation(api.team.update, { id, role: "sales", companies: [], areas: ["sales"] }),
    ).rejects.toThrow("Pick at least one company.");
    await owner.mutation(api.team.remove, { id });
    await expect(
      owner.mutation(api.team.update, { id, role: "sales", companies: ["us"], areas: ["sales"] }),
    ).rejects.toThrow("That person is no longer on the team.");
  });
});

describe("team.remove", () => {
  test("a removed teammate's sessions and refresh tokens are gone, and only theirs", async () => {
    const { t, owner } = await start();
    const sales = await signInAsSales(t);
    const engineer = await signInAsEngineer(t);
    // A second open tab, and a refresh token for the first.
    await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", memberEmail("sales")))
        .first();
      const second = await ctx.db.insert("authSessions", {
        userId: user!._id,
        expirationTime: Date.now() + 1000,
      });
      await ctx.db.insert("authRefreshTokens", {
        sessionId: second,
        expirationTime: Date.now() + 1000,
      });
    });
    const row = (await rows(t)).find((r) => r.role === "sales")!;
    await owner.mutation(api.team.remove, { id: row._id });

    const left = await t.run(async (ctx) => ({
      sessions: await ctx.db.query("authSessions").collect(),
      tokens: await ctx.db.query("authRefreshTokens").collect(),
      members: await ctx.db.query("members").collect(),
    }));
    // The owner's and the engineer's remain.
    expect(left.sessions).toHaveLength(2);
    expect(left.tokens).toEqual([]);
    expect(left.members.map((m) => m.role)).toEqual(["engineer"]);
    await expect(sales.query(api.tasks.board, {})).rejects.toThrow("not_allowed");
    // Their token outlives the session by up to an hour; it now names nobody.
    expect(await sales.query(api.viewer.me, {})).toEqual({ isOwner: false, isMember: false });
    await expect(engineer.query(api.tasks.board, {})).resolves.toBeDefined();
  });

  test("removing someone already gone does nothing", async () => {
    const { t, owner } = await start();
    const id = await addMember(t, { email: NEW.email, role: "sales" });
    await owner.mutation(api.team.remove, { id });
    await expect(owner.mutation(api.team.remove, { id })).resolves.toBeNull();
  });

  test("their tasks keep them as assignee, shown as a removed teammate", async () => {
    const { t, owner } = await start();
    await signInAsSales(t);
    const id = await owner.mutation(api.tasks.create, {
      title: "Call back",
      assignee: memberEmail("sales"),
    });
    const row = (await rows(t))[0]!;
    await owner.mutation(api.team.remove, { id: row._id });
    expect((await t.run((ctx) => ctx.db.get(id)))?.assignee).toBe(memberEmail("sales"));
    const board = await owner.query(api.tasks.board, {});
    expect(board.backlog[0]?.assignee).toEqual({
      status: "removed",
      email: memberEmail("sales"),
      name: null,
    });
    // A teammate is told only that someone was removed, not who.
    const engineer = await signInAsEngineer(t);
    expect((await engineer.query(api.tasks.board, {})).backlog[0]?.assignee).toEqual({
      status: "removed",
      email: null,
      name: null,
    });
  });
});

// What a teammate who holds the `team` area may do is in convex/teamManager.test.ts.
describe("team: not for a role's starting set", () => {
  test.each(["cofounder", "sales", "engineer"] as const)(
    "a %s can neither read nor change the team",
    async (role) => {
      const { t } = await start();
      const member = await signInAsMember(t, role);
      const id = (await rows(t))[0]!._id;
      await expect(member.query(api.team.list, {})).rejects.toThrow("not_allowed");
      await expect(member.mutation(api.team.add, NEW)).rejects.toThrow("not_allowed");
      await expect(
        member.mutation(api.team.update, {
          id,
          role: "cofounder",
          companies: ["us", "kz"],
          areas: ["finance"],
        }),
      ).rejects.toThrow("not_allowed");
      await expect(member.mutation(api.team.remove, { id })).rejects.toThrow("not_allowed");
      expect(await rows(t)).toHaveLength(1);
      expect((await rows(t))[0]?.role).toBe(role);
    },
  );
});

describe("team.assignable", () => {
  const setUp = async () => {
    const { t, owner } = await start();
    const usSales = await signInAsSales(t, ["us"]);
    const kzEngineer = await signInAsEngineer(t, ["kz"]);
    const cofounder = await signInAsCofounder(t);
    return { t, owner, usSales, kzEngineer, cofounder };
  };
  const emails = (people: { email: string }[]) => people.map((p) => p.email);

  test("an address and a name, and nothing else about anyone", async () => {
    const { owner } = await setUp();
    const people = await owner.query(api.team.assignable, {});
    for (const person of people) expect(Object.keys(person).sort()).toEqual(["email", "name"]);
    expect(emails(people)).toEqual(
      [OWNER, memberEmail("cofounder"), memberEmail("engineer", ["kz"]), memberEmail("sales", ["us"])].sort(),
    );
  });

  test("a teammate is told of the owner and of those who share a company with them", async () => {
    const { usSales, kzEngineer } = await setUp();
    expect(emails(await usSales.query(api.team.assignable, {}))).toEqual(
      [OWNER, memberEmail("cofounder"), memberEmail("sales", ["us"])].sort(),
    );
    expect(emails(await kzEngineer.query(api.team.assignable, {}))).toEqual(
      [OWNER, memberEmail("cofounder"), memberEmail("engineer", ["kz"])].sort(),
    );
  });

  test("given a company, only the people on it", async () => {
    const { cofounder } = await setUp();
    expect(emails(await cofounder.query(api.team.assignable, { company: "kz" }))).toEqual(
      [OWNER, memberEmail("cofounder"), memberEmail("engineer", ["kz"])].sort(),
    );
  });

  test("a company the caller is not on is refused", async () => {
    const { usSales } = await setUp();
    await expect(usSales.query(api.team.assignable, { company: "kz" })).rejects.toThrow(
      "not_allowed",
    );
  });
});

describe("getMember", () => {
  const who = (client: { run: TestBackend["run"] }) =>
    client.run(async (ctx) => {
      const member = await getMember(ctx);
      return member && { role: member.role, companies: member.companies, email: member.user.email };
    });
  const areasOfCaller = (client: { run: TestBackend["run"] }) =>
    client.run(async (ctx) => (await getMember(ctx))?.areas);

  test("the owner has every area", async () => {
    const { owner } = await start();
    expect(await areasOfCaller(owner)).toEqual(AREAS);
  });

  test.each(MEMBER_ROLES)("a %s with no list of their own has their role's areas", async (role) => {
    const { t } = await start();
    expect(await areasOfCaller(await signInAsMember(t, role))).toEqual(areasOf(role));
  });

  test("a teammate has the areas the owner picked, whatever their role starts with", async () => {
    const { t } = await start();
    expect(await areasOfCaller(await signInWithAreas(t, "engineer", ["finance"]))).toEqual([
      "finance",
    ]);
    expect(await areasOfCaller(await signInWithAreas(t, "cofounder", []))).toEqual([]);
  });

  test.each(["admin", "personal"])(
    "%s cannot be written to a teammate's row, even straight to the table",
    async (area) => {
      const { t } = await start();
      const id = await addMember(t, { email: NEW.email, role: "cofounder", areas: ["finance"] });
      await expect(
        t.run((ctx) => ctx.db.patch(id, { areas: ["finance", area] as never })),
      ).rejects.toThrow(/Validator/);
      expect((await rows(t))[0]?.areas).toEqual(["finance"]);
    },
  );

  test("the owner is the owner, on both companies, with no row", async () => {
    const { t, owner } = await start();
    expect(await who(owner)).toEqual({ role: "owner", companies: ["us", "kz"], email: OWNER });
    expect(await rows(t)).toEqual([]);
  });

  test.each(["cofounder", "sales", "engineer"] as const)("a %s has their role and companies", async (role) => {
    const { t } = await start();
    const member = await signInAsMember(t, role, ["kz"]);
    expect(await who(member)).toEqual({
      role,
      companies: ["kz"],
      email: memberEmail(role, ["kz"]),
    });
  });

  test("nobody when signed out, and nobody for an address not on the team", async () => {
    const { t } = await start();
    expect(await who(t)).toBeNull();
    const stranger = await signInAs(t, { email: "stranger@gmail.com", emailVerificationTime: 1 });
    expect(await who(stranger)).toBeNull();
  });

  test("a removed teammate with a live session is nobody", async () => {
    const { t } = await start();
    const sales = await signInAsSales(t);
    expect(await who(sales)).not.toBeNull();
    // The row goes; the session is left as it was, as a stale tab's would be.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("members").collect()) await ctx.db.delete(row._id);
    });
    expect(await who(sales)).toBeNull();
    await expect(sales.query(api.metrics.scorecard, {})).rejects.toThrow("not_allowed");
  });

  test("a teammate's address without a verified email is nobody", async () => {
    const { t } = await start();
    await addMember(t, { email: "unverified@gmail.com", role: "cofounder" });
    const unverified = await signInAs(t, { email: "unverified@gmail.com" });
    expect(await who(unverified)).toBeNull();
    await expect(unverified.query(api.tasks.board, {})).rejects.toThrow("not_allowed");
  });

  test("a teammate whose session has ended is nobody", async () => {
    const { t } = await start();
    const sales = await signInAsSales(t);
    await t.run(async (ctx) => {
      for (const session of await ctx.db.query("authSessions").collect()) {
        await ctx.db.delete(session._id);
      }
    });
    expect(await who(sales)).toBeNull();
  });

  // Changed on purpose. This test used to assert that teammates keep their
  // role with OWNER_EMAILS unset. That left rows nobody could remove (only an
  // owner can call team.remove) still opening the OS. No owner now means
  // nobody, as it did before teammates existed.
  test.each([
    ["empty", ""],
    ["only separators", " , ,\n"],
  ])("with OWNER_EMAILS %s nobody is let in: no owner, and no teammate", async (_what, value) => {
    const { t, owner } = await start();
    const sales = await signInAsSales(t);
    const cofounder = await signInAsCofounder(t);
    expect(await who(sales)).toMatchObject({ role: "sales" });
    vi.stubEnv("OWNER_EMAILS", value);
    expect(await who(owner)).toBeNull();
    expect(await who(sales)).toBeNull();
    expect(await who(cofounder)).toBeNull();
    await expect(sales.query(api.tasks.board, {})).rejects.toThrow("not_allowed");
    await expect(cofounder.query(api.metrics.scorecard, {})).rejects.toThrow("not_allowed");
  });

  test("with OWNER_EMAILS not set at all nobody is let in", async () => {
    const { t } = await start();
    const sales = await signInAsSales(t);
    vi.stubEnv("OWNER_EMAILS", undefined);
    expect(await who(sales)).toBeNull();
  });

  test("a teammate is let in again once an owner is configured", async () => {
    const { t } = await start();
    const sales = await signInAsSales(t);
    vi.stubEnv("OWNER_EMAILS", "");
    expect(await who(sales)).toBeNull();
    vi.stubEnv("OWNER_EMAILS", OWNER);
    expect(await who(sales)).toMatchObject({ role: "sales" });
  });

  test("an owner's address is the owner whatever a row says", async () => {
    const { t, owner } = await start();
    await addMember(t, { email: OWNER, role: "engineer", companies: ["kz"] });
    expect(await who(owner)).toMatchObject({ role: "owner", companies: ["us", "kz"] });
  });

  test("the row is matched whatever the case of the signed-in address", async () => {
    const { t } = await start();
    await addMember(t, { email: "mixed.case@gmail.com", role: "sales", companies: ["us"] });
    const member = await signInAs(t, { email: "Mixed.Case@gmail.com", emailVerificationTime: 1 });
    expect(await who(member)).toMatchObject({ role: "sales" });
  });
});

describe("viewer.me", () => {
  test("the owner", async () => {
    const { owner } = await start();
    expect(await owner.query(api.viewer.me, {})).toEqual({
      isOwner: true,
      isMember: true,
      role: "owner",
      roleName: "Owner",
      focus: "founder",
      companies: ["us", "kz"],
      areas: expect.arrayContaining(["admin", "personal", "finance"]),
      email: OWNER,
      name: null,
      image: null,
    });
  });

  test("a teammate: their role, companies and areas, and not the owner", async () => {
    const { t } = await start();
    const engineer = await signInAsEngineer(t, ["us"]);
    expect(await engineer.query(api.viewer.me, {})).toEqual({
      isOwner: false,
      isMember: true,
      role: "engineer",
      roleName: "Engineer",
      focus: "engineering",
      companies: ["us"],
      areas: ["product", "engineering", "board", "agents"],
      email: memberEmail("engineer", ["us"]),
      name: null,
      image: null,
    });
  });

  test("a teammate with no owner configured is not a member", async () => {
    const { t } = await start();
    const engineer = await signInAsEngineer(t, ["us"]);
    vi.stubEnv("OWNER_EMAILS", "");
    expect(await engineer.query(api.viewer.me, {})).toEqual({ isOwner: false, isMember: false });
  });

  test("someone signed in who is not let in learns that and nothing else", async () => {
    const { t } = await start();
    const stranger = await signInAs(t, { email: "stranger@gmail.com", emailVerificationTime: 1 });
    expect(await stranger.query(api.viewer.me, {})).toEqual({ isOwner: false, isMember: false });
  });

  test("null when signed out", async () => {
    const { t } = await start();
    expect(await t.query(api.viewer.me, {})).toBeNull();
  });
});

describe("sign-in", () => {
  const verified = (email: string) => ({ email, emailVerified: true, name: "Some One" });
  const signIn = (t: TestBackend, profile: Record<string, unknown>) =>
    t.run((ctx) => resolveOwnerUser(ctx.db, { existingUserId: null, profile }));

  test("an address the owner has added gets a user", async () => {
    const { t } = await start();
    await addMember(t, { email: "added@gmail.com", role: "sales" });
    const id = await signIn(t, verified("Added@gmail.com"));
    const user = await t.run((ctx) => ctx.db.get(id));
    expect(user).toMatchObject({ email: "added@gmail.com", name: "Some One" });
    expect(user?.emailVerificationTime).toBeTypeOf("number");
  });

  test("an address nobody added is refused and leaves no user", async () => {
    const { t } = await start();
    await addMember(t, { email: "added@gmail.com", role: "sales" });
    const before = (await t.run((ctx) => ctx.db.query("users").collect())).length;
    await expect(signIn(t, verified("not.added@gmail.com"))).rejects.toThrow("not_owner");
    expect(await t.run((ctx) => ctx.db.query("users").collect())).toHaveLength(before);
  });

  test("an added address is held to the owner's standard: verified, and vouched for by Google", async () => {
    const { t } = await start();
    await addMember(t, { email: "added@gmail.com", role: "sales" });
    await addMember(t, { email: "person@company.example", role: "sales" });
    await expect(
      signIn(t, { email: "added@gmail.com", emailVerified: false }),
    ).rejects.toThrow("not_owner");
    await expect(signIn(t, { email: "added@gmail.com" })).rejects.toThrow("not_owner");
    // Not a Gmail address, and no Workspace domain to vouch for it.
    await expect(signIn(t, verified("person@company.example"))).rejects.toThrow("not_owner");
    await expect(
      signIn(t, { ...verified("person@company.example"), hostedDomain: "evil.example" }),
    ).rejects.toThrow("not_owner");
    await expect(
      signIn(t, { ...verified("person@company.example"), hostedDomain: "company.example" }),
    ).resolves.toBeTypeOf("string");
  });

  test("a second Google account showing a teammate's address is refused", async () => {
    const { t } = await start();
    await addMember(t, { email: "added@gmail.com", role: "sales" });
    await signIn(t, verified("added@gmail.com"));
    await expect(signIn(t, verified("added@gmail.com"))).rejects.toThrow("not_owner");
  });

  test("with no owner configured an added address is refused, new or returning, and nothing is written", async () => {
    const { t } = await start();
    await addMember(t, { email: "added@gmail.com", role: "sales" });
    await addMember(t, { email: "later@gmail.com", role: "cofounder" });
    const id = await signIn(t, verified("added@gmail.com"));
    const before = await t.run((ctx) => ctx.db.query("users").collect());
    vi.stubEnv("OWNER_EMAILS", "");
    await expect(signIn(t, verified("later@gmail.com"))).rejects.toThrow("not_owner");
    await expect(
      t.run((ctx) =>
        resolveOwnerUser(ctx.db, {
          existingUserId: id,
          profile: { ...verified("added@gmail.com"), name: "Renamed" },
        }),
      ),
    ).rejects.toThrow("not_owner");
    expect(await t.run((ctx) => ctx.db.query("users").collect())).toEqual(before);
  });

  test("a removed teammate is refused on the next sign-in", async () => {
    const { t, owner } = await start();
    const row = await addMember(t, { email: "added@gmail.com", role: "sales" });
    const id = await signIn(t, verified("added@gmail.com"));
    await owner.mutation(api.team.remove, { id: row });
    await expect(
      t.run((ctx) =>
        resolveOwnerUser(ctx.db, { existingUserId: id, profile: verified("added@gmail.com") }),
      ),
    ).rejects.toThrow("not_owner");
  });
});
