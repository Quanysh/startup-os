import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  GRANTABLE_AREAS,
  MAX_MEMBERS,
  SENSITIVE_AREAS,
  areasOf,
  type GrantableArea,
} from "./lib/roles";
import schema from "./schema";
import { defineSchema } from "convex/server";
import {
  CANNOT_ADD_FROM_HERE,
  CANNOT_CHANGE_MANAGER,
  CANNOT_CHANGE_SELF,
  NO_COMPANY_ON_RECORD,
  SENSITIVE_ARE_THE_OWNERS,
} from "./team";
import {
  OWNER,
  addMember,
  modules,
  signInAs,
  signInAsOwner,
  type TestBackend,
} from "./test.setup";

// The `team` area: a teammate the owner ticked it for reads and changes the
// team, within their own companies. The owner's intent: such a person can
// help run things, and can never widen their own access, lock the owner out
// or act as someone else. What keeps it to that is tested here:
//
// - nothing that is the owner's alone can be given, by anyone;
// - the two sensitive areas are given and taken by the owner alone (payroll
//   and costs by nobody: convex/ownerOnlyAreas.test.ts), and
//   someone who manages the team is changed by the owner alone;
// - a Telegram username and its link are the owner's alone to set and reset;
// - the owner is not a row, so there is nothing of the owner's to change;
// - a manager works within their own companies: they are told of the people
//   who share one, change only people who are on no other, and cannot put
//   anyone on a company they are not on themselves;
// - a manager cannot change or remove themselves;
// - every change a manager makes is written down for the owner alone, who
//   can reach all of it, with what widened someone's reach kept at the top.

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

type Company = "us" | "kz";
const MANAGER = "manager@gmail.com";
const NOT_ON_TEAM = "That person is no longer on the team.";
const OWNERS_ONLY =
  "The owner's own mail, calendar and meeting notes, and the work-tool settings, are the owner's only.";

const rows = (t: TestBackend) => t.run((ctx) => ctx.db.query("members").collect());
const changes = (t: TestBackend) => t.run((ctx) => ctx.db.query("teamChanges").collect());
const rowOf = async (t: TestBackend, email: string) =>
  (await rows(t)).find((row) => row.email === email)!;

/**
 * A team with a manager (the `team` area and nothing else) on the given
 * companies, and one teammate on each company and one on both.
 */
async function start(companies: Company[] = ["us", "kz"], areas: GrantableArea[] = ["team"]) {
  const t = convexTest(schema, modules);
  const managerId = await addMember(t, { email: MANAGER, role: "engineer", companies, areas });
  const usId = await addMember(t, {
    email: "us.person@gmail.com",
    role: "sales",
    companies: ["us"],
    areas: ["sales"],
  });
  const kzId = await addMember(t, {
    email: "kz.person@gmail.com",
    role: "sales",
    companies: ["kz"],
    areas: ["sales"],
  });
  const bothId = await addMember(t, {
    email: "both.person@gmail.com",
    role: "cofounder",
    companies: ["us", "kz"],
    areas: ["finance"],
  });
  const manager = await signInAs(t, { email: MANAGER, emailVerificationTime: 1 });
  return { t, manager, managerId, usId, kzId, bothId };
}

const NEW = {
  email: "new.person@gmail.com",
  role: "sales" as const,
  companies: ["kz" as const],
  areas: ["sales"],
};
const edit = (id: Id<"members">, change: Partial<{ companies: Company[]; areas: string[] }> = {}) => ({
  id,
  role: "sales" as const,
  companies: ["kz" as const],
  areas: ["sales"],
  ...change,
});

describe("a manager reads the team", () => {
  test("on both companies: everyone, with themselves marked and not theirs to change", async () => {
    const { manager } = await start();
    const list = await manager.query(api.team.list, {});
    expect(list.map((person) => person.email).sort()).toEqual([
      "both.person@gmail.com",
      "kz.person@gmail.com",
      MANAGER,
      "us.person@gmail.com",
    ]);
    const me = list.find((person) => person.email === MANAGER)!;
    expect(me).toMatchObject({ self: true, editable: false, areas: ["team"] });
    for (const person of list.filter((one) => one.email !== MANAGER)) {
      expect(person).toMatchObject({ self: false, editable: true });
    }
  });

  test("on one company: only the people who share it, and those on another too are read-only", async () => {
    const { manager } = await start(["kz"]);
    const list = await manager.query(api.team.list, {});
    expect(list.map((person) => person.email).sort()).toEqual([
      "both.person@gmail.com",
      "kz.person@gmail.com",
      MANAGER,
    ]);
    expect(JSON.stringify(list)).not.toContain("us.person");
    expect(list.find((person) => person.email === "kz.person@gmail.com")?.editable).toBe(true);
    expect(list.find((person) => person.email === "both.person@gmail.com")?.editable).toBe(false);
  });

  test("the owner is not in the list, for a manager or for the owner", async () => {
    const { t, manager } = await start();
    const owner = await signInAsOwner(t);
    for (const client of [manager, owner]) {
      const list = await client.query(api.team.list, {});
      expect(JSON.stringify(list)).not.toContain(OWNER);
    }
    // The owner reads everyone, and may change everyone.
    const all = await owner.query(api.team.list, {});
    expect(all).toHaveLength(4);
    expect(all.every((person) => person.editable && !person.self)).toBe(true);
  });

  test("no list ever names an area that is the owner's alone", async () => {
    const { t, manager } = await start();
    // A row cannot hold them (the schema refuses); a row with no list of its
    // own has its role's, which never has them either.
    await addMember(t, { email: "old.row@gmail.com", role: "cofounder" });
    const list = await manager.query(api.team.list, {});
    for (const person of list) {
      expect(person.areas).not.toContain("personal");
      expect(person.areas).not.toContain("admin");
    }
  });
});

