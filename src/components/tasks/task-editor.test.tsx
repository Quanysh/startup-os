// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { ViewerProvider, type ViewerProfile } from "@/components/viewer-provider";
import { mockConvex } from "@/test-support/convex";
import { ASSIGNEE_NOT_ON_COMPANY } from "./assignee";
import type { Task } from "./task-card";
import { TaskEditor } from "./task-editor";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

// Every name and address here is made up. Ada is on both companies, Sam on
// Globex alone.
const PEOPLE = [
  { email: "ada@example.com", name: "Ada Example", companies: ["us", "kz"] },
  { email: "sam@example.com", name: null, companies: ["kz"] },
];
const SAM = { status: "teammate", email: "sam@example.com", name: null } as const;

let convex: ReturnType<typeof mockConvex>;
/** The arguments `team.assignable` was asked with, in order. */
let asked: unknown[];
beforeEach(() => {
  convex = mockConvex();
  asked = [];
  convex.setQueryBy(api.team.assignable, (args) => {
    asked.push(args);
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
    origin: null,
    ...over,
  }) as Task;

const member = (companies: ViewerProfile["companies"]): ViewerProfile => ({
  role: "engineer",
  companies,
  areas: ["product", "board"],
  email: "sam@example.com",
  name: null,
});

const edit = (over: Partial<Task> = {}, viewer?: ViewerProfile) => {
  const onClose = vi.fn();
  const editor = <TaskEditor task={task(over)} quarter={null} onClose={onClose} />;
  render(viewer ? <ViewerProvider viewer={viewer}>{editor}</ViewerProvider> : editor);
  return { onClose, user: userEvent.setup() };
};

const assignee = () => screen.getByLabelText("Assignee") as HTMLSelectElement;
const company = () => screen.getByLabelText("Company") as HTMLSelectElement;
const optionsOf = (select: HTMLSelectElement) => [...select.options].map((o) => o.textContent);
const save = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "Save" }));
const saved = () =>
  convex.mutation(api.tasks.update).mock.calls.at(-1)?.[0] as Record<string, unknown>;

