// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { BoardCard, Quietness } from "@/lib/pipeline/derive";
import { PipelineCardView } from "./pipeline-card";

afterEach(cleanup);

const card = (extra: Partial<BoardCard> = {}): BoardCard => ({
  id: "d1",
  name: "Austin Vertical",
  stage: "demo",
  amount: null,
  lastActivityAt: 0,
  closedAt: null,
  nextStep: null,
  mirrored: false,
  source: "manual",
  contact: null,
  sourceStage: null,
  notes: null,
  ...extra,
});

function show(
  extra: Partial<BoardCard> = {},
  quiet: Quietness | null = { kind: "active", days: 2 },
  props: { currency?: string; amountSuffix?: string } = {},
) {
  const onOpen = vi.fn();
  render(
    <PipelineCardView
      card={card(extra)}
      quiet={quiet}
      currency={props.currency ?? "USD"}
      amountSuffix={props.amountSuffix}
      onOpen={onOpen}
    />,
  );
  return onOpen;
}

describe("PipelineCardView", () => {
  test("the name opens the card", async () => {
    const onOpen = show();
    await userEvent.setup().click(screen.getByRole("button", { name: "Austin Vertical" }));
    expect(onOpen).toHaveBeenCalledWith("d1");
  });

  test("shows the contact, the next step and the amount", () => {
    show({ contact: "Dana Lee", nextStep: "Send pricing", amount: 450 }, undefined, {
      amountSuffix: "/mo",
    });
    expect(screen.getByText("Dana Lee")).toBeTruthy();
    expect(screen.getByText("Send pricing")).toBeTruthy();
    expect(screen.getByText("$450/mo")).toBeTruthy();
  });

  test("a Kazakhstan amount is in tenge", () => {
    show({ amount: 250_000 }, undefined, { currency: "KZT", amountSuffix: "/mo" });
    expect(screen.getByText("₸250K/mo")).toBeTruthy();
  });

  test("a card with no amount shows none, not a zero", () => {
    show();
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  test("a card in play with nothing planned says so; a closed one does not", () => {
    show({ nextStep: "  " });
    expect(screen.getByText("No next step")).toBeTruthy();
    cleanup();
    show({ stage: "won" }, null);
    expect(screen.queryByText("No next step")).toBeNull();
  });

  test("a quiet card says for how long; an active one says nothing", () => {
    show({}, { kind: "quiet", days: 19 });
    expect(screen.getByText("Quiet 19 days")).toBeTruthy();
    cleanup();
    show({}, { kind: "active", days: 3 });
    expect(screen.queryByText(/Quiet/)).toBeNull();
  });

  test("a card with no activity date says that, rather than looking active", () => {
    show({ lastActivityAt: null }, { kind: "undated" });
    expect(screen.getByText("No activity date")).toBeTruthy();
  });

  test("a mirrored card does not repeat what its whole board says", () => {
    // Where it comes from, and that its source gives no dates, are the board's
    // to say once; its next step is the owner's note, counted on the scorecard.
    show({ mirrored: true, source: "kz_crm", lastActivityAt: null }, { kind: "undated" });
    expect(screen.queryByText("No activity date")).toBeNull();
    expect(screen.queryByText("No next step")).toBeNull();
    expect(screen.queryByText("CRM")).toBeNull();
  });

  test("an unsorted card shows the stage as its source names it", () => {
    show({ stage: "unmapped", sourceStage: "Ждём бюджет", mirrored: true }, null);
    // In full: a clipped label would hide the one thing the card is there to say.
    expect(screen.getByText("Ждём бюджет")).toBeTruthy();
    expect(screen.getByText("Stage there:")).toBeTruthy();
  });
});
