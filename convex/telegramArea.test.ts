import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { GRANTABLE_AREAS } from "./lib/roles";
import schema from "./schema";
import { GROUPS_ARE_THE_OWNERS } from "./telegram";
import {
  OWNER,
  addMember,
  modules,
  signInAsOwner,
  signInWithAreas,
  type TestBackend,
} from "./test.setup";
import { finishScheduled } from "./test.timers";

// The Telegram half of the `settings` area. The bot's settings are one row
// for the whole deployment, holding both companies' groups, so a teammate
// with the area on one company gets a part of it:
//
// - their own company's group: seen, picked, and sent its test message;
// - the other company's group: never sent to them, and not theirs to change;
// - what both companies share (messages on or off, where an untagged task
//   goes, commands on or off): read by any holder, changed only by one who is
//   on both companies. The owner is on both.
//
// `fetch` is a stub throughout; nothing here reaches Telegram.

const TOKEN = "123456789:SENTINEL_fake_token_for_tests_only_000";
const NOW = Date.UTC(2026, 9, 13, 9, 0, 0);
const US = { id: "-1001", title: "SECRET Startup group" };
const KZ = { id: "-1002", title: "SECRET Globex group" };
/** A group the bot is in that nobody has picked. */
const SPARE = { id: "-1003", title: "Spare group", type: "supergroup" as const };

let asked: string[];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
  vi.stubEnv("TELEGRAM_BOT_TOKEN", TOKEN);
  vi.stubEnv("CONVEX_SITE_URL", "https://deployment.example.test");
  asked = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      asked.push(String(url).split("/").pop()!);
      return new Response(JSON.stringify({ ok: true, result: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type Company = "us" | "kz";
const row = (t: TestBackend) => t.run((ctx) => ctx.db.query("telegramSettings").first());
const scheduled = (t: TestBackend) =>
  t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());

/** Both groups picked, the messages on, and a test last sent to Startup's group. */
async function start(companies: Company[]) {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("telegramSettings", {
      enabled: true,
      chatUs: US,
      chatKz: KZ,
      untaggedBoard: "kz",
      found: [{ ...US, type: "supergroup" }, { ...KZ, type: "supergroup" }, SPARE],
      foundAt: 1,
      test: { company: "us", at: 5, outcome: "sent" },
    });
  });
  const holder = await signInWithAreas(t, "engineer", ["settings"], companies);
  return { t, holder, before: await row(t) };
}

