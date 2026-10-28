// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { PipelineBoard, PipelineCard } from "@/lib/pipeline/derive";
import { FundraisingTiles } from "./fundraising-tiles";

afterEach(cleanup);

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 12, 12);
const ago = (days: number) => NOW - days * DAY;

let next = 0;
const investor = (stage: string, extra: Partial<PipelineCard> = {}): PipelineCard => ({
  id: `i${next++}`,
  name: "Fund",
  stage,
  amount: null,
  lastActivityAt: NOW,
  closedAt: null,
  nextStep: "Follow up",
  ...extra,
});
const boardOf = (investors: PipelineCard[]): PipelineBoard => {
  const board: Record<string, PipelineCard[]> = {};
  for (const i of investors) (board[i.stage] ??= []).push(i);
  return board;
};
const show = (investors: PipelineCard[]) =>
  render(<FundraisingTiles board={boardOf(investors)} now={NOW} />);
const tile = (label: string) =>
  within(screen.getByRole("heading", { name: label }).closest("article")!);

describe("In conversation", () => {
  test("counts contacted, meeting and diligence, and says how many are still to contact", () => {
    show([investor("target"), investor("target"), investor("contacted"), investor("meeting"), investor("diligence"), investor("passed")]);
    const active = tile("In conversation");
    expect(active.getByText("3")).toBeTruthy();
    expect(active.getByText("Contacted, meeting or diligence.")).toBeTruthy();
    expect(active.getByText("2 more still to contact.")).toBeTruthy();
  });

  test("nobody yet", () => {
    show([]);
    const active = tile("In conversation");
    expect(active.getByText("None")).toBeTruthy();
    expect(active.queryByText(/still to contact/)).toBeNull();
  });

  test("investors in a stage the OS does not know are said to be left out", () => {
    show([investor("meeting"), investor("unmapped")]);
    expect(
      tile("In conversation").getByText(
        "1 investor is in a stage the OS does not know and is left out.",
      ),
    ).toBeTruthy();
    cleanup();
    show([investor("unmapped"), investor("unmapped")]);
    expect(
      tile("In conversation").getByText(
        "2 investors are in a stage the OS does not know and are left out.",
      ),
    ).toBeTruthy();
  });
});

describe("Committed", () => {
  test("nothing committed is said in words, not $0", () => {
    show([investor("meeting")]);
    const committed = tile("Committed");
    expect(committed.getByText("Nothing yet")).toBeTruthy();
    expect(committed.getByText("No investor is in Committed.")).toBeTruthy();
    expect(committed.queryByText("$0")).toBeNull();
  });

  test("the sum of the cheques", () => {
    show([investor("committed", { amount: 250_000 }), investor("committed", { amount: 100_000 })]);
    const committed = tile("Committed");
    expect(committed.getByText("$350K")).toBeTruthy();
    expect(committed.getByText("Across 2 commitments.")).toBeTruthy();
    expect(committed.queryByText("partial")).toBeNull();
  });

  test("one commitment reads in the singular", () => {
    show([investor("committed", { amount: 250_000 })]);
    expect(tile("Committed").getByText("Across 1 commitment.")).toBeTruthy();
  });

  test("a commitment with no amount makes it partial", () => {
    show([investor("committed", { amount: 250_000 }), investor("committed")]);
    const committed = tile("Committed");
    expect(committed.getByText("$250K")).toBeTruthy();
    expect(committed.getByText("partial")).toBeTruthy();
    expect(committed.getByText("Across 1 of 2 commitments.")).toBeTruthy();
    expect(committed.getByText("1 commitment has no amount and is left out.")).toBeTruthy();
  });

  test("commitments with no amount at all give no value", () => {
    show([investor("committed"), investor("committed")]);
    const committed = tile("Committed");
    expect(committed.getByText("No value yet")).toBeTruthy();
    expect(committed.getByText("None of the 2 commitments has an amount yet.")).toBeTruthy();
    cleanup();
    show([investor("committed")]);
    expect(tile("Committed").getByText("The one commitment has no amount yet.")).toBeTruthy();
  });
});

describe("Gone quiet", () => {
  test("nobody in conversation", () => {
    show([investor("target", { lastActivityAt: ago(90) })]);
    const quiet = tile("Gone quiet");
    expect(quiet.getByText("None")).toBeTruthy();
    expect(quiet.getByText("Nobody is in conversation.")).toBeTruthy();
  });

  test("none quiet", () => {
    show([investor("meeting", { lastActivityAt: ago(3) })]);
    expect(
      tile("Gone quiet").getByText(
        "Every investor in conversation had activity in the last 14 days.",
      ),
    ).toBeTruthy();
  });

  test("how many, and the longest silence", () => {
    show([investor("meeting", { lastActivityAt: ago(22) }), investor("contacted", { lastActivityAt: ago(16) })]);
    const quiet = tile("Gone quiet");
    expect(quiet.getByText("2")).toBeTruthy();
    expect(quiet.getByText("No activity for more than 14 days. Longest: 22 days.")).toBeTruthy();
  });

  test("with no activity dates from Visible there is no number", () => {
    show([investor("meeting", { lastActivityAt: null }), investor("contacted", { lastActivityAt: null })]);
    const quiet = tile("Gone quiet");
    expect(quiet.getByText("No value yet")).toBeTruthy();
    expect(
      quiet.getByText(
        "None of the 2 investors in conversation has an activity date, so none can be judged.",
      ),
    ).toBeTruthy();
  });
});

describe("No next step", () => {
  test("nobody in conversation", () => {
    show([investor("target", { nextStep: null })]);
    const idle = tile("No next step");
    expect(idle.getByText("None")).toBeTruthy();
    expect(idle.getByText("Nobody is in conversation.")).toBeTruthy();
  });

  test("everyone has one", () => {
    show([investor("meeting")]);
    expect(
      tile("No next step").getByText("Every investor in conversation has a next step."),
    ).toBeTruthy();
  });

  test("how many have nothing planned", () => {
    show([investor("meeting", { nextStep: null }), investor("contacted", { nextStep: "  " }), investor("diligence")]);
    const idle = tile("No next step");
    expect(idle.getByText("2")).toBeTruthy();
    expect(idle.getByText("In conversation with nothing planned.")).toBeTruthy();
  });
});