describe("a manager adds a teammate", () => {
  test("on a company of their own, with any ordinary page", async () => {
    const { t, manager } = await start(["kz"]);
    const ordinary = GRANTABLE_AREAS.filter(
      (area) => !(SENSITIVE_AREAS as readonly string[]).includes(area),
    );
    await manager.mutation(api.team.add, { ...NEW, areas: [...ordinary] });
    const row = await rowOf(t, NEW.email);
    expect(row).toMatchObject({ companies: ["kz"], areas: [...ordinary] });
    for (const area of SENSITIVE_AREAS) expect(row.areas).not.toContain(area);
    // Added by the manager, not by an owner.
    expect((await t.run((ctx) => ctx.db.get(row.addedBy)))?.email).toBe(MANAGER);
  });

  test("never with an area that is the owner's alone", async () => {
    const { t, manager } = await start();
    for (const areas of [["personal"], ["admin"], ["sales", "personal"]]) {
      await expect(manager.mutation(api.team.add, { ...NEW, areas })).rejects.toThrow(OWNERS_ONLY);
    }
    expect(await rows(t)).toHaveLength(4);
  });

  test("never on a company they are not on, alone or beside their own", async () => {
    const { t, manager } = await start(["kz"]);
    for (const companies of [["us"], ["us", "kz"]] as Company[][]) {
      await expect(manager.mutation(api.team.add, { ...NEW, companies })).rejects.toThrow(
        "not_allowed",
      );
    }
    expect(await rows(t)).toHaveLength(4);
    expect(await changes(t)).toEqual([]);
  });

  test("never the owner", async () => {
    const { t, manager } = await start();
    await expect(manager.mutation(api.team.add, { ...NEW, email: OWNER })).rejects.toThrow(
      "That address is an owner's. An owner is not added to the team.",
    );
    expect(await rows(t)).toHaveLength(4);
  });
});

describe("a manager changes a teammate", () => {
  test("one on their own companies: pages, role and companies", async () => {
    const { t, manager, kzId } = await start(["kz"]);
    await manager.mutation(api.team.update, edit(kzId, { areas: ["board", "finance"] }));
    expect(await t.run((ctx) => ctx.db.get(kzId))).toMatchObject({
      companies: ["kz"],
      areas: ["finance", "board"],
    });
  });

  test("never to give an area that is the owner's alone", async () => {
    const { t, manager, kzId } = await start();
    await expect(
      manager.mutation(api.team.update, edit(kzId, { areas: ["sales", "personal"] })),
    ).rejects.toThrow(OWNERS_ONLY);
    await expect(
      manager.mutation(api.team.update, edit(kzId, { areas: ["admin"] })),
    ).rejects.toThrow(OWNERS_ONLY);
    expect((await t.run((ctx) => ctx.db.get(kzId)))?.areas).toEqual(["sales"]);
  });

  test("never to put them on a company the manager is not on", async () => {
    const { t, manager, kzId } = await start(["kz"]);
    for (const companies of [["us"], ["us", "kz"]] as Company[][]) {
      await expect(manager.mutation(api.team.update, edit(kzId, { companies }))).rejects.toThrow(
        "not_allowed",
      );
    }
    expect((await t.run((ctx) => ctx.db.get(kzId)))?.companies).toEqual(["kz"]);
    expect(await changes(t)).toEqual([]);
  });

  test("never someone on a company the manager is not on: by id, changed or removed", async () => {
    const { t, manager, usId, bothId } = await start(["kz"]);
    const before = await rows(t);
    for (const id of [usId, bothId]) {
      // Even a change that would leave them on the manager's company alone.
      await expect(manager.mutation(api.team.update, edit(id))).rejects.toThrow("not_allowed");
      await expect(manager.mutation(api.team.remove, { id })).rejects.toThrow("not_allowed");
    }
    expect(await rows(t)).toEqual(before);
    expect(await changes(t)).toEqual([]);
  });

  test("the same the other way round, for a manager on Startup", async () => {
    const { t, manager, kzId, usId } = await start(["us"]);
    await expect(manager.mutation(api.team.update, { ...edit(kzId), companies: ["us"] })).rejects.toThrow(
      "not_allowed",
    );
    await expect(manager.mutation(api.team.remove, { id: kzId })).rejects.toThrow("not_allowed");
    await manager.mutation(api.team.remove, { id: usId });
    expect((await rows(t)).map((row) => row.email)).not.toContain("us.person@gmail.com");
  });

  test("someone already gone is said in the usual words", async () => {
    const { t, manager, kzId } = await start();
    await t.run((ctx) => ctx.db.delete(kzId));
    await expect(manager.mutation(api.team.update, edit(kzId))).rejects.toThrow(NOT_ON_TEAM);
    expect(await manager.mutation(api.team.remove, { id: kzId })).toBeNull();
    expect(await changes(t)).toEqual([]);
  });
});

