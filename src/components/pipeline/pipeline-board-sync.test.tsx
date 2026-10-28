// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { BoardCard } from "@/lib/pipeline/derive";
import { ACTIVE_INVESTOR_STAGES, INVESTOR_COLUMNS } from "@/lib/pipeline/stages";
import { PipelineBoard } from "./pipeline-board";

// The board as the fundraising page uses it: a mirrored card the page says
// may be dragged and edited (a Visible investor), something under each card,
// and Archive in the editor.

afterEach(cleanup);
beforeAll(() => {
  window.CSS ??= { escape: (value: string) => value } as typeof CSS;
});

const NOW = Date.UTC(2026, 9, 12, 12);
let next = 0;
const card = (name: string, stage: string, extra: Partial<BoardCard> = {}): BoardCard => ({
  id: `i${next++}`,
  name,
  stage,
  amount: null,
  lastActivityAt: NOW,
  closedAt: null,
  nextStep: null,
  mirrored: true,
  source: "visible",
  contact: null,
  sourceStage: null,
  notes: null,
  ...extra,
});

const WORDS = {
  noun: "investor",
  title: "Investor",
  nameLabel: "Investor or firm",
  blankName: "An investor needs a name.",
  amountLabel: "Cheque (USD)",
};

function setup(cards: BoardCard[], locked: ReadonlySet<string> = new Set()) {
  const board: Record<string, BoardCard[]> = Object.fromEntries(
    [...INVESTOR_COLUMNS.map((c) => c.id), "unmapped"].map((id) => [id, []]),
  );
  for (const c of cards) board[c.stage]!.push(c);
  const handlers = {
    onMove: vi.fn(async () => null as unknown),
    onCreate: vi.fn(async () => null as unknown),
    onSave: vi.fn(async () => null as unknown),
    onDelete: vi.fn(async () => null as unknown),
    onArchive: vi.fn(async (_id: string) => null as unknown),
  };
  render(
    <PipelineBoard
      board={board}
      columns={INVESTOR_COLUMNS}
      judgedStages={ACTIVE_INVESTOR_STAGES}
      limitDays={14}
      now={NOW}
      currency="USD"
      mirror={{ short: "Visible", named: "Visible" }}
      words={WORDS}
      add={null}
      canDrag={(c) => !locked.has(c.id)}
      editableOf={(c) => !locked.has(c.id)}
      editorNote="From Visible."
      cardFooter={(c) => <span>{`Footer of ${c.name}`}</span>}
      {...handlers}
    />,
  );
  return { ...handlers, user: userEvent.setup() };
}

const column = (title: string) =>
  within(screen.getByRole("heading", { name: new RegExp(`^${title}`) }).closest("section")!);

describe("PipelineBoard: what the page says may move", () => {
  test("a mirrored card the page lets go can be moved; one it holds cannot", async () => {
    const free = card("Example Ventures", "contacted");
    const held = card("Sample Capital", "contacted");
    const { onMove, user } = setup([free, held], new Set([held.id]));
    expect(screen.queryByRole("button", { name: "Move Sample Capital" })).toBeNull();
    screen.getByRole("button", { name: "Move Example Ventures" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(onMove).toHaveBeenCalledWith(free.id, "meeting", 0);
  });

  test("each card carries what the page puts under it", () => {
    setup([card("Example Ventures", "meeting")]);
    expect(column("Meeting").getByText("Footer of Example Ventures")).toBeTruthy();
  });

  test("a long column of cards that can move is never cut short", () => {
    setup(Array.from({ length: 11 }, (_, n) => card(`Fund ${n + 1}`, "contacted")));
    expect(column("Contacted").getAllByRole("listitem")).toHaveLength(11);
  });

  test("the editor offers the fields the page allows, its note, and Archive", async () => {
    const free = card("Example Ventures", "meeting");
    const { onArchive, user } = setup([free]);
    await user.click(screen.getByRole("button", { name: "Example Ventures" }));
    expect(screen.getByLabelText("Investor or firm")).toBeTruthy();
    expect(screen.getByText("From Visible.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await user.click(screen.getByRole("button", { name: "Archive it" }));
    expect(onArchive).toHaveBeenCalledWith(free.id);
  });
});