describe("what a holder on one company is sent", () => {
  test("their own group and not the other company's, in the picks or the list", async () => {
    const { holder } = await start(["kz"]);
    const read = await holder.query(api.telegram.settings, {});
    expect(read.chats).toEqual({ us: null, kz: KZ });
    // The list of groups the bot has seen is the owner's alone.
    expect(read.found).toBeNull();
    expect(JSON.stringify(read)).not.toContain("SECRET Startup");
    expect(read.canChangeShared).toBe(false);
    // How the last test to the other company's group went is not theirs either.
    expect(read.test).toBeNull();
  });

  test("the same for a holder on Startup", async () => {
    const { holder } = await start(["us"]);
    const read = await holder.query(api.telegram.settings, {});
    expect(read.chats).toEqual({ us: US, kz: null });
    expect(read.found).toBeNull();
    expect(JSON.stringify(read)).not.toContain("SECRET Globex");
    expect(read.test).toMatchObject({ company: "us", outcome: "sent" });
  });

  test("one group picked for both companies is theirs to see", async () => {
    const { t, holder } = await start(["kz"]);
    await t.run(async (ctx) => {
      const settings = await ctx.db.query("telegramSettings").first();
      await ctx.db.patch(settings!._id, { chatKz: US });
    });
    const read = await holder.query(api.telegram.settings, {});
    expect(read.chats).toEqual({ us: null, kz: US });
    expect(read.found).toBeNull();
  });

  test("what both companies share is read, and the token is never sent", async () => {
    const { holder } = await start(["kz"]);
    const read = await holder.query(api.telegram.settings, {});
    expect(read).toMatchObject({ tokenSet: true, enabled: true, untagged: "kz", mine: null });
    expect(JSON.stringify(read)).not.toMatch(/SENTINEL|123456789/);
  });

  test("the people counted are those who share a company with them", async () => {
    const { t, holder } = await start(["kz"]);
    await addMember(t, { email: "us.only@gmail.com", role: "sales", companies: ["us"] });
    await addMember(t, { email: "kz.only@gmail.com", role: "sales", companies: ["kz"] });
    // The holder and the one teammate on Globex: Startup's is not counted.
    expect(await holder.query(api.telegram.settings, {})).toMatchObject({
      teammates: 2,
      withoutUsername: 2,
    });
    const owner = await signInAsOwner(t);
    expect((await owner.query(api.telegram.settings, {})).teammates).toBe(3);
  });

  test("a holder on both is sent both picked groups and may change what is shared; the list is still the owner's", async () => {
    const { t, holder } = await start(["us", "kz"]);
    const read = await holder.query(api.telegram.settings, {});
    expect(read.chats).toEqual({ us: US, kz: KZ });
    expect(read.canChangeShared).toBe(true);
    expect(read).toMatchObject({ found: null, foundAt: null, finding: false, findError: null, canPickGroups: false });
    expect(JSON.stringify(read)).not.toContain(SPARE.title);
    const owners = await (await signInAsOwner(t)).query(api.telegram.settings, {});
    expect(owners.found).toHaveLength(3);
    expect(owners).toMatchObject({ foundAt: 1, canPickGroups: true });
  });

  test("a search of the owner's that failed, or is running, is not a holder's to hear of", async () => {
    const { t, holder } = await start(["kz"]);
    await t.run(async (ctx) => {
      const settings = (await ctx.db.query("telegramSettings").first())!;
      await ctx.db.patch(settings._id, { findingSince: 5, findError: "Telegram refused the bot's token." });
    });
    expect(await holder.query(api.telegram.settings, {})).toMatchObject({
      finding: false,
      findError: null,
      foundAt: null,
    });
  });
});