// The owner's intent: a teammate they tick can help run things, and can never
// widen their own access, lock the owner out or keep the page once it is
// taken away. So the two sensitive areas are given and taken by the owner
// alone, and so is any change to someone who manages the team.
describe("only the owner hands out or takes away the sensitive areas", () => {
  test("the words are fixed, and name nobody", () => {
    expect(SENSITIVE_ARE_THE_OWNERS).toBe("Only the owner gives Sources and Telegram, or Team.");
    expect(CANNOT_CHANGE_MANAGER).toBe(
      "Only the owner changes or removes someone who manages the team.",
    );
  });

  test.each(SENSITIVE_AREAS)("a manager cannot add someone with %s, alone or among other pages", async (area) => {
    const { t, manager } = await start();
    for (const areas of [[area], ["sales", area], [...GRANTABLE_AREAS]]) {
      await expect(manager.mutation(api.team.add, { ...NEW, areas })).rejects.toThrow(
        SENSITIVE_ARE_THE_OWNERS,
      );
    }
    expect(await rows(t)).toHaveLength(4);
    expect(await changes(t)).toEqual([]);
  });

  test.each(SENSITIVE_AREAS)("a manager cannot give %s to someone already on the team", async (area) => {
    const { t, manager, kzId } = await start();
    await expect(
      manager.mutation(api.team.update, edit(kzId, { areas: ["sales", area] })),
    ).rejects.toThrow(SENSITIVE_ARE_THE_OWNERS);
    expect((await t.run((ctx) => ctx.db.get(kzId)))?.areas).toEqual(["sales"]);
    expect(await changes(t)).toEqual([]);
  });

  test("a manager cannot take someone's Sources and Telegram away either: what the owner gave stays as it is", async () => {
    const { t, manager, kzId } = await start();
    await t.run((ctx) => ctx.db.patch(kzId, { areas: ["sales", "settings"] }));
    for (const areas of [["sales"], []]) {
      await expect(manager.mutation(api.team.update, edit(kzId, { areas }))).rejects.toThrow(
        SENSITIVE_ARE_THE_OWNERS,
      );
    }
    // Nor swap one for another.
    await expect(
      manager.mutation(api.team.update, edit(kzId, { areas: ["sales", "team"] })),
    ).rejects.toThrow(SENSITIVE_ARE_THE_OWNERS);
    expect((await t.run((ctx) => ctx.db.get(kzId)))?.areas).toEqual(["sales", "settings"]);
  });

  test("the ordinary edit is theirs: pages, role and companies, with the sensitive ones sent back as they were", async () => {
    const { t, manager, kzId } = await start();
    await t.run((ctx) => ctx.db.patch(kzId, { areas: ["sales", "settings"] }));
    await manager.mutation(api.team.update, {
      id: kzId,
      role: "engineer",
      companies: ["us", "kz"],
      areas: ["board", "finance", "settings"],
    });
    expect(await t.run((ctx) => ctx.db.get(kzId))).toMatchObject({
      role: "engineer",
      companies: ["us", "kz"],
      areas: ["finance", "board", "settings"],
    });
    expect(await changes(t)).toHaveLength(1);
  });

  test("the owner still gives and takes both", async () => {
    const { t, kzId } = await start();
    const owner = await signInAsOwner(t);
    await owner.mutation(api.team.update, edit(kzId, { areas: [...SENSITIVE_AREAS] }));
    expect((await t.run((ctx) => ctx.db.get(kzId)))?.areas).toEqual([...SENSITIVE_AREAS]);
    await owner.mutation(api.team.update, edit(kzId, { areas: [] }));
    await owner.mutation(api.team.add, { ...NEW, areas: ["team"] });
    expect((await rowOf(t, NEW.email)).areas).toEqual(["team"]);
  });
});

describe("only the owner edits someone who manages the team", () => {
  /** A second manager, on both companies. */
  const second = async (t: TestBackend) => {
    const id = await addMember(t, {
      email: "second.manager@gmail.com",
      role: "sales",
      companies: ["us", "kz"],
      areas: ["team", "sales"],
    });
    return { id, client: await signInAs(t, { email: "second.manager@gmail.com", emailVerificationTime: 1 }) };
  };

  test("the reviewer's scenario: a manager cannot make an accomplice who gives the page back", async () => {
    const { t, manager, managerId } = await start();
    const owner = await signInAsOwner(t);
    // 1. The manager adds a second account of theirs, and tries to make it a manager.
    await expect(manager.mutation(api.team.add, { ...NEW, areas: ["team"] })).rejects.toThrow(
      SENSITIVE_ARE_THE_OWNERS,
    );
    const accomplice = await manager.mutation(api.team.add, NEW);
    await expect(
      manager.mutation(api.team.update, edit(accomplice, { areas: ["sales", "team"] })),
    ).rejects.toThrow(SENSITIVE_ARE_THE_OWNERS);
    const other = await signInAs(t, { email: NEW.email, emailVerificationTime: 1 });
    await expect(other.query(api.team.list, {})).rejects.toThrow("not_allowed");
    // 2. The owner unticks Team for the manager.
    await owner.mutation(api.team.update, {
      id: managerId,
      role: "engineer",
      companies: ["us", "kz"],
      areas: ["board"],
    });
    // 3. Nobody but the owner can give it back.
    await expect(
      other.mutation(api.team.update, {
        id: managerId,
        role: "engineer",
        companies: ["us", "kz"],
        areas: [...GRANTABLE_AREAS],
      }),
    ).rejects.toThrow("not_allowed");
    expect((await rowOf(t, MANAGER)).areas).toEqual(["board"]);
  });

  test("even with a second manager the owner made: neither changes, resets or removes the other", async () => {
    const { t, manager, managerId } = await start();
    const { id, client } = await second(t);
    const before = await rows(t);
    for (const [who, target] of [
      [manager, id],
      [client, managerId],
    ] as const) {
      const row = (await t.run((ctx) => ctx.db.get(target)))!;
      const same = { id: target, role: row.role, companies: row.companies, areas: row.areas! };
      await expect(who.mutation(api.team.update, same)).rejects.toThrow(CANNOT_CHANGE_MANAGER);
      await expect(
        who.mutation(api.team.update, { ...same, areas: [...GRANTABLE_AREAS] }),
      ).rejects.toThrow(CANNOT_CHANGE_MANAGER);
      await expect(who.mutation(api.team.update, { ...same, areas: [] })).rejects.toThrow(
        CANNOT_CHANGE_MANAGER,
      );
      // Resetting a link is the owner's alone, whoever it is.
      await expect(who.mutation(api.team.resetTelegram, { id: target })).rejects.toThrow("not_owner");
      await expect(who.mutation(api.team.remove, { id: target })).rejects.toThrow(
        CANNOT_CHANGE_MANAGER,
      );
    }
    expect(await rows(t)).toEqual(before);
    expect(await changes(t)).toEqual([]);
  });

  test("so once the owner unticks Team for one, the other cannot tick it again", async () => {
    const { t, manager, managerId } = await start();
    const { client } = await second(t);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.team.update, {
      id: managerId,
      role: "engineer",
      companies: ["us", "kz"],
      areas: ["board"],
    });
    await expect(
      client.mutation(api.team.update, {
        id: managerId,
        role: "engineer",
        companies: ["us", "kz"],
        areas: ["board", "team"],
      }),
    ).rejects.toThrow(SENSITIVE_ARE_THE_OWNERS);
    await expect(manager.query(api.team.list, {})).rejects.toThrow("not_allowed");
  });

  test("the list says a manager's row is not theirs to change", async () => {
    const { t, manager } = await start();
    const { id } = await second(t);
    const list = await manager.query(api.team.list, {});
    expect(list.find((person) => person.id === id)).toMatchObject({ editable: false, self: false });
  });

  test("a manager on another company only is still refused as beyond their companies, in no new words", async () => {
    const { t, manager } = await start(["kz"]);
    const id = await addMember(t, { email: "us.manager@gmail.com", role: "sales", companies: ["us"], areas: ["team"] });
    await expect(manager.mutation(api.team.remove, { id })).rejects.toThrow("not_allowed");
  });
});

