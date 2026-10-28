// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { CHAT_FAILURES, CHAT_WORDS } from "@/lib/assistant/chat";
import { mockConvex } from "@/test-support/convex";
import { Chat, RunnerStatus } from "./chat";

const NOW = new Date(2026, 9, 14, 14, 30, 0).getTime();
const nav = vi.hoisted(() => ({ search: "", replace: vi.fn() }));

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
vi.mock("@/hooks/use-now", () => ({ useNow: () => new Date(2026, 9, 14, 14, 30, 0).getTime() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

// Every title, question and answer is made up.
const THREADS = [
  { id: "t2", title: "Made-up newer conversation", company: "us", createdAt: NOW - 1_000, updatedAt: NOW - 1_000 },
  { id: "t1", title: "Made-up older conversation", company: "kz", createdAt: NOW - 9_000, updatedAt: NOW - 9_000 },
];
const question = (text = "Made-up question?") => ({
  id: "m1",
  role: "user",
  text,
  status: "done",
  steps: [],
  failure: null,
  askedAt: NOW - 5_000,
  startedAt: null,
  finishedAt: null,
  proposals: [],
});
const answer = (fields: Record<string, unknown> = {}) => ({
  id: "m2",
  role: "assistant",
  text: "",
  status: "queued",
  steps: [],
  failure: null,
  askedAt: NOW - 5_000,
  startedAt: null,
  finishedAt: null,
  proposals: [],
  ...fields,
});
const CARD = {
  id: "p1",
  agent: "chief_of_staff",
  kind: "task_create",
  company: "us",
  reason: "Made-up reason.",
  createdAt: NOW - 2_000,
  payload: { title: "Made-up task" },
  about: { task: null, deal: null, assignee: null },
  source: "proposal",
  bot: null,
  why: "Made-up reason.",
  urgency: "normal",
  goal: null,
  status: "open",
  decidedAt: null,
  rejectCode: null,
  rejectReason: null,
  result: null,
  edited: false,
  edits: [],
  withdrawReason: null,
  withdrawNote: null,
  flagged: false,
};
/** The same proposal as the approvals inbox lists it (`assistant.inbox`): what the card under the answer renders. */
const WAITING = {
  ...CARD,
  source: "proposal",
  bot: "growth",
  urgency: "high",
  goal: { id: "g1", title: "Made-up goal", status: "on_track", cash: false },
  evidence: null,
  changes: [],
  effect: { changes: [{ field: "Title", before: null, after: "Made-up task" }], text: null },
  cash: false,
  duplicate: { of: [{ id: "t9", title: "Made-up older task" }], reason: null },
  tool: null,
  toolName: null,
  arguments: null,
};

let convex: ReturnType<typeof mockConvex>;
const conversation = (messages: unknown[], thread = "t2") =>
  convex.setQueryBy(api.chat.messages, (args) =>
    (args as { threadId: string }).threadId === thread
      ? { thread: { id: thread, title: "Made-up newer conversation", company: "us" }, messages }
      : null,
  );

beforeEach(() => {
  convex = mockConvex();
  nav.search = "";
  nav.replace.mockClear();
  convex.setQuery(api.chat.threads, THREADS);
  convex.setQuery(api.chat.runner, { checkedInAt: NOW - 5_000, everyMs: 3_000 });
  convex.setQuery(api.team.assignable, []);
  convex.setQuery(api.assistant.inbox, [WAITING]);
});
afterEach(cleanup);

const field = () => screen.getByLabelText("Your question") as HTMLTextAreaElement;

describe("whether the Mac is answering (said in the page's header)", () => {
  test("says Claude on your Mac answers when it checked in lately", () => {
    render(<RunnerStatus />);
    const status = screen.getByTestId("runner-status");
    expect(status.textContent).toBe("Answered by Claude on your Mac.");
    expect(status.dataset.there).toBe("true");
  });

  test("says since when it has not, how to start it, and opens how this works", async () => {
    convex.setQuery(api.chat.runner, { checkedInAt: new Date(2026, 9, 14, 14, 2, 0).getTime(), everyMs: 3_000 });
    // "see how" opens the chat's own "How this works", on the same page.
    render(
      <>
        <RunnerStatus />
        <Chat />
      </>,
    );
    const status = screen.getByTestId("runner-status");
    expect(status.textContent).toBe(
      "Your Mac has not checked in since 14:02. Questions wait until it does. Start it with pnpm assistant:runner (see how).",
    );
    expect(status.dataset.there).toBe("false");
    const how = screen.getByText("How this works").closest("details")!;
    expect(how.open).toBe(false);
    await userEvent.click(within(status).getByRole("link", { name: "see how" }));
    expect(how.open).toBe(true);
    expect(how.textContent).toMatch(/Claude subscription your Mac is signed in to/);
    expect(how.textContent).toMatch(/Never payroll, tokens, mail or calendar/);
  });

  test("a Mac that never checked in is said so", () => {
    convex.setQuery(api.chat.runner, { checkedInAt: null, everyMs: null });
    render(<RunnerStatus />);
    expect(screen.getByTestId("runner-status").textContent).toMatch(/^Your Mac has never checked in\./);
  });
});

describe("conversations", () => {
  test("on a narrow screen they are a list to open, which closes on choosing one", async () => {
    render(<Chat />);
    const toggle = screen.getByRole("button", { name: /^Conversations/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const list = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(list.className).toMatch(/(^| )hidden( |$)/);
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(list.className).not.toMatch(/(^| )hidden( |$)/);
    await userEvent.click(within(screen.getByTestId("threads")).getAllByRole("button")[0]!);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  test("are listed newest first, and choosing one puts it in the address", async () => {
    render(<Chat />);
    const list = within(screen.getByTestId("threads"));
    expect(list.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Made-up newer conversation",
      "Made-up older conversation",
    ]);
    await userEvent.click(list.getByRole("button", { name: "Made-up older conversation" }));
    expect(nav.replace).toHaveBeenCalledWith("/assistant?thread=t1", { scroll: false });
  });

  test("with none open it invites a question, and asks for no conversation", () => {
    render(<Chat />);
    expect(screen.getByTestId("chat-empty").textContent).toMatch(/Ask about the company in view/);
    expect(screen.queryByTestId("conversation")).toBeNull();
  });

  test("an id in the address that is not one of the owner's conversations is never asked for", () => {
    nav.search = "thread=not-a-thread";
    const asked = vi.fn(() => null);
    convex.setQueryBy(api.chat.messages, asked);
    render(<Chat />);
    expect(asked).not.toHaveBeenCalled();
    expect(screen.getByTestId("chat-empty")).toBeTruthy();
  });

  test("the open one can be renamed", async () => {
    nav.search = "thread=t2";
    conversation([]);
    render(<Chat />);
    await userEvent.click(screen.getByRole("button", { name: "Rename this conversation" }));
    const name = screen.getByLabelText("Name of this conversation") as HTMLInputElement;
    expect(name.value).toBe("Made-up newer conversation");
    await userEvent.clear(name);
    await userEvent.type(name, "Made-up new name");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(convex.mutation(api.chat.rename)).toHaveBeenCalledWith({ threadId: "t2", title: "Made-up new name" });
  });

  test("deleting asks first, and only the second click deletes", async () => {
    nav.search = "thread=t2";
    conversation([]);
    render(<Chat />);
    await userEvent.click(screen.getByRole("button", { name: "Delete this conversation" }));
    expect(convex.mutation(api.chat.remove)).not.toHaveBeenCalled();
    const confirm = screen.getByRole("group", { name: "Delete this conversation?" });
    await userEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(convex.mutation(api.chat.remove)).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Delete this conversation" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete it" }));
    expect(convex.mutation(api.chat.remove)).toHaveBeenCalledWith({ threadId: "t2" });
    expect(nav.replace).toHaveBeenCalledWith("/assistant", { scroll: false });
  });

  test("a refusal to rename is shown in the server's own words", async () => {
    nav.search = "thread=t2";
    conversation([]);
    const { ConvexError } = await import("convex/values");
    convex.mutation(api.chat.rename).mockRejectedValueOnce(new ConvexError(CHAT_WORDS.noTitle));
    render(<Chat />);
    await userEvent.click(screen.getByRole("button", { name: "Rename this conversation" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe(CHAT_WORDS.noTitle);
  });
});

describe("the composer", () => {
  test("Enter sends the question as a new conversation and opens it; the field empties", async () => {
    convex.mutation(api.chat.send).mockResolvedValue({ threadId: "t9", messageId: "m9" });
    render(<Chat />);
    await userEvent.type(field(), "Made-up question?{Enter}");
    expect(convex.mutation(api.chat.send)).toHaveBeenCalledWith({ company: "us", text: "Made-up question?" });
    expect(field().value).toBe("");
    expect(nav.replace).toHaveBeenCalledWith("/assistant?thread=t9", { scroll: false });
  });

  test("Shift+Enter is a new line and sends nothing", async () => {
    render(<Chat />);
    await userEvent.type(field(), "Made-up line one{Shift>}{Enter}{/Shift}line two");
    expect(convex.mutation(api.chat.send)).not.toHaveBeenCalled();
    expect(field().value).toBe("Made-up line one\nline two");
  });

  test("in an open conversation the question goes to it, and the address stays", async () => {
    nav.search = "thread=t2";
    conversation([question(), answer({ status: "done", text: "Made-up answer." })]);
    convex.mutation(api.chat.send).mockResolvedValue({ threadId: "t2", messageId: "m9" });
    render(<Chat />);
    await userEvent.type(field(), "Made-up follow-up?");
    await userEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(convex.mutation(api.chat.send)).toHaveBeenCalledWith({ company: "us", text: "Made-up follow-up?", threadId: "t2" });
    expect(nav.replace).not.toHaveBeenCalled();
  });

  test("nothing typed is said so and not sent; a refusal gives the question back with the server's words", async () => {
    render(<Chat />);
    await userEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(screen.getByRole("alert").textContent).toBe(CHAT_WORDS.empty);
    expect(convex.mutation(api.chat.send)).not.toHaveBeenCalled();

    const { ConvexError } = await import("convex/values");
    convex.mutation(api.chat.send).mockRejectedValueOnce(new ConvexError(CHAT_WORDS.tooManyToday));
    await userEvent.type(field(), "Made-up question?{Enter}");
    expect((await screen.findByRole("alert")).textContent).toBe(CHAT_WORDS.tooManyToday);
    expect(field().value).toBe("Made-up question?");
  });

  test.each(["queued", "working"])("while an answer is %s the field is disabled and Stop takes Ask's place", async (status) => {
    nav.search = "thread=t2";
    conversation([question(), answer({ status })]);
    render(<Chat />);
    expect(field().disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Ask" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(convex.mutation(api.chat.stop)).toHaveBeenCalledWith({ messageId: "m2" });
  });
});

describe("the answer", () => {
  test("fills in as it is written, with what Claude read, and the composer comes back when it is done", () => {
    nav.search = "thread=t2";
    conversation([question(), answer()]);
    const view = render(<Chat />);
    const shown = () => screen.getByTestId("answer");
    expect(shown().textContent).toContain("Waiting for your Mac to pick this up.");

    conversation([question(), answer({ status: "working", text: "Made-up par", steps: ["tasks"] })]);
    view.rerender(<Chat />);
    expect(shown().textContent).toContain("Claude is answering.");
    expect(shown().textContent).toContain("Made-up par");
    expect(within(screen.getByTestId("steps")).getAllByRole("listitem").map((chip) => chip.textContent)).toEqual(["Read tasks"]);

    conversation([question(), answer({ status: "working", text: "Made-up partial answer", steps: ["tasks", "deals", "tasks"] })]);
    view.rerender(<Chat />);
    expect(shown().textContent).toContain("Made-up partial answer");
    expect(within(screen.getByTestId("steps")).getAllByRole("listitem").map((chip) => chip.textContent)).toEqual([
      "Read tasks ×2",
      "Read deals",
    ]);
    expect(field().disabled).toBe(true);

    conversation([question(), answer({ status: "done", text: "Made-up answer.\nSecond line.", steps: ["tasks", "deals", "tasks"] })]);
    view.rerender(<Chat />);
    expect(shown().textContent).not.toContain("Claude is answering.");
    expect(shown().querySelector("p")!.textContent).toBe("Made-up answer.\nSecond line.");
    expect(shown().querySelector("p")!.className).toContain("whitespace-pre-wrap");
    expect(field().disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Ask" })).toBeTruthy();
  });

  test("HTML and markdown in it are the characters they are; only the app's own pages become links", () => {
    nav.search = "thread=t2";
    const text =
      '<img src=x onerror="alert(1)"> <b>bold</b> **stars** [a link](https://evil.test) <a href="https://evil.test">x</a>\n# heading\nIt is on /sales, not /payroll.';
    conversation([question("<i>Made-up</i> question on /board?"), answer({ status: "done", text })]);
    render(<Chat />);
    const shown = screen.getByTestId("answer");
    expect(shown.querySelector("p")!.textContent).toBe(text);
    expect(shown.querySelector("img, b, h1, script")).toBeNull();
    const links = [...shown.querySelectorAll("a")];
    expect(links.map((link) => [link.getAttribute("href"), link.textContent])).toEqual([["/sales", "/sales"]]);
    // The owner's own question is text too.
    const asked = screen.getByTestId("question");
    expect(asked.querySelector("i")).toBeNull();
    expect(asked.textContent).toContain("<i>Made-up</i> question on /board?");
  });

  test("a failure is its fixed sentence, beside what had been written", () => {
    nav.search = "thread=t2";
    conversation([question(), answer({ status: "failed", text: "Made-up half", failure: CHAT_FAILURES.stopped })]);
    render(<Chat />);
    expect(screen.getByTestId("failure").textContent).toBe("Stopped.");
    expect(screen.getByTestId("answer").textContent).toContain("Made-up half");
    expect(field().disabled).toBe(false);
  });

  test("a proposal made in it is /approvals' own row under it, and Approve is the owner's own click", async () => {
    nav.search = "thread=t2";
    conversation([question(), answer({ status: "done", text: "I have put a card below for you to approve.", proposals: [CARD] })]);
    render(<Chat />);
    const card = within(screen.getByTestId("answer")).getByTestId("proposal");
    expect(within(card).getByTestId("proposal-sentence").textContent).toBe('Create a task: "Made-up task", in Backlog');
    // The inbox's row: who (the bot), urgency, goal, the duplicate badge and what changes.
    expect(card.textContent).toContain("Why: Made-up reason.");
    expect(card.textContent).toContain("Bot: growth");
    expect(within(card).getByTestId("urgency").textContent).toBe("High");
    expect(card.textContent).toContain("Goal: Made-up goal");
    expect(within(card).getByTestId("duplicate").textContent).toContain("Made-up older task");
    expect(within(card).getByLabelText("What changes").textContent).toContain("Made-up task");
    // The same actions: edit then approve, reject with a reason.
    expect(within(card).getByRole("button", { name: "Edit then approve" })).toBeTruthy();
    await userEvent.click(within(card).getByRole("button", { name: "Reject" }));
    const reject = within(card).getByRole("form", { name: "Reject" });
    expect((within(reject).getByRole("button", { name: "Reject" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(within(reject).getByRole("button", { name: "Cancel" }));
    expect(convex.mutation(api.assistant.approve)).not.toHaveBeenCalled();
    await userEvent.click(within(card).getByRole("button", { name: "Approve" }));
    expect(convex.mutation(api.assistant.approve)).toHaveBeenCalledWith({ id: "p1" });
  });

  test("once decided, the card says what became of it and offers nothing to click but where it led", () => {
    nav.search = "thread=t2";
    const decided = { ...CARD, status: "approved", decidedAt: NOW - 1_000, result: { taskId: "task1" } };
    convex.setQuery(api.assistant.inbox, []);
    conversation([question(), answer({ status: "done", text: "Made-up.", proposals: [decided] })]);
    render(<Chat />);
    const shown = within(screen.getByTestId("answer"));
    expect(shown.queryByTestId("proposal")).toBeNull();
    expect(shown.getByTestId("decided").textContent).toContain("Approved");
    expect(shown.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(shown.getByRole("link", { name: "Open the task on the board" }).getAttribute("href")).toBe("/board?task=task1");
  });
});
