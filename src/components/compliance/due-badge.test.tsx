// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OBLIGATION_STATUSES } from "@convex/lib/obligationShape";
import type { DueState } from "@/lib/compliance/due";
import { DueBadge, ProgressChip } from "./due-badge";

afterEach(cleanup);

const TONES: Record<DueState, string> = {
  overdue: "danger",
  due_soon: "warning",
  upcoming: "neutral",
  unconfirmed: "neutral",
  no_date: "neutral",
  done: "neutral",
  not_applicable: "neutral",
};

describe("DueBadge", () => {
  it.each(Object.entries(TONES))("%s is a %s chip, with its words and an icon", (state, tone) => {
    render(<DueBadge state={state as DueState} text={`Words for ${state}`} />);
    const chip = screen.getByText(`Words for ${state}`);
    expect(chip.dataset.due).toBe(state);
    expect(chip.dataset.tone).toBe(tone);
    expect(chip.querySelector("svg")).not.toBeNull();
  });

  it("colours a confirmed date only: an unconfirmed one is never a warning or an alarm", () => {
    render(<DueBadge state="unconfirmed" text="Unconfirmed" />);
    const chip = screen.getByText("Unconfirmed");
    expect(chip.className).not.toMatch(/danger|warning|success/);
  });

  it("is never green, whatever the state: nothing here is an all-clear", () => {
    for (const state of Object.keys(TONES) as DueState[]) {
      const { container } = render(<DueBadge state={state} text="x" />);
      expect(container.innerHTML).not.toMatch(/success|text-good/);
    }
    for (const status of OBLIGATION_STATUSES) {
      const { container } = render(<ProgressChip status={status} />);
      expect(container.innerHTML).not.toMatch(/success|text-good/);
    }
  });
});

describe("ProgressChip", () => {
  it("is outlined, so the due chip beside it is read first", () => {
    render(<ProgressChip status="in_progress" />);
    const chip = screen.getByText("In progress");
    expect(chip.dataset.variant).toBe("outline");
    expect(chip.dataset.tone).toBe("info");
  });

  it("says a finished item with a plain tick in the neutral tone", () => {
    render(<ProgressChip status="done" />);
    expect(screen.getByText("Done").dataset.tone).toBe("neutral");
  });
});