describe("a manager and their own row", () => {
  test("cannot change it: more pages, fewer, another company or the same again", async () => {
    const { t, manager, managerId } = await start(["kz"]);
    const before = await t.run((ctx) => ctx.db.get(managerId));
    for (const change of [
      { areas: [...GRANTABLE_AREAS] },
      { areas: [] },
      { areas: ["team"] },
      { companies: ["us", "kz"] as Company[] },
    ]) {
      await expect(
        manager.mutation(api.team.update, { ...edit(managerId), role: "engineer", ...change }),
      ).rejects.toThrow(CANNOT_CHANGE_SELF);
    }
    expect(await t.run((ctx) => ctx.db.get(managerId))).toEqual(before);
    expect(await changes(t)).toEqual([]);
  });

  test("cannot remove it", async () => {
    const { t, manager, managerId } = await start();
    await expect(manager.mutation(api.team.remove, { id: managerId })).rejects.toThrow(
      CANNOT_CHANGE_SELF,
    );
    expect(await t.run((ctx) => ctx.db.get(managerId))).not.toBeNull();
    // Still signed in: their sessions were not ended on the way.
    await expect(manager.query(api.team.list, {})).resolves.toHaveLength(4);
  });

  test("the words say who can, and quote nobody", () => {
    expect(CANNOT_CHANGE_SELF).toBe("You cannot change or remove yourself. Only the owner can.");
  });

  test("the owner changes and removes a manager like anyone else", async () => {
    const { t, managerId } = await start();
    const owner = await signInAsOwner(t);
    await owner.mutation(api.team.update, { ...edit(managerId), companies: ["us", "kz"] });
    await owner.mutation(api.team.remove, { id: managerId });
    expect(await t.run((ctx) => ctx.db.get(managerId))).toBeNull();
  });
});

describe("the owner is out of a manager's reach", () => {
  test("a row under an owner's address (from before it was one) is the owner's to clear", async () => {
    const { t, manager } = await start();
    // The gate never reads such a row: an owner's address is the owner.
    const stale = await addMember(t, { email: OWNER, role: "engineer", companies: ["kz"], areas: [] });
    const owner = await signInAsOwner(t);
    expect(JSON.stringify(await manager.query(api.team.list, {}))).not.toContain(OWNER);
    await expect(manager.mutation(api.team.update, edit(stale))).rejects.toThrow("not_allowed");
    await expect(manager.mutation(api.team.remove, { id: stale })).rejects.toThrow("not_allowed");
    expect(await t.run((ctx) => ctx.db.get(stale))).not.toBeNull();
    // Removing it would have ended the owner's sessions: they are still there.
    await expect(owner.query(api.viewer.me, {})).resolves.toMatchObject({ isOwner: true });
    // The owner clears it, and stays signed in.
    await owner.mutation(api.team.remove, { id: stale });
    expect(await t.run((ctx) => ctx.db.get(stale))).toBeNull();
    await expect(owner.query(api.viewer.me, {})).resolves.toMatchObject({ isOwner: true });
  });

  test("nothing a manager does touches the owner's sessions or the owner's own records", async () => {
    const { t, manager, kzId } = await start();
    const owner = await signInAsOwner(t);
    await manager.mutation(api.team.update, edit(kzId, { areas: [] }));
    await manager.mutation(api.team.remove, { id: kzId });
    await expect(owner.query(api.viewer.me, {})).resolves.toMatchObject({ isOwner: true });
  });
});

describe("losing the area", () => {
  test("unticked by the owner, it is gone from the manager's next call", async () => {
    const { t, manager, managerId, kzId } = await start();
    const owner = await signInAsOwner(t);
    await manager.query(api.team.list, {});
    await owner.mutation(api.team.update, {
      id: managerId,
      role: "engineer",
      companies: ["us", "kz"],
      areas: ["board"],
    });
    await expect(manager.query(api.team.list, {})).rejects.toThrow("not_allowed");
    await expect(manager.mutation(api.team.add, NEW)).rejects.toThrow("not_allowed");
    await expect(manager.mutation(api.team.update, edit(kzId))).rejects.toThrow("not_allowed");
    await expect(manager.mutation(api.team.remove, { id: kzId })).rejects.toThrow("not_allowed");
    expect(await rows(t)).toHaveLength(4);
  });

  test("a teammate with every other page reads and changes nothing of the team", async () => {
    const others = GRANTABLE_AREAS.filter((area) => area !== "team");
    const { t, manager, kzId } = await start(["us", "kz"], others);
    const before = await rows(t);
    await expect(manager.query(api.team.list, {})).rejects.toThrow("not_allowed");
    await expect(manager.mutation(api.team.add, NEW)).rejects.toThrow("not_allowed");
    await expect(manager.mutation(api.team.update, edit(kzId))).rejects.toThrow("not_allowed");
    await expect(manager.mutation(api.team.remove, { id: kzId })).rejects.toThrow("not_allowed");
    expect(await rows(t)).toEqual(before);
  });

  test("a co-founder's starting set never has it, nor either other sensitive area", () => {
    for (const area of SENSITIVE_AREAS) expect(areasOf("cofounder")).not.toContain(area);
  });

  test("a co-founder with no list of their own is refused the team", async () => {
    const t = convexTest(schema, modules);
    await addMember(t, { email: "old.cofounder@gmail.com", role: "cofounder" });
    const cofounder = await signInAs(t, { email: "old.cofounder@gmail.com", emailVerificationTime: 1 });
    await expect(cofounder.query(api.team.list, {})).rejects.toThrow("not_allowed");
    await expect(cofounder.query(api.payroll.listPeople, { company: "us" })).rejects.toThrow(
      "not_allowed",
    );
    await expect(cofounder.query(api.sources.list, {})).rejects.toThrow("not_allowed");
  });
});

