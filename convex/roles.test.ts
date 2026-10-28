import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  BUILTIN_IS_FIXED,
  GITHUB_IS_THE_OWNERS,
  GITHUB_NOT_A_USERNAME,
  GITHUB_TAKEN,
  MAX_ROLES,
  PRESET_IS_ORDINARY,
  ROLES_FULL,
  ROLE_GONE,
  ROLE_NAME_TAKEN,
} from "./lib/roleRules";
import { SENSITIVE_AREAS, areasOf, type GrantableArea } from "./lib/roles";
import schema from "./schema";
import {
  OWNER,
  addMember,
  modules,
  signInAs,
  signInAsOwner,
  type TestBackend,
} from "./test.setup";

// Roles the owner names (convex/roles.ts), and what follows from a role:
// a label and an arrangement, never access.
//
// - the owner alone adds, renames, changes and deletes a role; someone who
//   manages the team reads the list and gives an existing role to a person;
// - a name is cleaned, unique whatever its capitals, and never a built-in's;
// - a role's usual pages are ordinary pages: never a sensitive one or Today;
// - a role people hold is not deleted; nothing cascades;
// - changing a role's usual pages changes nobody's pages;
// - a row from before roles could be named still reads as it did;
// - the viewer is told their role's name and focus, and a role that is gone
//   is "general";
// - a GitHub username is the owner's to set, one person's, and read back
//   only by the person it is on (and by whoever is sent their team row).

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const MANAGER = "manager@gmail.com";
const PERSON = "person@gmail.com";

const roleRows = (t: TestBackend) => t.run((ctx) => ctx.db.query("roles").collect());
const memberRows = (t: TestBackend) => t.run((ctx) => ctx.db.query("members").collect());

async function start() {
  const t = convexTest(schema, modules);
  const owner = await signInAsOwner(t);
  await addMember(t, { email: MANAGER, role: "engineer", areas: ["team"] });
  const manager = await signInAs(t, { email: MANAGER, emailVerificationTime: 1 });
  return { t, owner, manager };
}

const product = { name: "Product", focus: "engineering" as const, areas: ["product", "board"] };

describe("roles.list", () => {
  test("with none named, the three built-in roles, each with its focus and usual pages", async () => {
    const { t, owner } = await start();
    const list = await owner.query(api.roles.list, {});
    expect(list.map((role) => [role.id, role.name, role.focus, role.builtin])).toEqual([
      ["cofounder", "Co-founder", "founder", true],
      ["sales", "Sales", "sales", true],
      ["engineer", "Engineer", "engineering", true],
    ]);
    expect(list.map((role) => role.areas)).toEqual([
      [...areasOf("cofounder")],
      [...areasOf("sales")],
      [...areasOf("engineer")],
    ]);
    // Nothing was written to make them: the built-ins are not rows.
    expect(await roleRows(t)).toEqual([]);
  });

  test("the owner's named roles follow, by name, with how many people have each", async () => {
    const { t, owner } = await start();
    const zeta = await owner.mutation(api.roles.create, { ...product, name: "Zeta" });
    const alpha = await owner.mutation(api.roles.create, { ...product, name: "alpha" });
    await addMember(t, { email: PERSON, role: alpha, areas: [] });
    const list = await owner.query(api.roles.list, {});
    expect(list.slice(3).map((role) => [role.id, role.name, role.builtin, role.people])).toEqual([
      [alpha, "alpha", false, 1],
      [zeta, "Zeta", false, 0],
    ]);
    // The manager above is an engineer.
    expect(list.find((role) => role.id === "engineer")!.people).toBe(1);
  });

  test("someone who manages the team reads the roles, and no head count", async () => {
    const { owner, manager } = await start();
    await owner.mutation(api.roles.create, product);
    const list = await manager.query(api.roles.list, {});
    expect(list.map((role) => role.name)).toEqual(["Co-founder", "Sales", "Engineer", "Product"]);
    // How many are on the team in all is the owner's to know.
    for (const role of list) expect(role.people).toBeNull();
  });
});

