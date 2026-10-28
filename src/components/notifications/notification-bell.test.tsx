// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { NOTIFICATION_PAGE } from "@convex/lib/limits";
import { ViewerProvider, type ViewerProfile } from "@/components/viewer-provider";
import { mockConvex } from "@/test-support/convex";
import { NotificationBell, openNotificationPanel } from "./notification-bell";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
const { NOW, push } = vi.hoisted(() => ({ NOW: Date.UTC(2026, 9, 13, 12), push: vi.fn() }));
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

// Every name and title here is made up.
const HOUR = 60 * 60 * 1000;
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "assigned",
  actor: { type: "user", name: "Olga Owner" },
  title: `Task ${id}`,
  company: null,
  taskId: `task-${id}`,
  decisionId: null,
  column: null,
  to: null,
  due: null,
  createdAt: NOW - 3 * HOUR,
  read: false,
  ...over,
});

const BOTH: ViewerProfile = {
  role: "cofounder",
  companies: ["us", "kz"],
  areas: ["board", "scorecard"],
  email: "cora@example.com",
  name: "Cora Founder",
};
const ONE: ViewerProfile = { ...BOTH, role: "sales", companies: ["us"] };
const NO_BOARD: ViewerProfile = { ...ONE, areas: ["finance"] };

let convex: ReturnType<typeof mockConvex>;
/** The arguments `notifications.mine` was asked with, in order. */
let asked: unknown[];
const list = (rows: unknown[], more = false) => {
  // One object, as a live query hands back the same result until it changes.
  const result = { rows, more };
  convex.setQueryBy(api.notifications.mine, (args) => {
    asked.push(args);
    return result;
  });
};

beforeEach(() => {
  convex = mockConvex();
  asked = [];
  push.mockClear();
  convex.setQuery(api.notifications.unreadCount, 0);
  list([]);
});
afterEach(cleanup);

const show = (viewer: ViewerProfile = BOTH) => {
  const view = render(
    <ViewerProvider viewer={viewer}>
      <NotificationBell />
    </ViewerProvider>,
  );
  return { ...view, user: userEvent.setup() };
};
const bell = () => screen.getByRole("button", { name: /^Notifications/ });
const open = async (viewer?: ViewerProfile) => {
  const view = show(viewer);
  await view.user.click(bell());
  return { ...view, panel: screen.getByRole("dialog", { name: "Notifications" }) };
};

describe("the bell", () => {
  test("with nothing unread: no badge, and a label that says so", () => {
    show();
    expect(bell().getAttribute("aria-label")).toBe("Notifications, none unread");
    expect(document.querySelector("[data-badge]")).toBeNull();
  });

  test("the count is on the badge and in the label", () => {
    convex.setQuery(api.notifications.unreadCount, 3);
    show();
    expect(bell().getAttribute("aria-label")).toBe("Notifications, 3 unread");
    expect(document.querySelector("[data-badge]")?.textContent).toBe("3");
  });

  test("past nine the badge says 9+, and the label still says how many", () => {
    convex.setQuery(api.notifications.unreadCount, 14);
    show();
    expect(document.querySelector("[data-badge]")?.textContent).toBe("9+");
    expect(bell().getAttribute("aria-label")).toBe("Notifications, 14 unread");
  });

  test("a new notification changes the badge by itself", () => {
    const { rerender } = show();
    convex.setQuery(api.notifications.unreadCount, 1);
    rerender(
      <ViewerProvider viewer={BOTH}>
        <NotificationBell />
      </ViewerProvider>,
    );
    expect(document.querySelector("[data-badge]")?.textContent).toBe("1");
  });

  test("the list is not asked for until the panel is opened", async () => {
    const { user } = show();
    expect(asked).toEqual([]);
    await user.click(bell());
    expect(asked[0]).toEqual({ count: NOTIFICATION_PAGE });
  });
});

describe("opened from Today's Show all", () => {
  const both = () =>
    render(
      <ViewerProvider viewer={BOTH}>
        <NotificationBell place="side" />
        <NotificationBell />
      </ViewerProvider>,
    );
  const wide = (matches: boolean) =>
    vi.stubGlobal("matchMedia", (query: string) => ({ matches, media: query }) as MediaQueryList);
  afterEach(() => vi.unstubAllGlobals());

  test.each([
    ["from md up, the sidebar's bell", true],
    ["below md, the top bar's bell", false],
  ])("%s opens its panel, and only one panel opens", async (_where, isWide) => {
    wide(isWide);
    both();
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => openNotificationPanel());
    expect(await screen.findAllByRole("dialog", { name: "Notifications" })).toHaveLength(1);
  });
});