describe("what goes with a group, a person or the deployment, for a holder on one company", () => {
  /** Members counted, the bot out of Startup's group, a failure and a log on record. */
  async function seeded(companies: Company[]) {
    const { t, holder } = await start(companies);
    const usOnly = await addMember(t, { email: "us.only@gmail.com", role: "sales", companies: ["us"] });
    const kzOnly = await addMember(t, { email: "kz.only@gmail.com", role: "sales", companies: ["kz"] });
    const owner = await signInAsOwner(t);
    await t.run(async (ctx) => {
      const settings = (await ctx.db.query("telegramSettings").first())!;
      const users = await ctx.db.query("users").collect();
      const ownerId = users.find((user) => user.email === OWNER)!._id;
      for (const [id, name, telegram] of [
        [usOnly, "Una Startup", "SECRET_una"],
        [kzOnly, "Kai Globex", "SECRET_kai"],
      ] as const) {
        const member = (await ctx.db.get(id))!;
        await ctx.db.insert("users", { email: member.email, name, emailVerificationTime: 1 });
        await ctx.db.patch(id, { telegram, telegramUserId: "770001", telegramBoundAt: 7 });
      }
      await ctx.db.patch(ownerId, { name: "Olga Owner" });
      await ctx.db.patch(settings._id, {
        chatUs: { ...US, members: 12, leftAt: 9 },
        chatKz: { ...KZ, members: 5 },
        found: [
          { ...US, type: "supergroup", members: 12 },
          SPARE,
          { ...KZ, type: "supergroup", members: 5 },
        ],
        commandsWanted: true,
        commandFailure: { what: "An update from Telegram could not be acted on.", at: 8 },
        owners: [{ userId: ownerId, telegram: "SECRET_olga", telegramUserId: "770000", telegramBoundAt: 6 }],
        log: [
          { event: "reset", at: 4, member: usOnly },
          { event: "linked", at: 3, member: kzOnly },
          { event: "linked", at: 2, owner: ownerId },
          { event: "linked", at: 1, member: usOnly },
        ],
      });
    });
    return { t, holder, owner, usOnly, kzOnly };
  }

  test("their own group's size and state, their own pick first, and nothing of the other's", async () => {
    const { holder } = await seeded(["kz"]);
    const read = await holder.query(api.telegram.settings, {});
    expect(read.chats).toEqual({ us: null, kz: { ...KZ, members: 5 } });
    expect(read.found).toBeNull();
    expect(JSON.stringify(read)).not.toMatch(/SECRET Startup|"left"|"members":12|Spare/);
  });

  test("the holder on the company whose group the bot left is the one told so", async () => {
    const { holder } = await seeded(["us"]);
    const read = await holder.query(api.telegram.settings, {});
    expect(read.chats).toEqual({ us: { ...US, members: 12, left: true }, kz: null });
  });

  test("the switch for commands is read by any holder and changed only by one on both", async () => {
    const { t, holder } = await seeded(["kz"]);
    expect((await holder.query(api.telegram.settings, {})).commands.wanted).toBe(true);
    await expect(holder.mutation(api.telegramInbound.commandsOff, {})).rejects.toThrow("not_allowed");
    await expect(holder.mutation(api.telegramInbound.commandsOn, {})).rejects.toThrow("not_allowed");
    // Asking how commands stand is theirs, and leaves the switch as it was.
    await holder.mutation(api.telegramInbound.checkCommands, {});
    expect((await row(t))?.commandsWanted).toBe(true);
    const both = await signInWithAreas(t, "cofounder", ["settings"], ["us", "kz"]);
    await both.mutation(api.telegramInbound.commandsOff, {});
    expect((await row(t))?.commandsWanted).toBe(false);
  });

  test("the last failure is the deployment's, in fixed words: any holder is sent it", async () => {
    const { holder } = await seeded(["kz"]);
    expect((await holder.query(api.telegram.settings, {})).commands).toMatchObject({
      failure: "An update from Telegram could not be acted on.",
      failureAt: 8,
    });
  });

  test("who is linked, and the log, only for people who share a company, by name and never by username", async () => {
    const { holder, kzOnly } = await seeded(["kz"]);
    const read = await holder.query(api.telegram.settings, {});
    expect(read.people).toEqual([{ id: kzOnly, name: "Kai Globex", linked: true, linkedAt: 7 }]);
    expect(read.log).toEqual([
      { event: "linked", at: 3, name: "Kai Globex", gone: false },
      // The owner is on both companies.
      { event: "linked", at: 2, name: "Olga Owner", gone: false },
    ]);
    expect(read).toMatchObject({ mine: null, mineLinked: false, mineLinkedAt: null });
    expect(JSON.stringify(read)).not.toMatch(/SECRET_|Una|77000/);
  });

  test("someone since removed is in the log for the owner alone", async () => {
    const { t, holder, owner, kzOnly } = await seeded(["kz"]);
    await owner.mutation(api.team.remove, { id: kzOnly });
    expect((await holder.query(api.telegram.settings, {})).log).toEqual([
      { event: "linked", at: 2, name: "Olga Owner", gone: false },
    ]);
    const all = (await owner.query(api.telegram.settings, {})).log;
    expect(all).toHaveLength(4);
    expect(all[1]).toEqual({ event: "linked", at: 3, name: null, gone: true });
    expect(await row(t)).not.toBeNull();
  });

  test("the owner is sent everyone, and no teammate's username either", async () => {
    const { owner } = await seeded(["kz"]);
    const read = await owner.query(api.telegram.settings, {});
    expect(read.people.map((person) => person.name).sort()).toEqual(["Kai Globex", "Una Startup"]);
    expect(read).toMatchObject({ mine: "SECRET_olga", mineLinked: true, mineLinkedAt: 6 });
    expect(JSON.stringify(read)).not.toMatch(/SECRET_una|SECRET_kai|77000/);
  });

  test("which group is listed does not depend on who looks: the usernames on record are everyone's", async () => {
    // A Startup teammate's username vouches for a group although the only
    // holder of the area is on Globex alone.
    const { t, holder } = await seeded(["kz"]);
    await t.run(async (ctx) => {
      const settings = (await ctx.db.query("telegramSettings").first())!;
      await ctx.db.patch(settings._id, { found: [], commands: undefined });
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const method = String(url).split("/").pop();
        const result =
          method === "getUpdates"
            ? [
                {
                  update_id: 1,
                  message: {
                    date: 1,
                    text: "/start",
                    from: { id: 9, username: "secret_UNA" },
                    chat: { id: -100555, title: "Vouched by Startup", type: "supergroup" },
                  },
                },
              ]
            : method === "getWebhookInfo"
              ? { url: "" }
              : {};
        return new Response(JSON.stringify({ ok: true, result }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const owner = await signInAsOwner(t);
    await owner.mutation(api.telegram.findChats, {});
    await finishScheduled(t);
    expect((await owner.query(api.telegram.settings, {})).found).toEqual([
      { id: "-100555", title: "Vouched by Startup", type: "supergroup" },
    ]);
    expect((await holder.query(api.telegram.settings, {})).found).toBeNull();
  });
});

describe("what a holder on one company may change", () => {
  test("the words are fixed", () => {
    expect(GROUPS_ARE_THE_OWNERS).toBe("The owner picks the groups.");
  });

  test("the reviewer's redirect: they cannot make another group their company's, so announcements go where the owner said", async () => {
    const { t, holder, before } = await start(["kz"]);
    // A group the bot has seen and nobody picked: titles of shared tasks and
    // the other company's assignees' tags would be posted there.
    for (const chatKz of [SPARE.id, US.id, "-424242"]) {
      await expect(holder.mutation(api.telegram.save, { chatKz })).rejects.toThrow(GROUPS_ARE_THE_OWNERS);
    }
    expect(await row(t)).toEqual(before);
  });

  test("the reviewer's squat: with no group picked for the other company yet, they cannot claim one for their own first", async () => {
    const { t, holder } = await start(["kz"]);
    await t.run(async (ctx) => {
      const settings = (await ctx.db.query("telegramSettings").first())!;
      await ctx.db.patch(settings._id, { chatUs: undefined, chatKz: undefined });
    });
    const before = await row(t);
    // Startup's group, seen by the bot and not yet picked by the owner.
    await expect(holder.mutation(api.telegram.save, { chatKz: US.id })).rejects.toThrow(GROUPS_ARE_THE_OWNERS);
    expect(await row(t)).toEqual(before);
  });

  test("nor clear their own company's group, send it unchanged, or touch the other company's", async () => {
    const { t, holder, before } = await start(["kz"]);
    for (const change of [{ chatKz: null }, { chatKz: KZ.id }, { chatUs: null }, { chatUs: SPARE.id }, { chatUs: US.id }]) {
      await expect(holder.mutation(api.telegram.save, change)).rejects.toThrow(GROUPS_ARE_THE_OWNERS);
    }
    expect(await row(t)).toEqual(before);
  });

  test("a holder on both companies cannot either, alone or beside a switch they may change", async () => {
    const { t, holder, before } = await start(["us", "kz"]);
    for (const change of [{ chatUs: SPARE.id }, { chatKz: null }, { enabled: false, chatKz: SPARE.id }]) {
      await expect(holder.mutation(api.telegram.save, change)).rejects.toThrow(GROUPS_ARE_THE_OWNERS);
    }
    expect(await row(t)).toEqual(before);
  });

  test("the owner picks and clears either company's group", async () => {
    const { t, before } = await start(["kz"]);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.telegram.save, { chatKz: SPARE.id, chatUs: null });
    const after = await row(t);
    expect(after).toEqual({ ...before, chatUs: undefined, chatKz: { id: SPARE.id, title: SPARE.title } });
  });

  test("not the switch for both companies, on, off or as it stands", async () => {
    const { t, holder, before } = await start(["kz"]);
    for (const enabled of [false, true]) {
      await expect(holder.mutation(api.telegram.save, { enabled })).rejects.toThrow("not_allowed");
    }
    expect(await row(t)).toEqual(before);
  });

  test("not where an untagged task goes", async () => {
    const { t, holder, before } = await start(["kz"]);
    for (const untagged of ["us", "kz", "both"] as const) {
      await expect(holder.mutation(api.telegram.save, { untagged })).rejects.toThrow(
        "not_allowed",
      );
    }
    expect(await row(t)).toEqual(before);
  });

  test("not commands, on or off, and nothing is started", async () => {
    const { t, holder, before } = await start(["us"]);
    await expect(holder.mutation(api.telegramInbound.commandsOn, {})).rejects.toThrow(
      "not_allowed",
    );
    await expect(holder.mutation(api.telegramInbound.commandsOff, {})).rejects.toThrow(
      "not_allowed",
    );
    expect(await scheduled(t)).toEqual([]);
    expect(await row(t)).toEqual(before);
    expect(asked).toEqual([]);
  });

  test("asking Telegram how commands stand changes nothing there, and is theirs", async () => {
    const { t, holder } = await start(["us"]);
    await holder.mutation(api.telegramInbound.checkCommands, {});
    await finishScheduled(t);
    expect(asked).toEqual(["getMe", "getWebhookInfo"]);
  });

  test("the test message to their own group, and not to the other company's", async () => {
    const { t, holder, before } = await start(["kz"]);
    await expect(holder.mutation(api.telegram.sendTest, { company: "us" })).rejects.toThrow(
      "not_allowed",
    );
    expect(await scheduled(t)).toEqual([]);
    expect(await row(t)).toEqual(before);

    await holder.mutation(api.telegram.sendTest, { company: "kz" });
    expect((await row(t))?.test).toMatchObject({ company: "kz", outcome: "sending" });
    await finishScheduled(t);
    expect(asked).toEqual(["sendMessage"]);
  });

  test("looking for groups is the owner's alone: it fills the list the owner picks from", async () => {
    const { t, holder, before } = await start(["us", "kz"]);
    await expect(holder.mutation(api.telegram.findChats, {})).rejects.toThrow("not_owner");
    expect(await scheduled(t)).toEqual([]);
    expect(await row(t)).toEqual(before);
    await (await signInAsOwner(t)).mutation(api.telegram.findChats, {});
    expect(await scheduled(t)).toHaveLength(1);
    await finishScheduled(t);
  });

  test("the owner's own username is the owner's to set", async () => {
    const { t, holder } = await start(["us", "kz"]);
    await expect(holder.mutation(api.telegram.setMine, { telegram: "someone" })).rejects.toThrow(
      "not_owner",
    );
    expect((await row(t))?.owners).toBeUndefined();
  });
});

describe("a holder on both companies", () => {
  test("changes what both share, like the owner", async () => {
    const { t, holder } = await start(["us", "kz"]);
    await holder.mutation(api.telegram.save, { enabled: false, untagged: "both" });
    const after = await row(t);
    // The groups are as the owner left them.
    expect(after).toMatchObject({ enabled: false, chatUs: US, chatKz: KZ, untaggedBoard: "both" });
    await holder.mutation(api.telegramInbound.commandsOff, {});
    await finishScheduled(t);
    expect(asked).toContain("deleteWebhook");
  });

  test("a save that names nothing changes nothing", async () => {
    const { t, holder, before } = await start(["us", "kz"]);
    await holder.mutation(api.telegram.save, {});
    expect(await row(t)).toEqual(before);
  });
});

describe("without the area", () => {
  test("a teammate with every other page reads and changes none of it", async () => {
    const { t, before } = await start(["us", "kz"]);
    const others = GRANTABLE_AREAS.filter((area) => area !== "settings");
    const teammate = await signInWithAreas(t, "cofounder", others);
    for (const call of [
      teammate.query(api.telegram.settings, {}),
      teammate.mutation(api.telegram.save, { chatKz: null }),
      teammate.mutation(api.telegram.sendTest, { company: "kz" }),
      teammate.mutation(api.telegramInbound.commandsOn, {}),
      teammate.mutation(api.telegramInbound.commandsOff, {}),
      teammate.mutation(api.telegramInbound.checkCommands, {}),
    ]) {
      await expect(call).rejects.toThrow("not_allowed");
    }
    await expect(teammate.mutation(api.telegram.findChats, {})).rejects.toThrow("not_owner");
    expect(await scheduled(t)).toEqual([]);
    expect(await row(t)).toEqual(before);
  });
});
