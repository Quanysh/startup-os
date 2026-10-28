import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { NOT_A_USERNAME } from "./lib/telegramMessage";
import schema from "./schema";
import { OWNER, modules, signInAsCofounder, signInAsOwner, type TestBackend } from "./test.setup";

// A teammate's Telegram username: typed by the owner on the team page, sent
// back to the owner only.

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
  areas: ["board"],
};
const SAME = { role: "sales" as const, companies: ["us" as const], areas: ["board"] };

describe("team.add with a Telegram username", () => {
  test("stored as typed, without the @", async () => {
    const { t, owner } = await start();
    await owner.mutation(api.team.add, { ...NEW, telegram: " @Aigerim_K " });
    expect((await rows(t))[0]?.telegram).toBe("Aigerim_K");
  });

  test("left out or blank, none is stored", async () => {
    const { t, owner } = await start();
    await owner.mutation(api.team.add, NEW);
    await owner.mutation(api.team.add, { ...NEW, email: "other@gmail.com", telegram: "  " });
    for (const row of await rows(t)) expect("telegram" in row).toBe(false);
  });

  test("one that is no username is refused in fixed words and nobody is added", async () => {
    const { t, owner } = await start();
    await expect(owner.mutation(api.team.add, { ...NEW, telegram: "<b>x</b>" })).rejects.toThrow(
      NOT_A_USERNAME,
    );
    expect(await rows(t)).toEqual([]);
  });
});

describe("team.update with a Telegram username", () => {
  const added = async () => {
    const { t, owner } = await start();
    const id = await owner.mutation(api.team.add, { ...NEW, telegram: "aigerim_k" });
    return { t, owner, id };
  };

  test("a new one replaces the old", async () => {
    const { t, owner, id } = await added();
    await owner.mutation(api.team.update, { id, ...SAME, telegram: "@Aigerim_New" });
    expect((await rows(t))[0]?.telegram).toBe("Aigerim_New");
  });

  test("left out, it is kept: a save from before the field existed changes nothing", async () => {
    const { t, owner, id } = await added();
    await owner.mutation(api.team.update, { id, ...SAME });
    expect((await rows(t))[0]?.telegram).toBe("aigerim_k");
  });

  test.each([["null", null], ["blank", "  "]])("%s clears it", async (_what, telegram) => {
    const { t, owner, id } = await added();
    await owner.mutation(api.team.update, { id, ...SAME, telegram });
    expect("telegram" in (await rows(t))[0]!).toBe(false);
  });

  test("one that is no username is refused and the row is left as it was", async () => {
    const { t, owner, id } = await added();
    await expect(
      owner.mutation(api.team.update, { id, role: "engineer", companies: ["kz"], areas: [], telegram: "no" }),
    ).rejects.toThrow(NOT_A_USERNAME);
    expect((await rows(t))[0]).toMatchObject({ role: "sales", telegram: "aigerim_k" });
  });
});

describe("who is told a Telegram username", () => {
  test("team.list tells the owner each teammate's, or null", async () => {
    const { owner } = await start();
    await owner.mutation(api.team.add, { ...NEW, telegram: "aigerim_k" });
    await owner.mutation(api.team.add, { ...NEW, email: "other@gmail.com" });
    const list = await owner.query(api.team.list, {});
    expect(list.map((row) => [row.email, row.telegram])).toEqual([
      ["new.person@gmail.com", "aigerim_k"],
      ["other@gmail.com", null],
    ]);
  });

  test("team.assignable tells nobody: not a teammate, and not the owner either", async () => {
    const { t, owner } = await start();
    await owner.mutation(api.team.add, { ...NEW, telegram: "SECRET_handle" });
    const cofounder = await signInAsCofounder(t);
    for (const client of [owner, cofounder]) {
      for (const args of [{}, { company: "us" as const }]) {
        const people = await client.query(api.team.assignable, args);
        expect(people.map((p) => p.email)).toContain("new.person@gmail.com");
        expect(JSON.stringify(people)).not.toContain("SECRET_handle");
        for (const person of people) expect(Object.keys(person).sort()).toEqual(["email", "name"]);
      }
    }
  });

  test("nor does the board, whoever a task is assigned to", async () => {
    const { t, owner } = await start();
    await owner.mutation(api.team.add, { ...NEW, telegram: "SECRET_handle" });
    const cofounder = await signInAsCofounder(t);
    await owner.mutation(api.tasks.create, { title: "A task", assignee: NEW.email });
    expect(JSON.stringify(await cofounder.query(api.tasks.board, {}))).not.toContain("SECRET_handle");
  });
});