describe("the panel", () => {
  test("is a labelled dialog that Escape closes, giving focus back to the bell", async () => {
    const { user, panel } = await open();
    expect(panel).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(bell());
  });

  test("says so, honestly, when there is nothing", async () => {
    const { panel } = await open();
    expect(
      within(panel).getByText(
        "Nothing yet. When someone gives you a task or mentions you, it shows here.",
      ),
    ).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: "Mark all as read" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Show more" })).toBeNull();
  });

  test("a row: who, the sentence, the title set apart, and how long ago", async () => {
    list([row("a")]);
    const { panel } = await open();
    const item = within(panel).getByRole("listitem");
    expect(item.textContent).toContain("Olga Owner gave you Task a");
    expect(within(item).getByText("Task a").className).toContain("font-medium");
    expect(within(item).getByText("3h ago")).toBeTruthy();
    // The chip holds the person's initials, for the eye only.
    expect(item.querySelector("[data-initials]")?.textContent).toBe("OO");
    expect(item.querySelector("[data-initials]")?.getAttribute("aria-hidden")).toBe("true");
  });

  test("someone the viewer is not told of, and the standup, have no initials to show", async () => {
    list([
      row("a", { actor: { type: "user", name: null } }),
      row("b", { actor: { type: "system", source: "standup" } }),
    ]);
    const { panel } = await open();
    const [unknown, standup] = within(panel).getAllByRole("listitem");
    expect(unknown!.textContent).toContain("A teammate gave you Task a");
    expect(standup!.textContent).toContain("The standup gave you Task b");
    expect(panel.querySelector("[data-initials]")).toBeNull();
  });

  test("unread rows are marked, in words too; read ones are not", async () => {
    list([row("a"), row("b", { read: true })]);
    const { panel } = await open();
    const [unread, read] = within(panel).getAllByRole("listitem");
    expect(unread!.getAttribute("data-unread")).toBe("true");
    expect(within(unread!).getByText("Unread")).toBeTruthy();
    expect(read!.getAttribute("data-unread")).toBeNull();
    expect(within(read!).queryByText("Unread")).toBeNull();
  });

  test("the company is tagged for a viewer on both, and not for a viewer on one", async () => {
    list([row("a", { company: "kz" }), row("b")]);
    const { panel, unmount } = await open(BOTH);
    const [tagged, shared] = within(panel).getAllByRole("listitem");
    expect(within(tagged!).getByText("Globex")).toBeTruthy();
    expect(shared!.querySelector("[data-slot=kind-tag]")).toBeNull();
    unmount();
    list([row("a", { company: "us" })]);
    const again = await open(ONE);
    expect(again.panel.querySelector("[data-slot=kind-tag]")).toBeNull();
  });

  test("a title is text, whatever it holds", async () => {
    list([row("a", { title: '<img src=x onerror="alert(1)"> <b>bold</b>' })]);
    const { panel } = await open();
    expect(panel.querySelector("img, b")).toBeNull();
    expect(panel.textContent).toContain('<img src=x onerror="alert(1)"> <b>bold</b>');
  });
});

describe("a decision's reminder", () => {
  const revisit = (over: Record<string, unknown> = {}) =>
    row("d", {
      kind: "decision_revisit",
      actor: { type: "system", source: "memory" },
      taskId: null,
      decisionId: "decision-d",
      title: "Price per seat",
      ...over,
    });

  test("leads to the decision on the memory page, for a viewer with that page", async () => {
    list([revisit()]);
    const { user, panel } = await open({ ...BOTH, areas: ["memory"] });
    expect(panel.textContent).toContain("Reminder: time to revisit Price per seat");
    await user.click(within(panel).getByRole("button", { name: /Price per seat/ }));
    expect(push).toHaveBeenCalledWith("/memory?decision=decision-d");
  });

  test("leads nowhere without the memory page", async () => {
    list([revisit({ read: true })]);
    const { panel } = await open({ ...BOTH, areas: ["board"] });
    expect(within(panel).queryByRole("button", { name: /Price per seat/ })).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });
});