describe("what an add tells a manager of people beyond their companies", () => {
  test("the words name nobody and say nothing of why", () => {
    expect(CANNOT_ADD_FROM_HERE).toBe("That person cannot be added from here.");
  });

  test("an address that is on the team on the other company alone is not said to be: the same words as any other refusal", async () => {
    const { t, manager } = await start(["kz"]);
    // us.person is on Startup alone: a manager on Globex is not told they exist.
    await expect(
      manager.mutation(api.team.add, { ...NEW, email: "us.person@gmail.com" }),
    ).rejects.toThrow(CANNOT_ADD_FROM_HERE);
    await expect(
      manager.mutation(api.team.add, { ...NEW, email: " US.Person@Gmail.com " }),
    ).rejects.toThrow(CANNOT_ADD_FROM_HERE);
    expect(await rows(t)).toHaveLength(4);
    expect(await changes(t)).toEqual([]);
  });

  test("someone they are already sent is said to be on the team, as before", async () => {
    const { manager } = await start(["kz"]);
    for (const email of ["kz.person@gmail.com", "both.person@gmail.com", MANAGER]) {
      await expect(manager.mutation(api.team.add, { ...NEW, email })).rejects.toThrow(
        "That person is already on the team.",
      );
    }
  });

  test("the owner is told plainly either way", async () => {
    const { t } = await start(["kz"]);
    const owner = await signInAsOwner(t);
    await expect(owner.mutation(api.team.add, { ...NEW, email: "us.person@gmail.com" })).rejects.toThrow(
      "That person is already on the team.",
    );
  });

  test("a full team is said to the owner; a manager, who is not sent everyone, gets the neutral words", async () => {
    const { t, manager } = await start(["kz"]);
    for (let i = 0; i < MAX_MEMBERS - 4; i++) {
      await addMember(t, { email: `filler${i}@gmail.com`, role: "sales", companies: ["us"] });
    }
    await expect(manager.mutation(api.team.add, NEW)).rejects.toThrow(CANNOT_ADD_FROM_HERE);
    const owner = await signInAsOwner(t);
    await expect(owner.mutation(api.team.add, NEW)).rejects.toThrow(
      `The team is full (${MAX_MEMBERS} people at most).`,
    );
    expect(await rows(t)).toHaveLength(MAX_MEMBERS);
  });
});

describe("a record with no company", () => {
  // The schema cannot say "at least one", so a row with none could only be
  // written by hand. It is on no company, which must not read as "within
  // every manager's companies".
  const none = (t: TestBackend) =>
    t.run(async (ctx) =>
      ctx.db.insert("members", {
        email: "no.company@gmail.com",
        role: "sales",
        companies: [],
        areas: ["sales"],
        addedAt: 1,
        addedBy: await ctx.db.insert("users", {}),
        telegramUserId: "770001",
      }),
    );

  test("is nobody a manager is sent or can change, reset or remove", async () => {
    const { t, manager } = await start();
    const id = await none(t);
    const before = await rows(t);
    expect((await manager.query(api.team.list, {})).some((person) => person.id === id)).toBe(false);
    await expect(manager.mutation(api.team.update, edit(id))).rejects.toThrow("not_allowed");
    await expect(manager.mutation(api.team.remove, { id })).rejects.toThrow("not_allowed");
    expect(await rows(t)).toEqual(before);
  });

  test("the owner is shown it and can only remove it: nothing else acts on it", async () => {
    const { t } = await start();
    const id = await none(t);
    const owner = await signInAsOwner(t);
    expect(NO_COMPANY_ON_RECORD).toBe(
      "This record has no company. Remove it, then add the person again.",
    );
    expect((await owner.query(api.team.list, {})).find((person) => person.id === id)).toMatchObject({
      companies: [],
    });
    await expect(owner.mutation(api.team.update, edit(id))).rejects.toThrow(NO_COMPANY_ON_RECORD);
    await expect(owner.mutation(api.team.resetTelegram, { id })).rejects.toThrow(NO_COMPANY_ON_RECORD);
    expect((await t.run((ctx) => ctx.db.get(id)))?.telegramUserId).toBe("770001");
    await owner.mutation(api.team.remove, { id });
    expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
  });

  test("such a person is let in to nothing that is a company's", async () => {
    const { t } = await start();
    await none(t);
    const person = await signInAs(t, { email: "no.company@gmail.com", emailVerificationTime: 1 });
    expect(await person.query(api.team.assignable, {}).catch(() => "refused")).toBe("refused");
  });
});