describe("TaskEditor: the assignee", () => {
  test("a shared task can go to anyone the viewer works with, Unassigned first", () => {
    edit();
    expect(asked.at(-1)).toEqual({});
    expect(optionsOf(assignee())).toEqual(["Unassigned", "Ada Example", "sam"]);
    expect(assignee().value).toBe("");
  });

  test("a company's task lists that company's people", () => {
    edit({ company: "us" });
    expect(asked.at(-1)).toEqual({ company: "us" });
    expect(optionsOf(assignee())).toEqual(["Unassigned", "Ada Example"]);
  });

  test("the person picked is saved by address", async () => {
    const { user, onClose } = edit();
    await user.selectOptions(assignee(), "Ada Example");
    await save(user);
    expect(saved()).toMatchObject({ id: "t1", assignee: "ada@example.com" });
    expect(onClose).toHaveBeenCalled();
  });

  test("Unassigned clears the assignee", async () => {
    const { user } = edit({ assignee: SAM });
    expect(assignee().value).toBe("sam@example.com");
    await user.selectOptions(assignee(), "Unassigned");
    await save(user);
    expect(saved()).toMatchObject({ assignee: null });
  });

  test("an assignee left alone is not sent, so the server keeps it", async () => {
    const { user } = edit({ assignee: SAM });
    await save(user);
    expect(saved()).not.toHaveProperty("assignee");
  });

  test("a removed teammate stays on the card until someone else is picked", async () => {
    const { user } = edit({ assignee: { status: "removed", email: null, name: null } });
    expect(optionsOf(assignee())).toEqual(["Unassigned", "Ada Example", "sam", "Removed teammate"]);
    expect(assignee().selectedOptions[0]?.textContent).toBe("Removed teammate");
    await save(user);
    expect(saved()).not.toHaveProperty("assignee");
  });

  test("the server's refusal is shown as it came", async () => {
    const { user, onClose } = edit();
    convex
      .mutation(api.tasks.update)
      .mockRejectedValue(new ConvexError("That person cannot be given this task."));
    await user.selectOptions(assignee(), "sam");
    await save(user);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That person cannot be given this task.",
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("TaskEditor: the company", () => {
  test("a viewer with both companies can tie the task to one, or to both", async () => {
    const { user } = edit({ company: "kz" });
    expect(optionsOf(company())).toEqual(["Both companies", "Startup", "Globex"]);
    expect(company().value).toBe("kz");
    await user.selectOptions(company(), "Both companies");
    expect(asked.at(-1)).toEqual({});
    await save(user);
    expect(saved()).toMatchObject({ company: null });
  });

  test("changing the company reads that company's people and saves it", async () => {
    const { user } = edit();
    await user.selectOptions(company(), "Startup");
    expect(asked.at(-1)).toEqual({ company: "us" });
    expect(optionsOf(assignee())).toEqual(["Unassigned", "Ada Example"]);
    await save(user);
    expect(saved()).toMatchObject({ company: "us" });
  });

  test("a viewer with one company gets no picker and never sends a company", async () => {
    const { user } = edit({ company: "kz" }, member(["kz"]));
    expect(screen.queryByLabelText("Company")).toBeNull();
    expect(asked.at(-1)).toEqual({ company: "kz" });
    await save(user);
    expect(saved()).not.toHaveProperty("company");
  });

  test("moving a task to a company its assignee is not on is stopped before the server", async () => {
    const { user, onClose } = edit({ company: "kz", assignee: SAM });
    await user.selectOptions(company(), "Startup");
    expect(optionsOf(assignee())).toEqual(["Unassigned", "Ada Example", "sam (not on Startup)"]);
    expect(assignee().value).toBe("sam@example.com");
    expect(screen.getByText("Not on Startup. Unassign the task, or pick someone who is.")).toBeTruthy();

    await save(user);
    expect((await screen.findByRole("alert")).textContent).toBe(ASSIGNEE_NOT_ON_COMPANY);
    expect(convex.mutation(api.tasks.update)).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    await user.selectOptions(assignee(), "Unassigned");
    await save(user);
    expect(saved()).toMatchObject({ company: "us", assignee: null });
  });

  test("an assignee who drifted off the task's company does not block other edits", async () => {
    // Their companies changed after the task was given to them. The server
    // keeps them while the company stays as it is; so does the form.
    const { user } = edit({ company: "us", assignee: SAM });
    expect(optionsOf(assignee())).toEqual(["Unassigned", "Ada Example", "sam"]);
    await save(user);
    expect(saved()).toMatchObject({ company: "us" });
    expect(saved()).not.toHaveProperty("assignee");
  });
});

describe("TaskEditor: a card someone suggested", () => {
  test("says who suggested it, by name, beside the tag", () => {
    edit({ origin: { source: "suggestion", suggestedBy: "Ada Example" } });
    expect(
      screen.getByText(
        "Suggested by Ada Example. Sent with “Suggest a change”: turn it into a task, or delete it.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Feedback on Startup OS").getAttribute("data-slot")).toBe("kind-tag");
  });

  test("names nobody when the viewer is not told who it was", () => {
    edit({ origin: { source: "suggestion", suggestedBy: null } });
    expect(screen.getByText(/^Suggested by a teammate\./)).toBeTruthy();
  });

  test("saving sends no origin", async () => {
    const { user } = edit({ origin: { source: "suggestion", suggestedBy: "Ada Example" } });
    await save(user);
    expect(saved()).not.toHaveProperty("origin");
  });
});

describe("TaskEditor: where the card came from", () => {
  const STANDUP = { source: "standup", meetingDate: "2026-10-13", meetingId: "m1" } as const;
  const WORDS =
    "Added from the standup of Oct 13. Nobody typed it in: change what is wrong, or delete it.";

  test("a card from the standup says which standup added it", () => {
    edit({ origin: STANDUP });
    expect(screen.getByText(WORDS)).toBeTruthy();
    expect(screen.getByText("Standup · Oct 13").getAttribute("data-slot")).toBe("kind-tag");
  });

  test("a card added from Telegram says who added it there", () => {
    edit({ origin: { source: "telegram", by: "Cora Founder" } });
    expect(screen.getByText("Added from Telegram by Cora Founder.")).toBeTruthy();
    expect(screen.getByText("Telegram").getAttribute("data-slot")).toBe("kind-tag");
    // Somebody did type it: the standup's sentence is not said of it.
    expect(screen.queryByText(/Nobody typed it in/)).toBeNull();
  });

  test("a card added from Telegram by someone the viewer is not told of", () => {
    edit({ origin: { source: "telegram", by: null } });
    expect(screen.getByText("Added from Telegram.")).toBeTruthy();
  });

  test("a card somebody typed in says nothing of the kind", () => {
    edit();
    expect(screen.queryByText(/standup/i)).toBeNull();
    expect(screen.queryByText(/Telegram/)).toBeNull();
  });

  test("where it came from is not the editor's to change: saving sends no origin", async () => {
    const { user } = edit({ origin: STANDUP });
    await save(user);
    expect(saved()).toMatchObject({ id: "t1", title: "Send the deck" });
    expect(saved()).not.toHaveProperty("origin");
  });
});

describe("TaskEditor: a new card", () => {
  const start = (viewer?: ViewerProfile, defaults?: { assignToMe?: boolean }) => {
    const onClose = vi.fn();
    const editor = (
      <TaskEditor task={null} quarter={null} onClose={onClose} assignToMe={defaults?.assignToMe} />
    );
    render(viewer ? <ViewerProvider viewer={viewer}>{editor}</ViewerProvider> : editor);
    return { onClose, user: userEvent.setup() };
  };

  test("starts empty, and saving adds the card at the top of its column with every field", async () => {
    const { onClose, user } = start();
    expect(screen.getByRole("heading", { name: "New card" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    await user.type(screen.getByLabelText("Title"), "Book the venue");
    await user.type(screen.getByLabelText("Description"), "Two rooms");
    await user.selectOptions(screen.getByLabelText("Column"), "This week");
    await user.selectOptions(screen.getByLabelText("Type"), "issue");
    await user.selectOptions(assignee(), "Ada Example");
    await user.selectOptions(company(), "Startup");
    await user.type(screen.getByLabelText("Due"), "2026-10-20");
    await save(user);
    expect(convex.mutation(api.tasks.create)).toHaveBeenCalledWith({
      title: "Book the venue",
      notes: "Two rooms",
      column: "this_week",
      kind: "issue",
      assignee: "ada@example.com",
      company: "us",
      due: "2026-10-20",
      index: 0,
      duplicates: "warn",
    });
    expect(convex.mutation(api.tasks.update)).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  test("a viewer on one company makes a card of that company, assigned to them when asked", async () => {
    const { user } = start(member(["kz"]), { assignToMe: true });
    expect(assignee().value).toBe("sam@example.com");
    expect(screen.queryByLabelText("Company")).toBeNull();
    await user.type(screen.getByLabelText("Title"), "Fix the build");
    await save(user);
    expect(convex.mutation(api.tasks.create)).toHaveBeenCalledWith(
      expect.objectContaining({ company: "kz", assignee: "sam@example.com", column: "backlog" }),
    );
  });

  test("a card near an open one is warned of, and added only on Add anyway", async () => {
    convex.mutation(api.tasks.create).mockRejectedValueOnce(
      new ConvexError({
        words: "This may repeat a card already open on the board.",
        refusal: { code: "possible_duplicate", matches: [{ id: "t1", title: "Book a venue" }] },
      }),
    );
    const { onClose, user } = start();
    await user.type(screen.getByLabelText("Title"), "Book the venue");
    await save(user);
    expect((await screen.findByRole("alert")).textContent).toContain("Possible duplicate of “Book a venue”");
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Add anyway" }));
    expect(convex.mutation(api.tasks.create)).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Book the venue", duplicates: "confirmed" }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  test("a refused card keeps the form open with the server's sentence", async () => {
    convex
      .mutation(api.tasks.create)
      .mockRejectedValue(new ConvexError("That person cannot be given this task."));
    const { onClose, user } = start();
    await user.type(screen.getByLabelText("Title"), "Book the venue");
    await save(user);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That person cannot be given this task.",
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