describe("roles.create", () => {
  test("stores the cleaned name, the focus and the usual pages in the table's order", async () => {
    const { t, owner } = await start();
    await owner.mutation(api.roles.create, {
      name: "  Customer   success ",
      focus: "customers",
      areas: ["board", "customers"],
    });
    const [row] = await roleRows(t);
    expect(row).toMatchObject({
      name: "Customer success",
      nameKey: "customer success",
      focus: "customers",
      areas: ["customers", "board"],
    });
  });

  test("a name already there is refused, whatever its capitals", async () => {
    const { t, owner } = await start();
    await owner.mutation(api.roles.create, product);
    await expect(
      owner.mutation(api.roles.create, { ...product, name: " PRODUCT " }),
    ).rejects.toThrow(ROLE_NAME_TAKEN);
    expect(await roleRows(t)).toHaveLength(1);
  });

  test.each(["Owner", "co-founder", "SALES", "Engineer"])(
    "a built-in name (%s) is refused",
    async (name) => {
      const { t, owner } = await start();
      await expect(owner.mutation(api.roles.create, { ...product, name })).rejects.toThrow(
        ROLE_NAME_TAKEN,
      );
      expect(await roleRows(t)).toEqual([]);
    },
  );

  test("a blank or over-long name is refused", async () => {
    const { owner } = await start();
    await expect(owner.mutation(api.roles.create, { ...product, name: "  " })).rejects.toThrow(
      "A role needs a name.",
    );
    await expect(
      owner.mutation(api.roles.create, { ...product, name: "x".repeat(41) }),
    ).rejects.toThrow("That name is too long (40 characters at most).");
  });

  test.each([...SENSITIVE_AREAS, "today", "admin", "personal"])(
    "%s can never be among a role's usual pages",
    async (area) => {
      const { t, owner } = await start();
      await expect(
        owner.mutation(api.roles.create, { ...product, areas: ["board", area] }),
      ).rejects.toThrow(PRESET_IS_ORDINARY);
      expect(await roleRows(t)).toEqual([]);
    },
  );

  test("the thirty-first is refused", async () => {
    const { t, owner } = await start();
    for (let n = 0; n < MAX_ROLES; n++) {
      await owner.mutation(api.roles.create, { ...product, name: `Role ${n}` });
    }
    await expect(
      owner.mutation(api.roles.create, { ...product, name: "One more" }),
    ).rejects.toThrow(ROLES_FULL);
    expect(await roleRows(t)).toHaveLength(MAX_ROLES);
  });

  test("someone who manages the team cannot add one", async () => {
    const { t, manager } = await start();
    await expect(manager.mutation(api.roles.create, product)).rejects.toThrow("not_owner");
    expect(await roleRows(t)).toEqual([]);
  });
});

