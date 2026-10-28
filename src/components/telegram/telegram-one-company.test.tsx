// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "convex/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import type { Area } from "@convex/lib/roles";
import { ViewerProvider } from "@/components/viewer-provider";
import type { CompanyId } from "@/lib/company";
import { mockConvex } from "@/test-support/convex";
import { ONE_COMPANY_NOTE, TELEGRAM_NOT_YOURS, TelegramSettings } from "./telegram-settings";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

// The Telegram page for a teammate who was given "Sources and Telegram". The
// bot's settings are one set for both companies, so someone on one company
// gets their own company's group and reads the rest (convex/telegram.ts).

const KZ = { id: "-1002", title: "Globex team" };

/** What `telegram.settings` sends a holder on Globex alone. */
const FOR_KZ = {
  tokenSet: true,
  siteSet: true,
  enabled: true,
  // Startup's group reads as null whether or not one is picked.
  chats: { us: null, kz: KZ },
  canChangeShared: false,
  // Which group is a company's, and the list it is picked from, are the owner's.
  canPickGroups: false,
  mine: null,
  mineLinked: false,
  mineLinkedAt: null,
  people: [],
  log: [],
  botUsername: "madeup_bot",
  untagged: "kz",
  commands: {
    wanted: false,
    failure: null,
    failureAt: null,
    state: "off",
    pending: 0,
    deliveryError: null,
    deliveryErrorAt: null,
    checkedAt: 1,
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
  teammates: 2,
  withoutUsername: 1,
};

let convex: ReturnType<typeof mockConvex>;
const page = (areas: Area[], companies: CompanyId[]) => (
  <ViewerProvider
    viewer={{ role: "engineer", companies, areas, email: "someone@example.com", name: null }}
  >
    <TelegramSettings />
  </ViewerProvider>
);
const show = (settings: object, companies: CompanyId[] = ["kz"]) => {
  convex.setQuery(api.telegram.settings, settings);
  return render(page(["settings"], companies));
};
const button = (name: string | RegExp) => screen.getByRole("button", { name });
const saved = () => convex.mutation(api.telegram.save);

beforeEach(() => {
  convex = mockConvex();
  vi.mocked(useQuery).mockClear();
});
afterEach(cleanup);

describe("a holder on one company", () => {
  test("is told, in fixed words, what is theirs here and what is not", () => {
    show(FOR_KZ);
    expect(ONE_COMPANY_NOTE("Globex")).toBe(
      "You are on Globex only. You see Globex's group and can send it a test message. The owner picks the groups. Whether messages are sent at all, where an untagged task goes and whether commands are on are shared by both companies: only the owner, or someone who is on both, changes them. The other company's group is not shown to you.",
    );
    expect(screen.getByText(ONE_COMPANY_NOTE("Globex"))).toBeTruthy();
  });

  test("reads which group is their company's, with its id, and has nothing to pick it with", () => {
    show({ ...FOR_KZ, chats: { us: null, kz: { ...KZ, members: 5 } } });
    const groups = within(screen.getByRole("region", { name: "Groups" }));
    expect(groups.getByText("The owner picks the groups.")).toBeTruthy();
    expect(groups.getByText("Globex's group")).toBeTruthy();
    expect(groups.getByText("Globex team · id -1002 · 5 members")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: /group$/ })).toBeNull();
    expect(groups.queryByText("Startup's group")).toBeNull();
    // Nor the list of groups the bot has seen, or the way to fill it.
    expect(screen.queryByRole("table", { name: "Groups the bot has seen" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Find my groups" })).toBeNull();
    expect(groups.queryByText(/No groups found yet/)).toBeNull();
  });

  test("with no group picked for their company yet, it says whose move that is", () => {
    show({ ...FOR_KZ, chats: { us: null, kz: null } });
    const groups = within(screen.getByRole("region", { name: "Groups" }));
    expect(groups.getByText("None yet: the owner has not picked one.")).toBeTruthy();
    expect(
      button("Send a test message to Globex's group").getAttribute("aria-disabled"),
    ).toBe("true");
    expect(groups.queryByText(/Save a group for/)).toBeNull();
  });

  test("is told when the bot has left their company's group", () => {
    show({ ...FOR_KZ, chats: { us: null, kz: { ...KZ, left: true } } });
    expect(
      screen.getByText("The bot is no longer in this group. The owner adds it again or picks another."),
    ).toBeTruthy();
  });

  test("reads the shared settings and cannot change them, and has nothing to save", async () => {
    const user = userEvent.setup();
    show(FOR_KZ);
    const onOff = screen.getByRole("switch", { name: "Send a message when a task is assigned" });
    expect(onOff.getAttribute("aria-checked")).toBe("true");
    expect(onOff.getAttribute("aria-disabled")).toBe("true");
    await user.click(onOff);
    expect(onOff.getAttribute("aria-checked")).toBe("true");
    const untagged = screen.getByLabelText(/A task with no #startup or #globex goes to/) as HTMLSelectElement;
    expect(untagged.value).toBe("kz");
    expect(untagged.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(saved()).not.toHaveBeenCalled();
  });

  test("can test their own company's group, and is offered no test of the other", async () => {
    const user = userEvent.setup();
    show(FOR_KZ);
    expect(screen.queryByRole("button", { name: /test message to Startup/ })).toBeNull();
    await user.click(button("Send a test message to Globex's group"));
    expect(convex.mutation(api.telegram.sendTest)).toHaveBeenCalledWith({ company: "kz" });
    // Nothing on the page says Startup's group is missing: it is not theirs to set.
    expect(screen.queryByText(/Save a group for Startup/)).toBeNull();
  });

  test("cannot turn commands on or off, and can ask how they stand", async () => {
    const user = userEvent.setup();
    show(FOR_KZ);
    const commands = within(screen.getByRole("region", { name: "Commands" }));
    const turnOn = commands.getByRole("button", { name: "Turn on commands" });
    expect(turnOn.getAttribute("aria-disabled")).toBe("true");
    await user.click(turnOn);
    expect(convex.mutation(api.telegramInbound.commandsOn)).not.toHaveBeenCalled();
    expect(
      commands.getByText("Commands are shared by both companies: only the owner, or someone who is on both, turns them on or off."),
    ).toBeTruthy();
    await user.click(commands.getByRole("button", { name: "Check" }));
    expect(convex.mutation(api.telegramInbound.checkCommands)).toHaveBeenCalledTimes(1);
  });

  test("with commands on, turning them off is blocked the same way", async () => {
    const user = userEvent.setup();
    show({ ...FOR_KZ, commands: { ...FOR_KZ.commands, state: "on" } });
    const turnOff = screen.getByRole("button", { name: "Turn off commands" });
    expect(turnOff.getAttribute("aria-disabled")).toBe("true");
    await user.click(turnOff);
    expect(convex.mutation(api.telegramInbound.commandsOff)).not.toHaveBeenCalled();
  });

  test("has no field for a username of their own: theirs is on their row on the Team page", () => {
    show(FOR_KZ);
    expect(screen.queryByLabelText("Your Telegram username")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save username" })).toBeNull();
    // Every username, theirs included, is edited in its row on the Team page.
    expect(screen.getByText(/· Edit on Team/)).toBeTruthy();
  });
});

describe("a holder on both companies", () => {
  const FOR_BOTH = {
    ...FOR_KZ,
    chats: { us: { id: "-1001", title: "Startup team" }, kz: KZ },
    canChangeShared: true,
  };

  test("changes what both companies share, and never which group is whose", async () => {
    const user = userEvent.setup();
    show(FOR_BOTH, ["us", "kz"]);
    expect(screen.queryByText(/^You are on /)).toBeNull();
    await user.click(screen.getByRole("switch", { name: "Send a message when a task is assigned" }));
    await user.selectOptions(screen.getByLabelText(/A task with no #startup or #globex goes to/), "both");
    await user.click(button("Save"));
    // No group is named: naming one is asking to change it, and that is the owner's.
    expect(saved()).toHaveBeenCalledWith({ enabled: false, untagged: "both" });
    expect(screen.queryByRole("combobox", { name: /group$/ })).toBeNull();
    expect(screen.getByText("The owner picks the groups.")).toBeTruthy();
    expect(screen.getByText("Startup team · id -1001")).toBeTruthy();
    await user.click(button("Turn on commands"));
    expect(convex.mutation(api.telegramInbound.commandsOn)).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("Your Telegram username")).toBeNull();
  });
});

describe("someone without the page", () => {
  test("a teammate with every other sensitive page gets a line and no query", () => {
    convex.setQuery(api.telegram.settings, FOR_KZ);
    render(page(["payroll", "team", "board"], ["us", "kz"]));
    expect(TELEGRAM_NOT_YOURS).toBe(
      "Only the owner, and people the owner gives the Sources and Telegram pages, set up Telegram.",
    );
    expect(screen.getByText(TELEGRAM_NOT_YOURS)).toBeTruthy();
    expect(vi.mocked(useQuery).mock.calls.every(([, args]) => args === "skip")).toBe(true);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
