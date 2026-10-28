// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { mockConvex } from "@/test-support/convex";
import { TaskCard, type Task } from "./task-card";
import { TaskEditor } from "./task-editor";

// Mentions: typing `@` in a card's title or description offers the people the
// card could be given to, and the save says who was picked. Every name and
// address here is made up.

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

const PEOPLE = [
  { email: "ada@example.com", name: "Ada Example", companies: ["us", "kz"] },
  { email: "adam@example.com", name: "Adam Ng", companies: ["us"] },
  { email: "sam@example.com", name: null, companies: ["kz"] },
];

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
  convex.setQueryBy(api.team.assignable, (args) => {
    const company = (args as { company?: string }).company;
    return PEOPLE.filter((p) => company === undefined || p.companies.includes(company)).map(
      ({ email, name }) => ({ email, name }),
    );
  });
});
afterEach(cleanup);

const task = (over: Partial<Task> = {}): Task =>
  ({
    id: "t1",
    title: "Send the deck",
    notes: null,
    kind: "task",
    column: "backlog",
    due: null,
    goalId: null,
    goalTitle: null,
    doneAt: null,
    company: null,
    assignee: null,
    mentions: [],
    origin: null,
    ...over,
  }) as Task;

const edit = (over: Partial<Task> = {}) => {
  const onClose = vi.fn();
  render(<TaskEditor task={task(over)} quarter={null} onClose={onClose} />);
  return { onClose, user: userEvent.setup() };
};

const notes = () => screen.getByLabelText("Description") as HTMLTextAreaElement;
const title = () => screen.getByLabelText("Title") as HTMLTextAreaElement;
const list = () => screen.queryByRole("listbox", { name: "People to mention" });
const offered = () =>
  within(list()!)
    .getAllByRole("option")
    .map((option) => option.textContent);
const chosen = () =>
  within(list()!)
    .getAllByRole("option")
    .find((option) => option.getAttribute("aria-selected") === "true")?.textContent;
const save = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "Save" }));
const saved = () =>
  convex.mutation(api.tasks.update).mock.calls.at(-1)?.[0] as Record<string, unknown>;