describe("roles.update", () => {
  test("renames, and changes the focus and the usual pages", async () => {
    const { t, owner } = await start();
    const id = await owner.mutation(api.roles.create, product);
    await owner.mutation(api.roles.update, {
      id,
      name: "Product lead",
      focus: "general",
      areas: ["scorecard"],
    });
    expect((await roleRows(t))[0]).toMatchObject({
      name: "Product lead",
      nameKey: "product lead",
      focus: "general",
      areas: ["scorecard"],
    });
  });

  test("its own name in other capitals is a rename; another role's name is refused", async () => {
    const { t, owner } = await start();
    const id = await owner.mutation(api.roles.create, product);
    await owner.mutation(api.roles.create, { ...product, name: "Design" });
    await owner.mutation(api.roles.update, { id, ...product, name: "PRODUCT" });
    expect((await roleRows(t)).map((row) => row.name).sort()).toEqual(["Design", "PRODUCT"]);
    await expect(
      owner.mutation(api.roles.update, { id, ...product, name: "design" }),
    ).rejects.toThrow(ROLE_NAME_TAKEN);
    await expect(
      owner.mutation(api.roles.update, { id, ...product, name: "Sales" }),
    ).rejects.toThrow(ROLE_NAME_TAKEN);
  });

  test("a sensitive page is refused there too", async () => {
    const { t, owner } = await start();
    const id = await owner.mutation(api.roles.create, product);
    await expect(
      owner.mutation(api.roles.update, { id, ...product, areas: ["team"] }),
    ).rejects.toThrow(PRESET_IS_ORDINARY);
    expect((await roleRows(t))[0]!.areas).toEqual(["product", "board"]);
  });

  test("a role that is gone is said to be gone", async () => {
    const { owner } = await start();
    const id = await owner.mutation(api.roles.create, product);
    await owner.mutation(api.roles.remove, { id });
    await expect(owner.mutation(api.roles.update, { id, ...product })).rejects.toThrow(ROLE_GONE);
  });

  test("someone who manages the team cannot rename one", async () => {
    const { t, owner, manager } = await start();
    const id = await owner.mutation(api.roles.create, product);
    await expect(
      manager.mutation(api.roles.update, { id, ...product, name: "Mine now" }),
    ).rejects.toThrow("not_owner");
    expect((await roleRows(t))[0]!.name).toBe("Product");
  });

  test("changing a role's usual pages changes nobody's pages", async () => {
    const { t, owner } = await start();
    const id = await owner.mutation(api.roles.create, product);
    await owner.mutation(api.team.add, {
      email: PERSON,
      role: id,
      companies: ["us"],
      areas: ["product", "board"],
    });
    await owner.mutation(api.roles.update, {
      id,
      ...product,
      areas: ["scorecard", "finance", "sales"],
    });
    const person = (await memberRows(t)).find((row) => row.email === PERSON)!;
    expect(person.areas).toEqual(["product", "board"]);
    const client = await signInAs(t, { email: PERSON, emailVerificationTime: 1 });
    expect((await client.query(api.viewer.me, {}))!.areas).toEqual(["product", "board"]);
    // And the other way: emptying the usual pages takes nothing away.
    await owner.mutation(api.roles.update, { id, ...product, areas: [] });
    expect((await client.query(api.viewer.me, {}))!.areas).toEqual(["product", "board"]);
  });
});

describe("roles.remove", () => {
  test("a role nobody has is deleted", async () => {
    const { t, owner } = await start();
    const id = await owner.mutation(api.roles.create, product);
    await owner.mutation(api.roles.remove, { id });
    expect(await roleRows(t)).toEqual([]);
  });

  test("a role people have is refused, with how many, and nobody is changed", async () => {
    const { t, owner } = await start();
    const id = await owner.mutation(api.roles.create, product);
    await addMember(t, { email: PERSON, role: id, areas: ["board"] });
    await expect(owner.mutation(api.roles.remove, { id })).rejects.toThrow(
      "1 person has this role. Give them another role first.",
    );
    await addMember(t, { email: "second@gmail.com", role: id, areas: [] });
    await expect(owner.mutation(api.roles.remove, { id })).rejects.toThrow(
      "2 people have this role. Give them another role first.",
    );
    expect(await roleRows(t)).toHaveLength(1);
    expect((await memberRows(t)).filter((row) => row.role === id)).toHaveLength(2);
  });

  test("someone who manages the team cannot delete one", async () => {
    const { t, owner, manager } = await start();
    const id = await owner.mutation(api.roles.create, product);
    await expect(manager.mutation(api.roles.remove, { id })).rejects.toThrow("not_owner");
    expect(await roleRows(t)).toHaveLength(1);
  });

  test("a built-in is not a row, so nothing names one to change or delete", () => {
    // `roles.update` and `roles.remove` take a `roles` id; "sales" is not one.
    expect(BUILTIN_IS_FIXED).toBe("A built-in role cannot be changed or deleted.");
  });
});