// Each of these fails when the one thing it names is taken out.
describe("guards the review found untested", () => {
  test("a manager's own row is theirs however their address was typed when they signed in", async () => {
    const t = convexTest(schema, modules);
    const managerId = await addMember(t, { email: MANAGER, role: "engineer", areas: ["team", "board"] });
    await addMember(t, { email: "kz.person@gmail.com", role: "sales", companies: ["kz"], areas: ["sales"] });
    // Google's spelling of the address, not the row's.
    const manager = await signInAs(t, { email: "  Manager@Gmail.com ", emailVerificationTime: 1 });
    const list = await manager.query(api.team.list, {});
    expect(list.find((person) => person.id === managerId)).toMatchObject({ self: true, editable: false });
    expect(list.filter((person) => person.self)).toHaveLength(1);
    for (const call of [
      manager.mutation(api.team.update, { ...edit(managerId), role: "engineer", areas: ["team"] }),
      manager.mutation(api.team.remove, { id: managerId }),
    ]) {
      await expect(call).rejects.toThrow(CANNOT_CHANGE_SELF);
    }
  });

  test("an addition says whether a Telegram username came with it", async () => {
    const { t } = await start();
    const owner = await signInAsOwner(t);
    // The owner's are recorded where they widen: here, a sensitive page.
    await owner.mutation(api.team.add, { ...NEW, areas: ["settings"], telegram: "@SECRET_handle" });
    await owner.mutation(api.team.add, { ...NEW, email: "other.new@gmail.com", areas: ["settings"] });
    const stored = await changes(t);
    expect(stored[0]).toMatchObject({ kind: "add", telegramChanged: true });
    expect(stored[1]?.kind).toBe("add");
    expect(stored[1]?.telegramChanged).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain("SECRET_handle");
  });

  test("a company that is none of the OS's on someone's row opens nothing: the gate reads only the two it knows", async () => {
    // Only a row written past the schema can hold one, so the schema is not enforced here.
    const t = convexTest(defineSchema(schema.tables, { schemaValidation: false }), modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("members", {
        email: "odd.company@gmail.com",
        role: "sales",
        companies: ["kz", "everything"] as never,
        areas: ["board", "team", "settings"],
        addedAt: 1,
        addedBy: await ctx.db.insert("users", {}),
      });
    });
    const odd = await signInAs(t, { email: "odd.company@gmail.com", emailVerificationTime: 1 });
    expect((await odd.query(api.viewer.me, {}))?.companies).toEqual(["kz"]);
    // What is asked of "both companies" is still refused them.
    await expect(odd.mutation(api.telegram.save, { enabled: false })).rejects.toThrow("not_allowed");
    await expect(odd.mutation(api.team.add, { ...NEW, companies: ["us"] })).rejects.toThrow("not_allowed");
  });
});

// ── What is written down ────────────────────────────────────────────────────

describe("a manager's changes are recorded for the owner", () => {
  test("an addition: who, when, whose record, and what they were given", async () => {
    const { t, manager } = await start();
    await manager.mutation(api.team.add, { ...NEW, areas: ["board", "sales"] });
    const [change] = await changes(t);
    const managerUser = await t.run((ctx) =>
      ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", MANAGER))
        .unique(),
    );
    expect(change?.at).toBeTypeOf("number");
    expect(change).toMatchObject({
      kind: "add",
      actor: managerUser!._id,
      member: (await rowOf(t, NEW.email))._id,
      after: { role: "sales", companies: ["kz"], areas: ["sales", "board"] },
    });
    expect(change?.before).toBeUndefined();
  });

  test("a change: before and after", async () => {
    const { t, manager, kzId } = await start();
    await manager.mutation(api.team.update, {
      id: kzId,
      role: "engineer",
      companies: ["kz"],
      areas: ["finance"],
    });
    expect((await changes(t))[0]).toMatchObject({
      kind: "update",
      member: kzId,
      before: { role: "sales", companies: ["kz"], areas: ["sales"] },
      after: { role: "engineer", companies: ["kz"], areas: ["finance"] },
    });
  });

  test("a row with no list of its own is recorded with the pages it had: its role's", async () => {
    const { t, manager } = await start();
    const old = await addMember(t, { email: "old.row@gmail.com", role: "engineer" });
    await manager.mutation(api.team.update, { ...edit(old), companies: ["us", "kz"] });
    expect((await changes(t))[0]?.before?.areas).toEqual(["product", "engineering", "board", "agents"]);
  });

  test("a removal: what they had", async () => {
    const { t, manager, kzId } = await start();
    await manager.mutation(api.team.remove, { id: kzId });
    const [change] = await changes(t);
    expect(change).toMatchObject({
      kind: "remove",
      member: kzId,
      before: { role: "sales", companies: ["kz"], areas: ["sales"] },
    });
    expect(change?.after).toBeUndefined();
  });

  test("a Telegram username changed with a widening is noted as changed, never what it was or became", async () => {
    // Only the owner sets one, and the owner's change is recorded where it widens.
    const { t, kzId } = await start();
    const owner = await signInAsOwner(t);
    await owner.mutation(api.team.update, { ...edit(kzId, { areas: ["sales", "settings"] }), telegram: "@SECRET_handle" });
    const stored = await changes(t);
    expect(stored[0]).toMatchObject({ kind: "update", telegramChanged: true });
    expect(JSON.stringify(stored)).not.toContain("SECRET_handle");
    await owner.mutation(api.team.update, edit(kzId, { areas: ["sales", "settings", "team"] }));
    expect((await changes(t))[1]?.telegramChanged).toBeUndefined();
  });

  test("no address, name or typed text is in a record: ids, fixed words and lists only", async () => {
    const { t, manager, kzId } = await start();
    await manager.mutation(api.team.add, NEW);
    await manager.mutation(api.team.update, edit(kzId, { areas: ["finance"] }));
    await manager.mutation(api.team.remove, { id: kzId });
    const stored = JSON.stringify(await changes(t));
    expect(await changes(t)).toHaveLength(3);
    expect(stored).not.toContain("@");
    expect(stored).not.toContain("person");
    expect(stored).not.toContain("manager");
  });

  test("a refused change is not recorded", async () => {
    const { t, manager, managerId, usId } = await start(["kz"]);
    await expect(manager.mutation(api.team.update, edit(usId))).rejects.toThrow("not_allowed");
    await expect(manager.mutation(api.team.remove, { id: managerId })).rejects.toThrow(
      CANNOT_CHANGE_SELF,
    );
    await expect(
      manager.mutation(api.team.add, { ...NEW, areas: ["personal"] }),
    ).rejects.toThrow(OWNERS_ONLY);
    expect(await changes(t)).toEqual([]);
  });

  test("the owner's own changes are not recorded", async () => {
    const { t, kzId } = await start();
    const owner = await signInAsOwner(t);
    await owner.mutation(api.team.add, NEW);
    await owner.mutation(api.team.update, edit(kzId));
    await owner.mutation(api.team.remove, { id: kzId });
    expect(await changes(t)).toEqual([]);
  });
});