describe("opening one", () => {
  test("marks it read and goes to the board with that task open", async () => {
    list([row("a")]);
    const { user, panel } = await open();
    await user.click(within(panel).getByRole("button", { name: /Task a/ }));
    expect(convex.mutation(api.notifications.markRead)).toHaveBeenCalledWith({ id: "a" });
    expect(push).toHaveBeenCalledWith("/board?task=task-a");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("one already read is not marked again, and still leads to its task", async () => {
    list([row("a", { read: true })]);
    const { user, panel } = await open();
    await user.click(within(panel).getByRole("button", { name: /Task a/ }));
    expect(convex.mutation(api.notifications.markRead)).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith("/board?task=task-a");
  });

  test("a deleted task's row reads from what was kept, leads nowhere, and can still be marked read", async () => {
    list([row("a", { taskId: null })]);
    const { user, panel } = await open();
    expect(panel.textContent).toContain("Olga Owner gave you Task a");
    await user.click(within(panel).getByRole("button", { name: /Task a/ }));
    expect(convex.mutation(api.notifications.markRead)).toHaveBeenCalledWith({ id: "a" });
    expect(push).not.toHaveBeenCalled();
    // Still open: there was nowhere to go.
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  test("once such a row is read there is nothing left to press", async () => {
    list([row("a", { taskId: null, read: true })]);
    const { panel } = await open();
    expect(within(panel).queryByRole("button", { name: /Task a/ })).toBeNull();
    expect(panel.textContent).toContain("Task a");
  });

  test("a viewer without the board is told, and is not sent to a page they cannot open", async () => {
    list([row("a")]);
    const { user, panel } = await open(NO_BOARD);
    await user.click(within(panel).getByRole("button", { name: /Task a/ }));
    expect(convex.mutation(api.notifications.markRead)).toHaveBeenCalledWith({ id: "a" });
    expect(push).not.toHaveBeenCalled();
  });

  test("a row that went in the meantime does not keep someone from their task", async () => {
    list([row("a")]);
    convex
      .mutation(api.notifications.markRead)
      .mockRejectedValueOnce(new ConvexError("That notification is no longer there."));
    const { user, panel } = await open();
    await user.click(within(panel).getByRole("button", { name: /Task a/ }));
    expect(push).toHaveBeenCalledWith("/board?task=task-a");
  });

  test("a refusal with nowhere to go is said in the panel", async () => {
    list([row("a", { taskId: null })]);
    convex
      .mutation(api.notifications.markRead)
      .mockRejectedValueOnce(new ConvexError("That notification is no longer there."));
    const { user, panel } = await open();
    await user.click(within(panel).getByRole("button", { name: /Task a/ }));
    expect((await within(panel).findByRole("alert")).textContent).toBe(
      "That notification is no longer there.",
    );
  });
});

describe("mark all as read", () => {
  test("is offered while something is unread, and calls the mutation once", async () => {
    convex.setQuery(api.notifications.unreadCount, 2);
    list([row("a"), row("b")]);
    const { user, panel } = await open();
    await user.click(within(panel).getByRole("button", { name: "Mark all as read" }));
    expect(convex.mutation(api.notifications.markAllRead)).toHaveBeenCalledTimes(1);
    expect(convex.mutation(api.notifications.markAllRead)).toHaveBeenCalledWith({});
  });

  test("is not offered when everything is read", async () => {
    list([row("a", { read: true })]);
    const { panel } = await open();
    expect(within(panel).queryByRole("button", { name: "Mark all as read" })).toBeNull();
  });

  test("a failure is said", async () => {
    convex.setQuery(api.notifications.unreadCount, 1);
    list([row("a")]);
    convex.mutation(api.notifications.markAllRead).mockRejectedValueOnce(new Error("offline"));
    const { user, panel } = await open();
    await user.click(within(panel).getByRole("button", { name: "Mark all as read" }));
    expect((await within(panel).findByRole("alert")).textContent).toBe(
      "That could not be saved. Try again.",
    );
  });
});

describe("show more", () => {
  test("asks for the next page, keeping what is shown, and goes when there is no more", async () => {
    const pages = new Map([[NOTIFICATION_PAGE, { rows: [row("a")], more: true }]]);
    convex.setQueryBy(api.notifications.mine, (args) => {
      asked.push(args);
      return pages.get((args as { count: number }).count);
    });
    const { user, panel, rerender } = await open();
    expect(within(panel).getAllByRole("listitem")).toHaveLength(1);
    await user.click(within(panel).getByRole("button", { name: "Show more" }));
    expect(asked.at(-1)).toEqual({ count: NOTIFICATION_PAGE * 2 });
    // The longer list has not arrived: what was there stays, not a blank.
    expect(within(panel).getAllByRole("listitem")).toHaveLength(1);
    expect(panel.querySelector("[aria-busy]")).toBeNull();
    pages.set(NOTIFICATION_PAGE * 2, { rows: [row("a"), row("b")], more: false });
    rerender(
      <ViewerProvider viewer={BOTH}>
        <NotificationBell />
      </ViewerProvider>,
    );
    expect(within(panel).getAllByRole("listitem")).toHaveLength(2);
    expect(within(panel).queryByRole("button", { name: "Show more" })).toBeNull();
  });

  test("closing the panel goes back to the first page", async () => {
    list([row("a")], true);
    const { user, panel } = await open();
    await user.click(within(panel).getByRole("button", { name: "Show more" }));
    await user.keyboard("{Escape}");
    asked.length = 0;
    await user.click(bell());
    expect(asked[0]).toEqual({ count: NOTIFICATION_PAGE });
  });
});