describe("giving someone a role", () => {
  test("the owner and a manager both give a named role, and it is only a label", async () => {
    const { t, owner, manager } = await start();
    const id = await owner.mutation(api.roles.create, {
      ...product,
      areas: ["finance", "sales", "board"],
    });
    await manager.mutation(api.team.add, {
      email: PERSON,
      role: id,
      companies: ["us"],
      areas: ["board"],
    });
    const person = (await memberRows(t)).find((row) => row.email === PERSON)!;
    expect(person.role).toBe(id);
    // The pages that were saved, not the role's usual ones.
    const client = await signInAs(t, { email: PERSON, emailVerificationTime: 1 });
    expect((await client.query(api.viewer.me, {}))!.areas).toEqual(["board"]);
    await expect(client.query(api.deals.board, { market: "us" })).rejects.toThrow("not_allowed");

    await owner.mutation(api.team.update, {
      id: person._id,
      role: "sales",
      companies: ["us"],
      areas: ["board"],
    });
    expect((await memberRows(t)).find((row) => row.email === PERSON)!.role).toBe("sales");
  });

  test("a manager's change of someone's role is written down", async () => {
    const { t, owner, manager } = await start();
    const id = await owner.mutation(api.roles.create, product);
    const person = await addMember(t, { email: PERSON, role: "sales", areas: ["board"] });
    await manager.mutation(api.team.update, {
      id: person,
      role: id,
      companies: ["us", "kz"],
      areas: ["board"],
    });
    const changes = await owner.query(api.team.changes, {});
    expect(changes.rows).toHaveLength(1);
    expect(changes.rows[0]!.before).toMatchObject({ role: "sales", roleName: "Sales" });
    expect(changes.rows[0]!.after).toMatchObject({ role: id, roleName: "Product" });
  });

  test("a role that is gone cannot be given", async () => {
    const { t, owner } = await start();
    const id = await owner.mutation(api.roles.create, product);
    await owner.mutation(api.roles.remove, { id });
    await expect(
      owner.mutation(api.team.add, { email: PERSON, role: id, companies: ["us"], areas: [] }),
    ).rejects.toThrow(ROLE_GONE);
    const person = await addMember(t, { email: PERSON, role: "sales", areas: [] });
    await expect(
      owner.mutation(api.team.update, { id: person, role: id, companies: ["us"], areas: [] }),
    ).rejects.toThrow(ROLE_GONE);
    expect((await memberRows(t)).find((row) => row.email === PERSON)!.role).toBe("sales");
  });

  test("team.list says each person's role by name, with its focus", async () => {
    const { t, owner } = await start();
    const id = await owner.mutation(api.roles.create, product);
    await addMember(t, { email: PERSON, role: id, areas: ["board"] });
    const list = await owner.query(api.team.list, {});
    const shown = (email: string) => {
      const row = list.find((member) => member.email === email)!;
      return [row.role, row.roleName, row.focus];
    };
    expect(shown(PERSON)).toEqual([id, "Product", "engineering"]);
    expect(shown(MANAGER)).toEqual(["engineer", "Engineer", "engineering"]);
    // A rename shows everywhere at once: nothing about it is stored on a person.
    await owner.mutation(api.roles.update, { id, ...product, name: "Product lead" });
    expect(
      (await owner.query(api.team.list, {})).find((member) => member.email === PERSON)!.roleName,
    ).toBe("Product lead");
  });
});

describe("a row from before roles could be named", () => {
  test.each(["cofounder", "sales", "engineer"] as const)(
    "a stored %s with no list of its own still has that role's pages, name and focus",
    async (role) => {
      const t = convexTest(schema, modules);
      // As `team.add` wrote it then: a role word and no `areas`.
      await addMember(t, { email: PERSON, role });
      const client = await signInAs(t, { email: PERSON, emailVerificationTime: 1 });
      const me = await client.query(api.viewer.me, {});
      expect(me).toMatchObject({
        role,
        areas: [...areasOf(role)],
        roleName: { cofounder: "Co-founder", sales: "Sales", engineer: "Engineer" }[role],
        focus: { cofounder: "founder", sales: "sales", engineer: "engineering" }[role],
      });
    },
  );
});