describe("a manager and the link between a username and a Telegram account", () => {
  const link = (t: TestBackend, id: Id<"members">) =>
    t.run((ctx) => ctx.db.patch(id, { telegram: "Some_Name", telegramUserId: "770001", telegramBoundAt: 5 }));
  const OWNERS = "Only the owner sets or resets a Telegram username.";

  test("the list says who is linked and since when, for the people they are sent, never which account", async () => {
    const { t, manager, kzId, usId } = await start(["kz"]);
    await link(t, kzId);
    await link(t, usId);
    const list = await manager.query(api.team.list, {});
    expect(list.find((person) => person.id === kzId)).toMatchObject({
      telegram: "Some_Name",
      telegramLinked: true,
      telegramLinkedAt: 5,
    });
    // Someone on Startup alone is not theirs to hear of at all.
    expect(list.some((person) => person.id === usId)).toBe(false);
    expect(JSON.stringify(list)).not.toMatch(/770001|telegramUserId/);
  });

  test("resetting a link is the owner's alone: not someone within their companies, not their own, not anyone's", async () => {
    const { t, manager, managerId, kzId, usId, bothId } = await start();
    for (const id of [kzId, usId, bothId, managerId]) {
      await link(t, id);
      await expect(manager.mutation(api.team.resetTelegram, { id })).rejects.toThrow("not_owner");
      expect((await t.run((ctx) => ctx.db.get(id)))?.telegramUserId).toBe("770001");
    }
    await expect(manager.mutation(api.telegram.resetMine, {})).rejects.toThrow("not_owner");
    expect(await changes(t)).toEqual([]);
  });

  test("a username is the owner's to set: a manager's change that names one is refused, and nothing is recorded", async () => {
    const { t, manager, kzId } = await start(["kz"]);
    await link(t, kzId);
    for (const telegram of ["Another_Name", "Some_Name", "", null]) {
      await expect(manager.mutation(api.team.update, { ...edit(kzId), telegram })).rejects.toThrow(OWNERS);
    }
    await expect(manager.mutation(api.team.add, { ...NEW, telegram: "New_Name" })).rejects.toThrow(OWNERS);
    expect(await rowOf(t, "kz.person@gmail.com")).toMatchObject({
      telegram: "Some_Name",
      telegramUserId: "770001",
    });
    expect(await changes(t)).toEqual([]);
  });

  test("the owner resets a teammate's link, and changes a username, which clears the link", async () => {
    const { t, kzId, usId } = await start();
    await link(t, kzId);
    await link(t, usId);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.team.resetTelegram, { id: kzId });
    const reset = await rowOf(t, "kz.person@gmail.com");
    expect(reset.telegram).toBe("Some_Name");
    expect(reset.telegramUserId).toBeUndefined();
    await t.run((ctx) => ctx.db.patch(usId, { telegram: "Other_Name" }));
    await owner.mutation(api.team.update, { ...edit(usId, { companies: ["us"] }), telegram: "Yet_Another" });
    const changed = await rowOf(t, "us.person@gmail.com");
    expect(changed.telegram).toBe("Yet_Another");
    expect(changed.telegramUserId).toBeUndefined();
    expect(changed.telegramBoundAt).toBeUndefined();
    // Neither widens anyone's reach: the owner's own are not recorded.
    expect(await changes(t)).toEqual([]);
  });
});

