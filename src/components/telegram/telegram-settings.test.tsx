// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { AREAS, areasOf } from "@convex/lib/roles";
import { ViewerProvider } from "@/components/viewer-provider";
import { localIsoDate } from "@/lib/dates";
import { deferred, mockConvex } from "@/test-support/convex";
import { TelegramSettings } from "./telegram-settings";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

const US = { id: "-1001", title: "Startup team" };
const KZ = { id: "-1002", title: "Globex team" };
const NEW = { id: "-2001", title: "A new group", type: "supergroup" };

/** What `telegram.settings` sends before anything is set up. */
const EMPTY = {
  tokenSet: false,
  siteSet: true,
  enabled: false,
  chats: { us: null, kz: null },
  // The owner is on both companies, so everything here is theirs to change.
  canChangeShared: true,
  canPickGroups: true,
  mine: null,
  mineLinked: false,
  mineLinkedAt: null,
  people: [],
  log: [],
  botUsername: null,
  untagged: "kz",
  commands: {
    wanted: false,
    failure: null,
    failureAt: null,
    state: "unknown",
    pending: null,
    deliveryError: null,
    deliveryErrorAt: null,
    checkedAt: null,
    working: false,
    error: null,
  },
  found: null,
  finding: false,
  foundAt: null,
  findError: null,
  test: null,
  lastSentAt: null,
  lastError: null,
  lastErrorAt: null,
  teammates: 0,
  withoutUsername: 0,
};
/** Set up and switched on. */
const READY = {
  ...EMPTY,
  tokenSet: true,
  enabled: true,
  botUsername: "madeup_bot",
  chats: { us: US, kz: KZ },
  found: [{ ...US, type: "supergroup" }, NEW],
  foundAt: 1,
  teammates: 3,
  withoutUsername: 2,
};

let convex: ReturnType<typeof mockConvex>;
const as = (owner: boolean, children: ReactNode) => (
  <ViewerProvider
    viewer={{
      role: owner ? "owner" : "cofounder",
      companies: ["us", "kz"],
      areas: owner ? AREAS : areasOf("cofounder"),
      email: "someone@example.com",
      name: null,
    }}
  >
    {children}
  </ViewerProvider>
);
const page = () => as(true, <TelegramSettings />);
const show = (settings: object) => {
  convex.setQuery(api.telegram.settings, settings);
  return render(page());
};
const saved = () => convex.mutation(api.telegram.save);
const finds = () => convex.mutation(api.telegram.findChats);
const tests = () => convex.mutation(api.telegram.sendTest);
const mine = () => convex.mutation(api.telegram.setMine);
const turnedOn = () => convex.mutation(api.telegramInbound.commandsOn);
const turnedOff = () => convex.mutation(api.telegramInbound.commandsOff);
const checked = () => convex.mutation(api.telegramInbound.checkCommands);
const ON = { ...EMPTY.commands, wanted: true, state: "on", pending: 0, checkedAt: 1 };
const section = (name: string) => within(screen.getByRole("region", { name }));
const picker = (company: string) =>
  screen.getByLabelText(`${company}'s group`) as HTMLSelectElement;
const options = (select: HTMLSelectElement) => [...select.options].map((o) => o.textContent);
const onSwitch = () => screen.getByRole("switch", { name: "Send a message when a task is assigned" });
const button = (name: string | RegExp) => screen.getByRole("button", { name });

beforeEach(() => {
  convex = mockConvex();
  vi.mocked(useQuery).mockClear();
});
afterEach(cleanup);

