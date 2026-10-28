// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { CLOSED_SHOWN } from "@convex/lib/limits";
import type { BoardCard } from "@/lib/pipeline/derive";
import { DEAL_COLUMNS, OPEN_DEAL_STAGES } from "@/lib/pipeline/stages";
import { PipelineBoard } from "./pipeline-board";

afterEach(cleanup);
beforeAll(() => {
  // jsdom has no CSS.escape, which the board uses to find a moved card's grip.
  window.CSS ??= { escape: (value: string) => value } as typeof CSS;
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 12, 12);

let next = 0;
const card = (name: string, stage: string, extra: Partial<BoardCard> = {}): BoardCard => ({
  id: `c${next++}`,
  name,
  stage,
  amount: null,
  lastActivityAt: NOW,
  closedAt: null,
  nextStep: "Call",
  mirrored: false,
  source: "manual",
  contact: null,
  sourceStage: null,
  notes: null,
  ...extra,
});
const mirroredCard = (name: string, stage: string, extra: Partial<BoardCard> = {}) =>
  card(name, stage, { mirrored: true, source: "kz_crm", ...extra });

const WORDS = {
  noun: "deal",
  title: "Deal",
  nameLabel: "Company",
  blankName: "A deal needs a company name.",
  amountLabel: "Monthly fee (USD)",
};

function setup(cards: BoardCard[], options: { add?: boolean } = {}) {
  const board: Record<string, BoardCard[]> = Object.fromEntries(
    [...DEAL_COLUMNS.map((c) => c.id), "unmapped"].map((id) => [id, []]),
  );
  for (const c of cards) board[c.stage]!.push(c);
  const handlers = {
    onMove: vi.fn(async () => null as unknown),
    onCreate: vi.fn(async () => null as unknown),
    onSave: vi.fn(async () => null as unknown),
    onDelete: vi.fn(async () => null as unknown),
  };
  render(
    <PipelineBoard
      board={board}
      columns={DEAL_COLUMNS}
      judgedStages={OPEN_DEAL_STAGES}
      limitDays={14}
      now={NOW}
      currency="USD"
      amountSuffix="/mo"
      mirror={{ short: "CRM", named: "the Kazakhstan CRM" }}
      words={WORDS}
      add={
        options.add === false
          ? null
          : { label: "Add a deal", placeholder: "Clinic or company", stages: OPEN_DEAL_STAGES }
      }
      {...handlers}
    />,
  );
  return { ...handlers, user: userEvent.setup() };
}

const column = (title: string) =>
  within(screen.getByRole("heading", { name: new RegExp(`^${title}`) }).closest("section")!);

describe("PipelineBoard", () => {
  test("a card made here can be moved; a mirrored one has no grip at all", async () => {
    const { onMove, user } = setup([card("Native", "lead"), mirroredCard("Mirrored Co", "lead")]);
    expect(screen.queryByRole("button", { name: "Move Mirrored Co" })).toBeNull();
    screen.getByRole("button", { name: "Move Native" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(onMove).toHaveBeenCalledWith(expect.any(String), "qualified", 0);
  });

  test("a move the server refuses shows the server's reason", async () => {
    const { onMove, user } = setup([card("Native", "lead")]);
    onMove.mockRejectedValue(new ConvexError("That deal is no longer on the board."));
    screen.getByRole("button", { name: "Move Native" }).focus();
    await user.keyboard("{ArrowRight}");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That deal is no longer on the board.",
    );
  });

  test("new cards can be added under open stages only", () => {
    setup([]);
    for (const title of ["Lead", "Qualified", "Demo", "Proposal"]) {
      expect(column(title).getByRole("button", { name: "Add a deal" }), title).toBeTruthy();
    }
    for (const title of ["Won", "Lost"]) {
      expect(column(title).queryByRole("button", { name: "Add a deal" }), title).toBeNull();
    }
  });

  test("adding a card names the stage it was added under", async () => {
    const { onCreate, user } = setup([]);
    await user.click(column("Demo").getByRole("button", { name: "Add a deal" }));
    await user.type(screen.getByLabelText("New deal in Demo"), "Austin Vertical{Enter}");
    expect(onCreate).toHaveBeenCalledWith("demo", "Austin Vertical");
  });

  test("a board with no add control offers none", () => {
    setup([mirroredCard("Mirrored Co", "lead")], { add: false });
    expect(screen.queryByRole("button", { name: "Add a deal" })).toBeNull();
  });

  test("Unsorted appears only while it holds a card", () => {
    setup([card("Native", "lead")]);
    expect(screen.queryByRole("heading", { name: /^Unsorted/ })).toBeNull();
    cleanup();
    setup([mirroredCard("Odd one", "unmapped", { sourceStage: "Ждём бюджет" })]);
    expect(column("Unsorted").getByText("Odd one")).toBeTruthy();
    expect(column("Unsorted").getByText("Ждём бюджет")).toBeTruthy();
  });

  test("a quiet open card is marked; a closed one never is", () => {
    setup([
      card("Quiet Co", "demo", { lastActivityAt: NOW - 20 * DAY }),
      card("Old Win", "won", { lastActivityAt: NOW - 90 * DAY, closedAt: NOW - 90 * DAY }),
    ]);
    expect(column("Demo").getByText("Quiet 20 days")).toBeTruthy();
    expect(column("Won").queryByText(/Quiet/)).toBeNull();
  });

  test("a closed column shows its latest cards and says there are more", () => {
    const won = Array.from({ length: CLOSED_SHOWN + 2 }, (_, i) =>
      card(`Won ${i}`, "won", { closedAt: NOW - i * DAY }),
    );
    setup(won);
    const wonColumn = column("Won");
    expect(wonColumn.getByText("Won 0")).toBeTruthy();
    expect(wonColumn.queryByText(`Won ${CLOSED_SHOWN}`)).toBeNull();
    expect(
      wonColumn.getByText(`Showing the latest ${CLOSED_SHOWN}. Older ones still count above.`),
    ).toBeTruthy();
  });

  test("opening a card edits that card, and a save names it", async () => {
    const native = card("Native", "lead");
    const { onSave, user } = setup([native, card("Other", "lead")]);
    await user.click(screen.getByRole("button", { name: "Native" }));
    await user.type(screen.getByLabelText("Notes"), "Good call");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(native.id, { notes: "Good call" });
  });

  test("deleting from the editor asks first and names the card", async () => {
    const native = card("Native", "lead");
    const { onDelete, user } = setup([native]);
    await user.click(screen.getByRole("button", { name: "Native" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith(native.id);
  });

  test("a long mirrored column opens on its first cards, counts them all, and opens in full", async () => {
    const many = Array.from({ length: 11 }, (_, n) => mirroredCard(`Clinic ${n + 1}`, "lead"));
    const { user } = setup(many, { add: false });
    const lead = column("Lead");
    expect(lead.getAllByRole("listitem")).toHaveLength(8);
    // The heading counts every card, shown or not.
    expect(lead.getByRole("heading").textContent).toContain("11");
    await user.click(lead.getByRole("button", { name: "Show all 11" }));
    expect(lead.getAllByRole("listitem")).toHaveLength(11);
    await user.click(lead.getByRole("button", { name: "Show the first 8" }));
    expect(lead.getAllByRole("listitem")).toHaveLength(8);
  });

  test("a column the owner keeps is never cut short: a hidden card could not be dropped on", () => {
    setup(Array.from({ length: 11 }, (_, n) => card(`Clinic ${n + 1}`, "lead")));
    expect(column("Lead").getAllByRole("listitem")).toHaveLength(11);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });
});