describe("typing @ in the description", () => {
  test("offers the people the card could be given to, and nothing before an @", async () => {
    const { user } = edit();
    await user.type(notes(), "Ask ");
    expect(list()).toBeNull();
    await user.type(notes(), "@");
    expect(offered()).toEqual(["Ada Example", "Adam Ng", "sam"]);
    expect(notes().getAttribute("aria-expanded")).toBe("true");
    expect(notes().getAttribute("aria-controls")).toBe(list()!.id);
  });

  test("only the people of the card's company", async () => {
    const { user } = edit({ company: "kz" });
    await user.type(notes(), "@");
    expect(offered()).toEqual(["Ada Example", "sam"]);
  });

  test("the list narrows as a name is typed, and goes when nobody matches or a space is typed", async () => {
    const { user } = edit();
    await user.type(notes(), "@ad");
    expect(offered()).toEqual(["Ada Example", "Adam Ng"]);
    await user.type(notes(), "am");
    expect(offered()).toEqual(["Adam Ng"]);
    await user.type(notes(), "x");
    expect(list()).toBeNull();
    await user.clear(notes());
    await user.type(notes(), "@ada ");
    expect(list()).toBeNull();
  });

  test("an address being typed is not a mention", async () => {
    const { user } = edit();
    await user.type(notes(), "write to ada@");
    expect(list()).toBeNull();
  });

  test("Enter puts the first person in, as @Name and a space, and closes the list", async () => {
    const { user, onClose } = edit();
    await user.type(notes(), "Ask @ad{Enter}");
    expect(notes().value).toBe("Ask @Ada Example ");
    expect(list()).toBeNull();
    // Enter chose a person: it did not save the card or add a line.
    expect(convex.mutation(api.tasks.update)).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await user.type(notes(), "about it");
    expect(notes().value).toBe("Ask @Ada Example about it");
  });

  test("the arrow keys move through the list, round and round; the one marked is the one Enter takes", async () => {
    const { user } = edit();
    await user.type(notes(), "@");
    expect(chosen()).toBe("Ada Example");
    await user.keyboard("{ArrowDown}");
    expect(chosen()).toBe("Adam Ng");
    expect(notes().getAttribute("aria-activedescendant")).toBe(
      within(list()!).getByRole("option", { name: "Adam Ng" }).id,
    );
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(chosen()).toBe("Ada Example");
    await user.keyboard("{ArrowUp}");
    expect(chosen()).toBe("sam");
    await user.keyboard("{Enter}");
    expect(notes().value).toBe("@sam ");
  });

  test("a person can be picked with the pointer, and the caret stays in the field", async () => {
    const { user } = edit();
    await user.type(notes(), "@");
    await user.click(within(list()!).getByRole("option", { name: "Adam Ng" }));
    expect(notes().value).toBe("@Adam Ng ");
    expect(document.activeElement).toBe(notes());
  });

  test("Escape puts the list away and leaves the editor open with what was typed", async () => {
    const { user, onClose } = edit();
    await user.type(notes(), "@ad");
    await user.keyboard("{Escape}");
    expect(list()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(notes().value).toBe("@ad");
    // It stays away for this word, and comes back for the next @.
    await user.type(notes(), "a");
    expect(list()).toBeNull();
    await user.type(notes(), " @");
    expect(offered()).toEqual(["Ada Example", "Adam Ng", "sam"]);
    // Put away once is not put away for good: a new @ in the same place is offered again.
    await user.keyboard("{Escape}");
    await user.clear(notes());
    await user.type(notes(), "x");
    await user.clear(notes());
    await user.type(notes(), "@");
    expect(offered()).toEqual(["Ada Example", "Adam Ng", "sam"]);
    await user.keyboard("{Escape}");
    await user.clear(notes());
    await user.type(notes(), "@");
    expect(list()).not.toBeNull();
    // With no list in the way, Escape closes the editor as before.
    await user.keyboard("{Escape}{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("typing @ in the title", () => {
  test("works the same, and Enter picks rather than saves while the list is open", async () => {
    const { user } = edit({ title: "Plan" });
    await user.type(title(), " with @ada{Enter}");
    expect(title().value).toBe("Plan with @Ada Example ");
    expect(convex.mutation(api.tasks.update)).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(saved()).toMatchObject({ title: "Plan with @Ada Example ", mentions: ["ada@example.com"] });
  });
});

describe("what a save says", () => {
  test("the people picked, by address, beside the text", async () => {
    const { user } = edit();
    await user.type(notes(), "@ada{Enter}and @sam{Enter}");
    await save(user);
    expect(saved()).toMatchObject({
      notes: "@Ada Example and @sam ",
      mentions: ["ada@example.com", "sam@example.com"],
    });
  });

  test("who will be told is said under the field before saving", async () => {
    const { user } = edit();
    expect(screen.queryByText(/will be told/)).toBeNull();
    await user.type(notes(), "@ada{Enter}");
    expect(screen.getByText("Ada Example will be told when you save.")).toBeTruthy();
    await user.type(notes(), "@sam{Enter}");
    expect(screen.getByText("Ada Example and sam will be told when you save.")).toBeTruthy();
  });

  test("someone picked and then deleted from the text is not sent", async () => {
    const { user } = edit();
    await user.type(notes(), "@ada{Enter}");
    await user.clear(notes());
    await user.type(notes(), "never mind");
    expect(screen.queryByText(/will be told/)).toBeNull();
    await save(user);
    expect(saved()).not.toHaveProperty("mentions");
  });

  test("a name only typed, never picked, mentions nobody", async () => {
    const { user } = edit();
    await user.type(notes(), "@Ada Example please");
    await save(user);
    expect(saved()).toMatchObject({ notes: "@Ada Example please" });
    expect(saved()).not.toHaveProperty("mentions");
  });

  test("a save with no mention sends none", async () => {
    const { user } = edit();
    await save(user);
    expect(saved()).not.toHaveProperty("mentions");
  });

  test("the server's refusal is shown as it came, and the editor stays open", async () => {
    const { user, onClose } = edit();
    convex
      .mutation(api.tasks.update)
      .mockRejectedValue(new ConvexError("That person cannot be mentioned on this task."));
    await user.type(notes(), "@ada{Enter}");
    await save(user);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That person cannot be mentioned on this task.",
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("a mention on a card", () => {
  const show = (over: Partial<Task>) =>
    render(<TaskCard task={task(over)} today="2026-10-12" onOpen={() => {}} />);
  const marks = () =>
    [...document.querySelectorAll("[data-mention]")].map((mark) => mark.textContent);

  test("an @name the card mentions is set apart, in the title and in the description", () => {
    show({
      title: "Plan with @Ada Example",
      notes: "and ask @sam too",
      mentions: ["Ada Example", "sam"],
    });
    expect(marks()).toEqual(["@Ada Example", "@sam"]);
    // The title is still one button, named by all of it.
    expect(screen.getByRole("button", { name: "Plan with @Ada Example" })).toBeTruthy();
  });

  test("an @name the card does not mention is ordinary text", () => {
    show({ title: "Plan with @Ada Example", mentions: [] });
    expect(marks()).toEqual([]);
    expect(screen.getByRole("button", { name: "Plan with @Ada Example" })).toBeTruthy();
  });

  test("stored text is never markup, mention or not", () => {
    show({
      title: '<img src=x onerror="alert(1)"> @Ada Example',
      notes: "<b>bold</b> @Ada Example <script>alert(1)</script>",
      mentions: ["Ada Example"],
    });
    expect(document.querySelector("img, b, script")).toBeNull();
    expect(document.body.textContent).toContain("<b>bold</b> @Ada Example <script>alert(1)</script>");
  });

  test("a name that is itself markup is text too", () => {
    show({ title: "Hi @<i>x</i>", mentions: ["<i>x</i>"] });
    expect(document.querySelector("i")).toBeNull();
    expect(marks()).toEqual(["@<i>x</i>"]);
  });
});
