// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { ViewerProvider, type ViewerProfile } from "@/components/viewer-provider";
import { TaskCard, type Task } from "./task-card";

afterEach(cleanup);

// Every name and address here is made up.
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

const STANDUP = { source: "standup", meetingDate: "2026-10-13", meetingId: "m1" } as const;

const member = (companies: ViewerProfile["companies"]): ViewerProfile => ({
  role: "engineer",
  companies,
  areas: ["product", "board"],
  email: "sam@example.com",
  name: null,
});

const show = (over: Partial<Task>, viewer?: ViewerProfile) => {
  const card = <TaskCard task={task(over)} today="2026-10-12" onOpen={() => {}} />;
  return render(viewer ? <ViewerProvider viewer={viewer}>{card}</ViewerProvider> : card);
};

describe("where a card came from", () => {
  test("a card from the standup says so, with the day, in a kind tag", () => {
    show({ origin: STANDUP });
    const tag = screen.getByText("Standup · Oct 13");
    expect(tag.getAttribute("data-slot")).toBe("kind-tag");
    expect(tag.getAttribute("title")).toBe("Added from the standup of Oct 13");
  });

  test("it shows even when the card has nothing else to say", () => {
    const { container } = show({ origin: STANDUP });
    expect(container.querySelectorAll("[data-slot='kind-tag']")).toHaveLength(1);
  });

  test("a card added from Telegram says so, and by whom, in a kind tag", () => {
    show({ origin: { source: "telegram", by: "Cora Founder" } });
    const tag = screen.getByText("Telegram");
    expect(tag.getAttribute("data-slot")).toBe("kind-tag");
    expect(tag.getAttribute("title")).toBe("Added from Telegram by Cora Founder");
  });

  test("with nobody the viewer may be told of, it says only where it came from", () => {
    show({ origin: { source: "telegram", by: null } });
    expect(screen.getByText("Telegram").getAttribute("title")).toBe("Added from Telegram");
  });

  test("a card somebody typed in carries no such tag", () => {
    const { container } = show({ kind: "issue", due: "2026-10-20" });
    expect(screen.queryByText(/Standup/)).toBeNull();
    expect(container.querySelector("[data-slot='kind-tag']")).toBeNull();
  });
});

describe("a card someone sent with Suggest a change", () => {
  test("wears a Suggestion tag, a kind tag like the standup's, saying who sent it", () => {
    show({ origin: { source: "suggestion", suggestedBy: "Ada Example" } });
    const tag = screen.getByText("Feedback on Startup OS");
    expect(tag.getAttribute("data-slot")).toBe("kind-tag");
    expect(tag.getAttribute("title")).toBe("Suggested by Ada Example");
    expect(screen.queryByText(/Standup/)).toBeNull();
  });

  test("a suggester the viewer is not told about is a teammate, unnamed", () => {
    show({ origin: { source: "suggestion", suggestedBy: null } });
    expect(screen.getByText("Feedback on Startup OS").getAttribute("title")).toBe("Suggested by a teammate");
  });
});

describe("a card the owner's Claude made", () => {
  test("wears a Claude tag, a kind tag, saying whose Claude by first name", () => {
    show({ origin: { source: "agent", for: "Olga" } });
    const tag = screen.getByText("Claude");
    expect(tag.getAttribute("data-slot")).toBe("kind-tag");
    expect(tag.getAttribute("title")).toBe("Added by Claude (for Olga)");
  });

  test("with no name the viewer may be told, it is the owner's Claude", () => {
    show({ origin: { source: "agent", for: null } });
    expect(screen.getByText("Claude").getAttribute("title")).toBe("Added by the owner's Claude");
  });

  test("where the card says which agent, the title names it", () => {
    show({ origin: { source: "agent", for: "Olga", agent: "engineering" } });
    expect(screen.getByText("Claude").getAttribute("title")).toBe(
      "Added by Claude (for Olga) · Engineering manager",
    );
    cleanup();
    show({ origin: { source: "agent", for: null, agent: "finance" } });
    expect(screen.getByText("Claude").getAttribute("title")).toBe(
      "Added by the owner's Claude · Finance and compliance",
    );
  });

  test("where the card records a bot, the tag and the title name that bot", () => {
    show({ origin: { source: "agent", for: "Olga", agent: "chief_of_staff", bot: "growth" } });
    const tag = screen.getByText("growth");
    expect(tag.getAttribute("data-slot")).toBe("kind-tag");
    expect(tag.getAttribute("title")).toBe("Added by Claude (for Olga) · growth");
    expect(screen.queryByText("Claude")).toBeNull();
    cleanup();
    show({ origin: { source: "agent", for: null, bot: "globex_ai_sales" } });
    expect(screen.getByText("globex_ai_sales").getAttribute("title")).toBe(
      "Added by the owner's Claude · globex_ai_sales",
    );
  });
});

describe("the assignee on a card", () => {
  test("a teammate is shown by name, with their initials", () => {
    const { container } = show({
      assignee: { status: "teammate", email: "ada@example.com", name: "Ada Example" },
    });
    expect(screen.getByText("Ada Example")).toBeTruthy();
    expect(container.querySelector("[data-initials]")?.textContent).toBe("AE");
    expect(screen.getByText("Assigned to")).toBeTruthy();
  });

  test("a teammate with no known name is the part of the address before the @", () => {
    const { container } = show({
      assignee: { status: "teammate", email: "sam.field@example.com", name: null },
    });
    expect(screen.getByText("sam.field")).toBeTruthy();
    expect(container.textContent).not.toContain("@example.com");
  });

  test("someone since removed from the team", () => {
    const { container } = show({
      assignee: { status: "removed", email: "gone@example.com", name: null },
    });
    expect(screen.getByText("Removed teammate")).toBeTruthy();
    expect(container.textContent).not.toContain("gone@example.com");
    expect(container.querySelector("[data-initials]")).toBeNull();
  });

  test("someone on the other company is not named", () => {
    show({ assignee: { status: "elsewhere", email: null, name: null } });
    expect(screen.getByText("Someone on the other company")).toBeTruthy();
  });

  test("nothing when the task is unassigned", () => {
    const { container } = show({});
    expect(screen.queryByText("Assigned to")).toBeNull();
    expect(container.querySelector("[data-initials]")).toBeNull();
  });
});

describe("the company tag on a card", () => {
  test("a viewer with both companies sees which company a task is tied to", () => {
    show({ company: "kz" });
    expect(screen.getByText("Globex")).toBeTruthy();
  });

  test("a shared task carries no tag", () => {
    show({ company: null });
    expect(screen.queryByText("Startup")).toBeNull();
    expect(screen.queryByText("Globex")).toBeNull();
  });

  test("a viewer with one company sees no tag: every tied task is theirs", () => {
    show({ company: "us" }, member(["us"]));
    expect(screen.queryByText("Startup")).toBeNull();
  });
});