describe("team.changes", () => {
  test("the owner reads the latest, newest first, with who and whom while they can be named", async () => {
    const { t, manager, kzId } = await start();
    // The teammate has signed in, so a removal can still say who it was.
    await signInAs(t, { email: "kz.person@gmail.com", emailVerificationTime: 1 });
    await manager.mutation(api.team.add, NEW);
    await manager.mutation(api.team.remove, { id: kzId });
    const owner = await signInAsOwner(t);
    const { rows: read } = await owner.query(api.team.changes, {});
    expect(read.map((change) => change.kind)).toEqual(["remove", "add"]);
    expect(read[0]).toMatchObject({
      actor: { email: MANAGER },
      person: { email: "kz.person@gmail.com" },
      before: { role: "sales", companies: ["kz"], areas: ["sales"] },
      after: null,
    });
    expect(read[1]).toMatchObject({
      person: { email: NEW.email },
      before: null,
      after: { role: "sales", companies: ["kz"], areas: ["sales"] },
    });
  });

  test("someone removed who never signed in can no longer be named", async () => {
    const { t, manager, kzId } = await start();
    await manager.mutation(api.team.remove, { id: kzId });
    const owner = await signInAsOwner(t);
    expect((await owner.query(api.team.changes, {})).rows[0]?.person).toBeNull();
  });

  test("twenty at a time, and the owner pages back through every one of them", async () => {
    const { t, manager, kzId } = await start();
    for (let i = 0; i < 45; i++) {
      await manager.mutation(api.team.update, edit(kzId, { areas: i % 2 ? ["sales"] : ["board"] }));
    }
    const owner = await signInAsOwner(t);
    const seen: string[] = [];
    let before: number | undefined;
    const sizes: number[] = [];
    for (;;) {
      const page = await owner.query(api.team.changes, before === undefined ? {} : { before });
      sizes.push(page.rows.length);
      seen.push(...page.rows.map((row) => row.id));
      if (page.next === null) break;
      before = page.next;
    }
    expect(sizes).toEqual([20, 20, 5]);
    expect(new Set(seen).size).toBe(45);
    // Newest first, all the way down.
    const stored = (await changes(t)).map((row) => row._id as string).reverse();
    expect(seen).toEqual(stored);
  });

  test("a save that changes nothing is not recorded, so the list cannot be filled with them", async () => {
    const { t, manager, kzId } = await start();
    // As they already are: sales, on Globex, with the Sales page.
    for (let i = 0; i < 30; i++) await manager.mutation(api.team.update, edit(kzId));
    expect(await changes(t)).toEqual([]);
    // The same pages in another order, and a username typed as it stands, are no change either.
    await t.run((ctx) => ctx.db.patch(kzId, { areas: ["sales", "board"] }));
    await manager.mutation(api.team.update, edit(kzId, { areas: ["board", "sales"] }));
    expect(await changes(t)).toEqual([]);
    // A real one still is.
    await manager.mutation(api.team.update, edit(kzId, { areas: ["board"] }));
    expect(await changes(t)).toHaveLength(1);
  });

  test("the reviewer's scenario: a company added to someone stays at the top however many changes follow", async () => {
    const { t, manager, kzId, usId } = await start();
    // The one that matters: someone on Globex alone is put on Startup too.
    await manager.mutation(api.team.update, edit(kzId, { companies: ["us", "kz"] }));
    // Then enough real changes to push it off the first page, and the second.
    for (let i = 0; i < 50; i++) {
      await manager.mutation(api.team.update, {
        ...edit(usId, { companies: ["us"] }),
        areas: i % 2 ? ["sales"] : ["board"],
      });
    }
    const owner = await signInAsOwner(t);
    const first = await owner.query(api.team.changes, {});
    expect(first.rows.some((row) => row.person?.email === "kz.person@gmail.com")).toBe(false);
    expect(first.widened).toHaveLength(1);
    expect(first.widened[0]).toMatchObject({
      kind: "update",
      actor: { email: MANAGER },
      before: { companies: ["kz"] },
      after: { companies: ["us", "kz"] },
    });
    // Sent with the first page only.
    expect((await owner.query(api.team.changes, { before: first.next! })).widened).toEqual([]);
  });

  test("what widens: a company added to someone, or a sensitive page given; not a company taken or a page changed", async () => {
    const { t, manager, kzId, bothId } = await start();
    await manager.mutation(api.team.update, edit(bothId, { companies: ["kz"], areas: ["finance"] }));
    await manager.mutation(api.team.update, edit(kzId, { areas: ["board"] }));
    await manager.mutation(api.team.add, NEW);
    await manager.mutation(api.team.remove, { id: kzId });
    expect((await changes(t)).map((row) => row.widens)).toEqual([false, false, false, false]);
    await manager.mutation(api.team.update, edit(bothId, { companies: ["us", "kz"], areas: ["finance"] }));
    expect((await changes(t)).at(-1)?.widens).toBe(true);
  });

  test("the owner's own are recorded where they widen, and only there: who was given a sensitive page is always on record", async () => {
    const { t, kzId, usId } = await start();
    const owner = await signInAsOwner(t);
    await owner.mutation(api.team.update, edit(kzId, { areas: ["board"] }));
    await owner.mutation(api.team.remove, { id: usId });
    expect(await changes(t)).toEqual([]);
    await owner.mutation(api.team.update, edit(kzId, { areas: ["board", "settings"] }));
    await owner.mutation(api.team.add, { ...NEW, areas: ["team"] });
    await owner.mutation(api.team.update, edit(kzId, { areas: ["board", "settings"], companies: ["us", "kz"] }));
    // Taking one away is not a widening.
    await owner.mutation(api.team.update, edit(kzId, { areas: ["board"], companies: ["us", "kz"] }));
    const { widened, rows } = await owner.query(api.team.changes, {});
    expect(rows).toHaveLength(3);
    expect(widened.map((row) => [row.kind, row.actor?.email, row.after?.areas])).toEqual([
      ["update", OWNER, ["board", "settings"]],
      ["add", OWNER, ["team"]],
      ["update", OWNER, ["board", "settings"]],
    ]);
  });

  test("a row from before widenings were marked is still found, by what it says", async () => {
    const { t, manager, kzId } = await start();
    const actor = (await t.run((ctx) =>
      ctx.db.query("users").withIndex("email", (q) => q.eq("email", MANAGER)).unique(),
    ))!._id;
    await t.run(async (ctx) => {
      // As the first version wrote them: no mark at all.
      await ctx.db.insert("teamChanges", {
        at: 1,
        kind: "update",
        actor,
        member: kzId,
        before: { role: "sales", companies: ["kz"], areas: ["sales"] },
        after: { role: "sales", companies: ["kz"], areas: ["sales", "team"] },
      });
      await ctx.db.insert("teamChanges", {
        at: 2,
        kind: "update",
        actor,
        member: kzId,
        before: { role: "sales", companies: ["kz"], areas: ["sales", "team"] },
        after: { role: "sales", companies: ["kz"], areas: ["sales"] },
      });
    });
    await manager.mutation(api.team.update, edit(kzId, { companies: ["us", "kz"] }));
    const owner = await signInAsOwner(t);
    const { widened } = await owner.query(api.team.changes, {});
    expect(widened.map((row) => row.after?.areas.includes("team") ?? false)).toEqual([false, true]);
    expect(widened).toHaveLength(2);
  });

  test("the short list is the latest twenty widenings", async () => {
    const { t, manager, kzId } = await start();
    for (let i = 0; i < 25; i++) {
      await manager.mutation(api.team.update, edit(kzId, { companies: ["us", "kz"] }));
      await manager.mutation(api.team.update, edit(kzId, { companies: ["kz"] }));
    }
    const owner = await signInAsOwner(t);
    expect((await owner.query(api.team.changes, {})).widened).toHaveLength(20);
    expect(await changes(t)).toHaveLength(50);
  });

  test("a manager cannot read it, whatever else they hold", async () => {
    const { manager } = await start(["us", "kz"], [...GRANTABLE_AREAS]);
    await manager.mutation(api.team.add, NEW);
    await expect(manager.query(api.team.changes, {})).rejects.toThrow("not_owner");
  });

  test("and nothing a manager can call erases what they did", async () => {
    // The only writers are the three mutations above, and each only adds a
    // row. This pins the module's public names, so a new one is looked at.
    const exported = Object.entries(await import("./team"))
      .filter(([, value]) => (value as { isPublic?: boolean }).isPublic === true)
      .map(([name]) => name);
    // `resetTelegram` is the owner's and touches no row of the record. The
    // two about a GitHub username read the caller's own and write the
    // owner's own, and touch no row of it either.
    expect(exported.sort()).toEqual([
      "add",
      "assignable",
      "changes",
      "list",
      "myGithub",
      "remove",
      "resetTelegram",
      "setMyGithub",
      "update",
    ]);
    const { t, manager, kzId } = await start();
    await manager.mutation(api.team.update, edit(kzId, { areas: ["board"] }));
    await manager.mutation(api.team.update, edit(kzId));
    await manager.mutation(api.team.remove, { id: kzId });
    expect((await changes(t)).map((change) => change.kind)).toEqual(["update", "update", "remove"]);
  });
});