describe("viewer.me: the role's name and focus", () => {
  test("the owner is the Owner, arranged as a founder", async () => {
    const t = convexTest(schema, modules);
    const me = await (await signInAsOwner(t)).query(api.viewer.me, {});
    expect(me).toMatchObject({ role: "owner", roleName: "Owner", focus: "founder" });
  });

  test("a named role's name and focus, and a change of either at once", async () => {
    const { t, owner } = await start();
    const id = await owner.mutation(api.roles.create, { ...product, focus: "marketing" });
    await addMember(t, { email: PERSON, role: id, areas: ["board"] });
    const client = await signInAs(t, { email: PERSON, emailVerificationTime: 1 });
    expect(await client.query(api.viewer.me, {})).toMatchObject({
      role: "custom",
      roleName: "Product",
      focus: "marketing",
      areas: ["board"],
    });
    await owner.mutation(api.roles.update, { id, ...product, name: "Growth", focus: "sales" });
    expect(await client.query(api.viewer.me, {})).toMatchObject({
      roleName: "Growth",
      focus: "sales",
      // The focus arranges; it gave nothing.
      areas: ["board"],
    });
  });

  test("a role that is gone is no role, arranged as general, with the person's pages as they were", async () => {
    const { t, owner } = await start();
    const id = await owner.mutation(api.roles.create, { ...product, focus: "finance" });
    await addMember(t, { email: PERSON, role: id, areas: ["board", "finance"] });
    // Deleted behind the mutation's back, as a row removed by hand would be.
    await t.run((ctx) => ctx.db.delete(id));
    const client = await signInAs(t, { email: PERSON, emailVerificationTime: 1 });
    expect(await client.query(api.viewer.me, {})).toMatchObject({
      role: "custom",
      roleName: "No role",
      focus: "general",
      areas: ["finance", "board"],
    });
  });

  test("a named role with no list of its own has no page: the role gives nothing", async () => {
    const { t, owner } = await start();
    const id = await owner.mutation(api.roles.create, {
      ...product,
      areas: ["finance", "sales"],
    });
    await addMember(t, { email: PERSON, role: id });
    const client = await signInAs(t, { email: PERSON, emailVerificationTime: 1 });
    expect((await client.query(api.viewer.me, {}))!.areas).toEqual([]);
    await expect(client.query(api.metrics.scorecard, {})).rejects.toThrow("not_allowed");
  });
});