describe("who sees it", () => {
  // What a teammate who was given the page sees is in telegram-one-company.test.tsx.
  test("a co-founder, whose role does not start with the page, gets a line and no query", () => {
    convex.setQuery(api.telegram.settings, READY);
    render(as(false, <TelegramSettings />));
    expect(
      screen.getByText(
        "Only the owner, and people the owner gives the Sources and Telegram pages, set up Telegram.",
      ),
    ).toBeTruthy();
    expect(vi.mocked(useQuery).mock.calls.every(([, args]) => args === "skip")).toBe(true);
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("while the settings load there is the heading and no form", () => {
    render(page());
    expect(screen.getByRole("heading", { level: 1, name: "Telegram" })).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});

describe("the steps", () => {
  test("say how to set the bot up, in order", () => {
    show(EMPTY);
    const steps = section("Set it up")
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "");
    expect(steps).toHaveLength(8);
    expect(steps[0]).toContain("@BotFather");
    expect(steps[1]).toContain("TELEGRAM_BOT_TOKEN");
    expect(steps[1]).toContain("Convex dashboard");
    // Usernames come before the group: a group is listed only through someone on record.
    expect(steps[2]).toContain("Telegram username");
    expect(steps[3]).toMatch(/Add the bot to the group/);
    expect(steps[4]).toMatch(/mentions the bot/);
    expect(steps[5]).toContain("Find my groups");
    expect(steps[6]).toContain("Send a test message");
  });

  test("end by closing the bot to other groups, in one sentence", () => {
    show(EMPTY);
    const last = section("Set it up").getAllByRole("listitem").at(-1)!.textContent ?? "";
    expect(last).toBe(
      "Once the groups are connected, open @BotFather, choose the bot under /mybots, then Bot Settings, and turn off Allow Groups, so that nobody can add the bot to a group of their own.",
    );
  });

  test("say that a group is listed only through someone whose username is on record", () => {
    show(EMPTY);
    expect(
      section("Set it up").getByText(/A group is listed only when someone whose username is on record/),
    ).toBeTruthy();
  });

  test("say whether the token is set, and never show a place to type it", () => {
    show(EMPTY);
    expect(section("Set it up").getByText("Token not set")).toBeTruthy();
    cleanup();
    show(READY);
    expect(section("Set it up").getByText("Token set")).toBeTruthy();
    expect(screen.queryByLabelText(/token/i)).toBeNull();
    expect(section("Set it up").getByText(/never paste the token/i)).toBeTruthy();
  });

  test("say when the message will have no link to the board", () => {
    show({ ...READY, siteSet: false });
    expect(screen.getByText(/SITE_URL/)).toBeTruthy();
    cleanup();
    show(READY);
    expect(screen.queryByText(/SITE_URL/)).toBeNull();
  });
});

describe("the groups", () => {
  test("states where a shared task goes", () => {
    show(READY);
    expect(
      section("Groups").getByText(
        "A task of one company goes to that company's group. A task shared by both goes to Startup's group if one is picked, otherwise to Globex's.",
      ),
    ).toBeTruthy();
  });

  test("each company's picker offers none, the groups found and the ones already picked", () => {
    show(READY);
    // The picked ones first, each with its id: two groups can have one title.
    expect(options(picker("Startup"))).toEqual([
      "None",
      "Startup team · id -1001",
      "Globex team · id -1002",
      "A new group · id -2001",
    ]);
    expect(picker("Startup").value).toBe(US.id);
    expect(picker("Globex").value).toBe(KZ.id);
    expect(onSwitch().getAttribute("aria-checked")).toBe("true");
  });

  test("the groups found are listed in the shared table, with their kind", () => {
    show(READY);
    const table = screen.getByRole("table", { name: "Groups the bot has seen" });
    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "Group",
      "Kind",
      "Members",
      "Id",
    ]);
    const row = within(table).getByRole("rowheader", { name: "A new group" }).closest("tr")!;
    expect(within(row).getByText("Supergroup").dataset.slot).toBe("kind-tag");
    expect(within(row).getByText("-2001")).toBeTruthy();
    expect(within(row).getByText("Not counted")).toBeTruthy();
  });

  test("two groups with one title are told apart by id and by how many are in them", () => {
    const LOOKALIKE = { id: "-7777", title: "Startup team", type: "group", members: 2 };
    show({
      ...READY,
      chats: { us: { ...US, members: 12 }, kz: null },
      found: [{ ...US, type: "supergroup", members: 12 }, LOOKALIKE],
    });
    expect(options(picker("Startup"))).toEqual([
      "None",
      "Startup team · id -1001 · 12 members",
      "Startup team · id -7777 · 2 members",
    ]);
    const table = screen.getByRole("table", { name: "Groups the bot has seen" });
    const rows = within(table)
      .getAllByRole("rowheader", { name: "Startup team" })
      .map((th) => [...th.closest("tr")!.children].map((td) => td.textContent));
    expect(rows).toEqual([
      ["Startup team", "Supergroup", "12", "-1001"],
      ["Startup team", "Group", "2", "-7777"],
    ]);
  });

  test("one member is said in the singular", () => {
    show({ ...READY, chats: { us: null, kz: null }, found: [{ ...NEW, members: 1 }] });
    expect(options(picker("Startup"))).toEqual(["None", "A new group · id -2001 · 1 member"]);
  });

  test("a picked group the bot has left is said, in fixed words, for that company alone", () => {
    show({ ...READY, chats: { us: { ...US, left: true }, kz: KZ } });
    const notice = section("Groups").getByText(
      "The bot is no longer in this group. Add it again in Telegram, or pick another group.",
    );
    expect(notice.closest("div")!.contains(picker("Startup"))).toBe(true);
    expect(section("Groups").getAllByText(/no longer in this group/)).toHaveLength(1);
    expect(section("Groups").getByText("Left the group").closest("[data-tone]")?.getAttribute("data-tone")).toBe(
      "warning",
    );
    cleanup();
    show(READY);
    expect(screen.queryByText(/no longer in this group/)).toBeNull();
  });

  test("before any search there is no table, only what to do", () => {
    show({ ...EMPTY, tokenSet: true });
    expect(screen.queryByRole("table")).toBeNull();
    expect(section("Groups").getByText(/No groups found yet/)).toBeTruthy();
  });

  test("a search that found none says what to check", () => {
    show({ ...READY, chats: { us: null, kz: null }, found: [] });
    expect(section("Groups").getByText(/The bot has not seen a group/)).toBeTruthy();
  });

  test("Save sends the switch and each company's group", async () => {
    const user = userEvent.setup();
    show(READY);
    await user.selectOptions(picker("Startup"), NEW.id);
    await user.selectOptions(picker("Globex"), "");
    await user.click(onSwitch());
    await user.click(button("Save"));
    expect(saved()).toHaveBeenCalledWith({ enabled: false, chatUs: NEW.id, chatKz: null });
  });

  test("what was chosen outlives a live update, and what was not touched follows the server", async () => {
    const user = userEvent.setup();
    const view = show(READY);
    await user.selectOptions(picker("Startup"), NEW.id);
    convex.setQuery(api.telegram.settings, {
      ...READY,
      enabled: false,
      chats: { us: KZ, kz: null },
      lastSentAt: 5,
    });
    view.rerender(page());
    expect(picker("Startup").value).toBe(NEW.id);
    expect(picker("Globex").value).toBe("");
    expect(onSwitch().getAttribute("aria-checked")).toBe("false");
  });

  test("a save in flight is not sent twice, and the button stays focusable", async () => {
    const user = userEvent.setup();
    const held = deferred();
    saved().mockReturnValueOnce(held.promise);
    show(READY);
    await user.click(button("Save"));
    expect(button("Save").getAttribute("aria-disabled")).toBe("true");
    expect((button("Save") as HTMLButtonElement).disabled).toBe(false);
    await user.click(button("Save"));
    expect(saved()).toHaveBeenCalledTimes(1);
    held.resolve(null);
    await waitFor(() => expect(button("Save").getAttribute("aria-disabled")).toBe("false"));
  });

  test("a refused save is shown in the server's words and the choice is kept", async () => {
    const user = userEvent.setup();
    saved().mockRejectedValueOnce(new ConvexError("Pick a group from the list."));
    show(READY);
    await user.selectOptions(picker("Startup"), NEW.id);
    await user.click(button("Save"));
    expect((await section("Groups").findByRole("alert")).textContent).toBe(
      "Pick a group from the list.",
    );
    expect(picker("Startup").value).toBe(NEW.id);
  });
});

describe("Find my groups", () => {
  test("starts the search", async () => {
    const user = userEvent.setup();
    show(READY);
    await user.click(button("Find my groups"));
    expect(finds()).toHaveBeenCalledWith({});
  });

  test("while it runs the button says so and does not start another", async () => {
    const user = userEvent.setup();
    show({ ...READY, finding: true });
    expect(button("Looking…").getAttribute("aria-disabled")).toBe("true");
    await user.click(button("Looking…"));
    expect(finds()).not.toHaveBeenCalled();
  });

  test("a refusal to start is shown in the server's words", async () => {
    const user = userEvent.setup();
    finds().mockRejectedValueOnce(
      new ConvexError("Set TELEGRAM_BOT_TOKEN on the Convex deployment first."),
    );
    show(EMPTY);
    await user.click(button("Find my groups"));
    expect((await section("Groups").findByRole("alert")).textContent).toBe(
      "Set TELEGRAM_BOT_TOKEN on the Convex deployment first.",
    );
  });

  test("a search that failed says why, in the server's fixed words", () => {
    show({ ...READY, findError: "Telegram refused the bot's token." });
    expect(section("Groups").getByText("Telegram refused the bot's token.")).toBeTruthy();
  });
});

describe("the test message", () => {
  test("a button for each company's group", async () => {
    const user = userEvent.setup();
    show(READY);
    await user.click(button("Send a test message to Startup's group"));
    expect(tests()).toHaveBeenCalledWith({ company: "us" });
    await user.click(button("Send a test message to Globex's group"));
    expect(tests()).toHaveBeenCalledWith({ company: "kz" });
  });

  test("a company with no saved group cannot be tested, and the page says why", async () => {
    const user = userEvent.setup();
    show({ ...READY, chats: { us: US, kz: null } });
    const kz = button("Send a test message to Globex's group");
    expect(kz.getAttribute("aria-disabled")).toBe("true");
    await user.click(kz);
    expect(tests()).not.toHaveBeenCalled();
    expect(section("Groups").getByText(/Save a group for Globex to test it/)).toBeTruthy();
  });

  test.each([
    [{ company: "us", at: 1, outcome: "sending", error: null }, "Sending to Startup's group…"],
    [{ company: "kz", at: 1, outcome: "sent", error: null }, "Sent to Globex's group"],
  ])("how the last one went is shown", (test, words) => {
    show({ ...READY, test });
    expect(section("Groups").getByText(words)).toBeTruthy();
  });

  test("a failed one says why, in the server's fixed words", () => {
    show({
      ...READY,
      test: {
        company: "us",
        at: 1,
        outcome: "failed",
        error: "The bot is not in that group or cannot post there.",
      },
    });
    const chip = section("Groups").getByText("Not sent to Startup's group");
    expect(chip.closest("[data-tone]")?.getAttribute("data-tone")).toBe("danger");
    expect(
      section("Groups").getByText("The bot is not in that group or cannot post there."),
    ).toBeTruthy();
  });

  test("a refusal to start is shown in the server's words", async () => {
    const user = userEvent.setup();
    tests().mockRejectedValueOnce(new ConvexError("Pick a group for Startup first."));
    show(READY);
    await user.click(button("Send a test message to Startup's group"));
    expect((await section("Groups").findByRole("alert")).textContent).toBe(
      "Pick a group for Startup first.",
    );
  });
});

describe("how it is going", () => {
  test("nothing sent yet", () => {
    show(READY);
    expect(section("How it is going").getByText("No task message has been sent yet.")).toBeTruthy();
  });

  test("off, it says so before anything else", () => {
    show({ ...READY, enabled: false });
    expect(section("How it is going").getByText("Switched off")).toBeTruthy();
    cleanup();
    show({ ...READY, tokenSet: false });
    expect(section("How it is going").getByText("Off: the token is not set")).toBeTruthy();
  });

  test("the last message that got through", () => {
    // Half an hour past the mark: the page's clock ticks twice a minute.
    show({ ...READY, lastSentAt: Date.now() - 3.5 * 60 * 60 * 1000 });
    const going = section("How it is going");
    expect(going.getByText("Working").closest("[data-tone]")?.getAttribute("data-tone")).toBe(
      "success",
    );
    expect(going.getByText(/Last message sent 3h ago/)).toBeTruthy();
  });

  test("the last failure, in the server's fixed words, with an icon and a label", () => {
    show({
      ...READY,
      lastSentAt: Date.now() - 2.5 * 24 * 60 * 60 * 1000,
      lastError: "Too many messages in an hour; some were not sent.",
      lastErrorAt: Date.now() - 90 * 1000,
    });
    const going = section("How it is going");
    expect(going.getByText("Last message not sent").closest("[data-tone]")?.getAttribute("data-tone")).toBe(
      "danger",
    );
    expect(going.getByText("Too many messages in an hour; some were not sent.")).toBeTruthy();
    expect(going.getByText(/1m ago/)).toBeTruthy();
    expect(going.getByText(/Last message sent 2d ago/)).toBeTruthy();
  });
});

describe("usernames", () => {
  test("one read-only line: how many teammates have one, and where they are edited", () => {
    show(READY);
    const people = section("Who gets tagged");
    expect(people.getByText(/^1 of 3 teammates have a Telegram username ·/)).toBeTruthy();
    expect(people.getByRole("link", { name: "Edit on Team" }).getAttribute("href")).toBe("/settings/team");
  });

  test("one teammate reads as one; none on the team says so", () => {
    show({ ...READY, teammates: 1, withoutUsername: 0 });
    expect(section("Who gets tagged").getByText(/^1 of 1 teammate has a Telegram username ·/)).toBeTruthy();
    cleanup();
    show({ ...READY, teammates: 0, withoutUsername: 0 });
    expect(section("Who gets tagged").getByText(/^No teammates yet ·/)).toBeTruthy();
  });

  test("no field and no button to set or reset one here, the owner's own included", () => {
    show({ ...READY, mine: "Olga_Owner", mineLinked: true, mineLinkedAt: 1 });
    expect(screen.queryByLabelText("Your Telegram username")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save username" })).toBeNull();
    expect(section("Who gets tagged").queryByRole("button", { name: /Reset link/ })).toBeNull();
    expect(mine()).not.toHaveBeenCalled();
  });
});

describe("which usernames are linked to a Telegram account", () => {
  const AT = Date.UTC(2026, 9, 13, 12);
  // By name: this page is sent no teammate's username.
  const PEOPLE = [
    { id: "m1", name: "Cora Founder", linked: true, linkedAt: AT },
    { id: "m2", name: null, linked: false, linkedAt: null },
  ];
  const UNSIGNED = "A teammate who has not signed in yet";
  const resetOne = () => convex.mutation(api.team.resetTelegram);
  const rowOf = (username: string) =>
    within(
      within(screen.getByRole("table", { name: "Teammates and their Telegram accounts" }))
        .getByRole("rowheader", { name: new RegExp(username) })
        .closest("tr")!,
    );

  test("each teammate with a username: linked, with the date, or not used yet", () => {
    show({ ...READY, people: PEOPLE });
    expect(rowOf("Cora Founder").getByText(`Linked ${localIsoDate(AT)}`)).toBeTruthy();
    expect(rowOf(UNSIGNED).getByText("Not used yet")).toBeTruthy();
    expect(rowOf(UNSIGNED).queryByRole("button")).toBeNull();
    expect(section("Who gets tagged").queryByText(/@/)).toBeNull();
  });

  test("it says what a link is and when to reset one", () => {
    show({ ...READY, people: PEOPLE });
    expect(
      section("Who gets tagged").getByText(
        /The first task someone adds from the group links their username to the Telegram account that wrote it/,
      ),
    ).toBeTruthy();
  });

  test("whether each is linked is read here; a link is reset on the Team page", () => {
    show({ ...READY, people: PEOPLE });
    expect(rowOf("Cora Founder").queryByRole("button")).toBeNull();
    expect(resetOne()).not.toHaveBeenCalled();
  });

  test("with no teammate's username on record there is no table", () => {
    show(READY);
    expect(screen.queryByRole("table", { name: "Teammates and their Telegram accounts" })).toBeNull();
  });

  test("the last links and resets are listed in fixed words, by name, newest first", () => {
    show({
      ...READY,
      log: [
        { event: "reset", at: AT + 1000, name: "Cora Founder", gone: false },
        { event: "linked", at: AT, name: "Cora Founder", gone: false },
        { event: "linked", at: AT - 1000, name: null, gone: true },
        { event: "reset", at: AT - 2000, name: null, gone: false },
      ],
    });
    const items = within(section("Who gets tagged").getByRole("list", { name: "Recent links" }))
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(items[0]).toContain("The link of Cora Founder was reset.");
    expect(items[1]).toContain("Cora Founder was linked to the Telegram account that added a task.");
    expect(items[2]).toContain("Someone no longer on the team was linked to the Telegram account that added a task.");
    expect(items[3]).toContain("The link of a teammate was reset.");
    expect(items[1]).toContain(localIsoDate(AT));
  });

  test("with nothing linked yet there is no list", () => {
    show(READY);
    expect(screen.queryByRole("list", { name: "Recent links" })).toBeNull();
  });
});

describe("a command that failed", () => {
  test("is said in the server's fixed words", () => {
    show({
      ...READY,
      commands: { ...ON, failure: "A task was added but the reply could not be posted.", failureAt: 1 },
    });
    const line = section("Commands").getByText("Last command failed").closest("p")!;
    expect(line.textContent).toContain("A task was added but the reply could not be posted.");
    expect(within(line).getByText("Last command failed").closest("[data-tone]")?.getAttribute("data-tone")).toBe(
      "danger",
    );
  });

  test("with none there is no such line", () => {
    show({ ...READY, commands: ON });
    expect(section("Commands").queryByText("Last command failed")).toBeNull();
  });
});

describe("the owner's switch and what Telegram says", () => {
  const names = () =>
    section("Commands")
      .getAllByRole("button")
      .map((b) => b.textContent);

  test("off here and off at Telegram: only a way to turn on", () => {
    show({ ...READY, commands: { ...EMPTY.commands, state: "off", checkedAt: 1 } });
    expect(names()).toEqual(["Turn on commands", "Check"]);
    expect(section("Commands").queryByText(/Telegram still sends/)).toBeNull();
  });

  test("on here and on at Telegram: only a way to turn off", () => {
    show({ ...READY, commands: ON });
    expect(names()).toEqual(["Turn off commands", "Check"]);
    expect(section("Commands").queryByText(/Telegram is not sending/)).toBeNull();
  });

  test("off here while Telegram still sends updates: said, nothing is acted on, and both ways are offered", async () => {
    const user = userEvent.setup();
    show({ ...READY, commands: { ...ON, wanted: false } });
    expect(
      section("Commands").getByText(
        "Commands are off: the OS acts on nothing said in the group. Telegram still sends the bot's updates to this address; turn off again to stop that.",
      ),
    ).toBeTruthy();
    expect(names()).toEqual(["Turn on commands", "Turn off commands", "Check"]);
    await user.click(button("Turn off commands"));
    expect(turnedOff()).toHaveBeenCalledWith({});
    // Groups do not arrive by webhook while commands are off.
    expect(section("Groups").queryByText(/Commands are on/)).toBeNull();
  });

  test("on here while Telegram sends the updates nowhere, or elsewhere: said, and both ways are offered", () => {
    for (const state of ["off", "elsewhere"]) {
      show({ ...READY, commands: { ...ON, state } });
      expect(
        section("Commands").getByText(
          "Commands are turned on, but Telegram is not sending the bot's updates here. Turn on again.",
        ),
      ).toBeTruthy();
      expect(names()).toEqual(["Turn on commands", "Turn off commands", "Check"]);
      cleanup();
    }
  });
});

describe("when the bot has seen no group", () => {
  test("the page says exactly what to send, with the bot's own name, and to click again", () => {
    show({ ...READY, chats: { us: null, kz: null }, found: [] });
    expect(
      section("Groups").getByText(
        "The bot has not seen a group yet. In the group, send /start@madeup_bot, then click Find my groups again.",
      ),
    ).toBeTruthy();
    expect(section("Groups").getByText(/only sees commands and messages that mention it/)).toBeTruthy();
  });

  test("before the bot's name is known it says how to write the command", () => {
    show({ ...READY, botUsername: null, chats: { us: null, kz: null }, found: [] });
    expect(
      section("Groups").getByText(
        "The bot has not seen a group yet. In the group, send /start@ followed by the bot's username, then click Find my groups again.",
      ),
    ).toBeTruthy();
  });

  test("the setup steps name the same command", () => {
    show(READY);
    expect(section("Set it up").getAllByRole("listitem")[4]!.textContent).toContain(
      "/start@madeup_bot",
    );
  });

  test("with commands on, groups arrive as the bot sees them, and the page says so", () => {
    show({ ...READY, commands: ON });
    expect(
      section("Groups").getByText(
        "Commands are on, so groups appear here as the bot sees them: send /start@madeup_bot in a group and it is listed.",
      ),
    ).toBeTruthy();
    cleanup();
    show(READY);
    expect(section("Groups").queryByText(/Commands are on/)).toBeNull();
  });
});

describe("where an untagged task goes", () => {
  const untagged = () =>
    screen.getByLabelText("A task with no #startup or #globex goes to:") as HTMLSelectElement;

  test("the choice is Globex, Startup or both boards, and starts as the server says", () => {
    show(READY);
    expect(options(untagged())).toEqual(["Globex", "Startup", "Both boards"]);
    expect(untagged().value).toBe("kz");
    expect(
      section("Groups").getByText(
        /Used when one group is picked for both companies\. A group picked for one company sends an untagged task to that company\./,
      ),
    ).toBeTruthy();
    cleanup();
    show({ ...READY, untagged: "both" });
    expect(untagged().value).toBe("both");
  });

  test("changed, it is saved with the rest; left alone, it is not sent", async () => {
    const user = userEvent.setup();
    show(READY);
    await user.click(button("Save"));
    expect(saved()).toHaveBeenLastCalledWith({ enabled: true, chatUs: US.id, chatKz: KZ.id });
    await user.selectOptions(untagged(), "us");
    await user.click(button("Save"));
    expect(saved()).toHaveBeenLastCalledWith({
      enabled: true,
      chatUs: US.id,
      chatKz: KZ.id,
      untagged: "us",
    });
  });

  test("what was chosen outlives a live update", async () => {
    const user = userEvent.setup();
    const view = show(READY);
    await user.selectOptions(untagged(), "both");
    convex.setQuery(api.telegram.settings, { ...READY, untagged: "us" });
    view.rerender(page());
    expect(untagged().value).toBe("both");
  });
});

describe("the Commands panel", () => {
  test("shows what people can type, the mention first, with the bot's own name", () => {
    show(READY);
    const forms = section("Commands")
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "");
    expect(forms[0]).toContain("@madeup_bot @username Title of the task");
    expect(forms[1]).toContain("/task @username Title of the task");
    expect(forms[2]).toContain("@madeup_bot @username #globex Title of the task");
    expect(forms[2]).toMatch(/#startup.*#globex.*#both/);
    expect(forms[3]).toContain("by 2026-10-20");
    expect(forms[3]).toMatch(/no other way of writing a date/i);
    expect(forms[4]).toMatch(/\/help/);
  });

  test("without the bot's name yet, the mention is shown with a stand-in", () => {
    show({ ...READY, botUsername: null });
    expect(section("Commands").getAllByRole("listitem")[0]!.textContent).toContain(
      "@your_bot @username Title of the task",
    );
  });

  test("says who can use them, and that the bot hears nothing else said in the group", () => {
    show(READY);
    const panel = section("Commands");
    expect(
      panel.getByText(
        /Only the owner and teammates with the Board page, by the Telegram username on record/,
      ),
    ).toBeTruthy();
    expect(
      panel.getByText(
        /The bot only sees commands and messages that mention it \(Telegram's privacy mode\), nothing else said in the group/,
      ),
    ).toBeTruthy();
    expect(panel.getByText(/Only teammates in Startup OS can add tasks here/)).toBeTruthy();
  });

  test.each([
    ["unknown", "Not checked yet", "neutral"],
    ["off", "Off", "neutral"],
    ["on", "On", "success"],
    ["elsewhere", "The bot's updates go to another address", "warning"],
  ])("state %s reads %s", (state, words, tone) => {
    show({ ...READY, commands: { ...ON, state } });
    const chip = section("Commands").getByText(words);
    expect(chip.closest("[data-tone]")?.getAttribute("data-tone")).toBe(tone);
  });

  test("off: a button turns them on", async () => {
    const user = userEvent.setup();
    show({ ...READY, commands: { ...ON, wanted: false, state: "off" } });
    expect(screen.queryByRole("button", { name: "Turn off commands" })).toBeNull();
    await user.click(button("Turn on commands"));
    expect(turnedOn()).toHaveBeenCalledWith({});
  });

  test("on: a button turns them off, and another checks", async () => {
    const user = userEvent.setup();
    show({ ...READY, commands: ON });
    expect(screen.queryByRole("button", { name: "Turn on commands" })).toBeNull();
    await user.click(button("Turn off commands"));
    expect(turnedOff()).toHaveBeenCalledWith({});
    await user.click(button("Check"));
    expect(checked()).toHaveBeenCalledWith({});
  });

  test("while it works the buttons say so and start nothing more", async () => {
    const user = userEvent.setup();
    show({ ...READY, commands: { ...ON, working: true } });
    const off = button("Turn off commands");
    expect(off.getAttribute("aria-disabled")).toBe("true");
    await user.click(off);
    await user.click(button("Check"));
    expect(turnedOff()).not.toHaveBeenCalled();
    expect(checked()).not.toHaveBeenCalled();
    expect(section("Commands").getByText("Working…")).toBeTruthy();
  });

  test("updates waiting, and a failed delivery, in the server's fixed words", () => {
    show({
      ...READY,
      commands: {
        ...ON,
        pending: 3,
        deliveryError: "Telegram could not deliver the last update to the OS.",
        deliveryErrorAt: Date.now() - 90 * 1000,
      },
    });
    const panel = section("Commands");
    expect(panel.getByText(/3 updates waiting/)).toBeTruthy();
    expect(panel.getByText("Telegram could not deliver the last update to the OS.")).toBeTruthy();
    expect(panel.getByText(/1m ago/)).toBeTruthy();
  });

  test("how the last change went, when it failed, in the server's fixed words", () => {
    show({
      ...READY,
      commands: { ...ON, state: "off", error: "Telegram would not change where the bot's updates go." },
    });
    const panel = section("Commands");
    expect(panel.getByText("Could not change").closest("[data-tone]")?.getAttribute("data-tone")).toBe(
      "danger",
    );
    expect(panel.getByText("Telegram would not change where the bot's updates go.")).toBeTruthy();
  });

  test("a refusal to start is shown in the server's words", async () => {
    const user = userEvent.setup();
    turnedOn().mockRejectedValueOnce(
      new ConvexError("This deployment has no https address for Telegram to call."),
    );
    show({ ...READY, commands: { ...ON, state: "off" } });
    await user.click(button("Turn on commands"));
    expect((await section("Commands").findByRole("alert")).textContent).toBe(
      "This deployment has no https address for Telegram to call.",
    );
  });
});

describe("what the page never shows", () => {
  test("says what a message holds and what it never does", () => {
    show(READY);
    expect(screen.getByText(/never the task's notes or anyone's email address/)).toBeTruthy();
  });
});