describe("a GitHub username", () => {
  const engineer = async (t: TestBackend, email: string, areas: GrantableArea[] = ["engineering"]) => {
    const id = await addMember(t, { email, role: "engineer", areas });
    return { id, client: await signInAs(t, { email, emailVerificationTime: 1 }) };
  };

  test("the owner sets one on a teammate, who reads their own back", async () => {
    const { t, owner } = await start();
    const { id, client } = await engineer(t, PERSON);
    expect(await client.query(api.team.myGithub, {})).toEqual({ login: null });
    await owner.mutation(api.team.update, {
      id,
      role: "engineer",
      companies: ["us", "kz"],
      areas: ["engineering"],
      github: "@Octo-Cat",
    });
    expect(await client.query(api.team.myGithub, {})).toEqual({ login: "Octo-Cat" });
    // Left out keeps it; blank clears it.
    const same = { id, role: "engineer" as const, companies: ["us" as const], areas: ["engineering"] };
    await owner.mutation(api.team.update, same);
    expect(await client.query(api.team.myGithub, {})).toEqual({ login: "Octo-Cat" });
    await owner.mutation(api.team.update, { ...same, github: " " });
    expect(await client.query(api.team.myGithub, {})).toEqual({ login: null });
  });

  test("it is set when adding, and shown to whoever is sent the row", async () => {
    const { owner, manager } = await start();
    await owner.mutation(api.team.add, {
      email: PERSON,
      role: "engineer",
      companies: ["us"],
      areas: ["engineering"],
      github: "octo-cat",
    });
    for (const client of [owner, manager]) {
      const row = (await client.query(api.team.list, {})).find((m) => m.email === PERSON)!;
      expect(row.github).toBe("octo-cat");
    }
  });

  test("one that is no username is refused in fixed words", async () => {
    const { t, owner } = await start();
    await expect(
      owner.mutation(api.team.add, {
        email: PERSON,
        role: "engineer",
        companies: ["us"],
        areas: [],
        github: "SECRET name",
      }),
    ).rejects.toThrow(GITHUB_NOT_A_USERNAME);
    expect((await memberRows(t)).some((row) => row.email === PERSON)).toBe(false);
  });

  test("one already on another person is refused, whatever its capitals, for a teammate and the owner", async () => {
    const { t, owner } = await start();
    const { id } = await engineer(t, PERSON);
    const other = await engineer(t, "other@gmail.com");
    const set = (member: Id<"members">, github: string) =>
      owner.mutation(api.team.update, {
        id: member,
        role: "engineer",
        companies: ["us"],
        areas: ["engineering"],
        github,
      });
    await set(id, "octo-cat");
    await expect(set(other.id, "OCTO-CAT")).rejects.toThrow(GITHUB_TAKEN);
    await expect(owner.mutation(api.team.setMyGithub, { github: "Octo-cat" })).rejects.toThrow(
      GITHUB_TAKEN,
    );
    // Their own, sent again in other capitals, is theirs.
    await set(id, "Octo-Cat");
    // And the owner's own is taken for a teammate.
    await owner.mutation(api.team.setMyGithub, { github: "the-owner" });
    await expect(set(other.id, "The-Owner")).rejects.toThrow(GITHUB_TAKEN);
    await expect(
      owner.mutation(api.team.add, {
        email: "third@gmail.com",
        role: "engineer",
        companies: ["us"],
        areas: [],
        github: "the-owner",
      }),
    ).rejects.toThrow(GITHUB_TAKEN);
  });

  test("the owner's own is kept apart from the team, set and cleared by the owner", async () => {
    const { t, owner } = await start();
    expect(await owner.query(api.team.myGithub, {})).toEqual({ login: null });
    await owner.mutation(api.team.setMyGithub, { github: "@the-owner" });
    expect(await owner.query(api.team.myGithub, {})).toEqual({ login: "the-owner" });
    await owner.mutation(api.team.setMyGithub, { github: "the-owner-2" });
    expect(await t.run((ctx) => ctx.db.query("ownerProfiles").collect())).toHaveLength(1);
    await owner.mutation(api.team.setMyGithub, { github: "" });
    expect(await owner.query(api.team.myGithub, {})).toEqual({ login: null });
    await expect(owner.mutation(api.team.setMyGithub, { github: "no spaces" })).rejects.toThrow(
      GITHUB_NOT_A_USERNAME,
    );
  });

  test("someone who manages the team cannot set one, on an add or a change, whatever it says", async () => {
    const { t, manager } = await start();
    const { id } = await engineer(t, PERSON);
    await expect(
      manager.mutation(api.team.add, {
        email: "new@gmail.com",
        role: "sales",
        companies: ["us"],
        areas: [],
        github: "octo-cat",
      }),
    ).rejects.toThrow(GITHUB_IS_THE_OWNERS);
    for (const github of ["octo-cat", "", null]) {
      await expect(
        manager.mutation(api.team.update, {
          id,
          role: "engineer",
          companies: ["us", "kz"],
          areas: ["engineering"],
          github,
        }),
      ).rejects.toThrow(GITHUB_IS_THE_OWNERS);
    }
    expect((await memberRows(t)).find((row) => row.email === PERSON)!.github).toBeUndefined();
    await expect(manager.mutation(api.team.setMyGithub, { github: "x" })).rejects.toThrow(
      "not_owner",
    );
  });

  test("a person reads only their own, and only with the engineering page", async () => {
    const { t, owner } = await start();
    const first = await engineer(t, PERSON);
    const second = await engineer(t, "other@gmail.com");
    await owner.mutation(api.team.update, {
      id: first.id,
      role: "engineer",
      companies: ["us"],
      areas: ["engineering"],
      github: "octo-cat",
    });
    await owner.mutation(api.team.setMyGithub, { github: "the-owner" });
    expect(await second.client.query(api.team.myGithub, {})).toEqual({ login: null });
    const without = await engineer(t, "board.only@gmail.com", ["board"]);
    await expect(without.client.query(api.team.myGithub, {})).rejects.toThrow("not_allowed");
  });
});
