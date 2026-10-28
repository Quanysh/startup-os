// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { BoardCard } from "@/lib/pipeline/derive";
import { DEAL_COLUMNS } from "@/lib/pipeline/stages";
import { CardEditor, type EditorWords } from "./card-editor";

afterEach(cleanup);

const WORDS: EditorWords = {
  noun: "deal",
  title: "Deal",
  nameLabel: "Company",
  blankName: "A deal needs a company name.",
  amountLabel: "Monthly fee (USD)",
};

const native: BoardCard = {
  id: "d1",
  name: "Austin Vertical",
  stage: "demo",
  amount: 450,
  lastActivityAt: 0,
  closedAt: null,
  nextStep: "Send pricing",
  mirrored: false,
  source: "manual",
  contact: "Dana Lee",
  sourceStage: null,
  notes: null,
};
const mirrored: BoardCard = {
  ...native,
  id: "d2",
  name: "Almaty Dental",
  mirrored: true,
  source: "kz_crm",
  stage: "qualified",
  sourceStage: "Переговоры",
  amount: 250_000,
  nextStep: null,
};

function setup(card: BoardCard, currency = "USD") {
  const onSave = vi.fn(async (_edit: unknown) => null as unknown);
  const onDelete = vi.fn(async () => null as unknown);
  const onClose = vi.fn();
  const element = (live: BoardCard | null) => (
    <CardEditor
      card={live}
      words={WORDS}
      columns={DEAL_COLUMNS}
      currency={currency}
      mirrorNamed={card.mirrored ? "the Kazakhstan CRM" : null}
      onSave={onSave}
      onDelete={onDelete}
      onClose={onClose}
    />
  );
  const view = render(element(card));
  return {
    onSave,
    onDelete,
    onClose,
    user: userEvent.setup(),
    /** Play a live update: the card as the server now has it, or null once it is gone. */
    update: (live: BoardCard | null) => view.rerender(element(live)),
  };
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const save = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "Save" }));

describe("CardEditor: a card made here", () => {
  test("starts from the card's values", () => {
    setup(native);
    expect(field("Company").value).toBe("Austin Vertical");
    expect(field("Contact").value).toBe("Dana Lee");
    expect(field("Monthly fee (USD)").value).toBe("450");
    expect(field("Stage").value).toBe("demo");
    expect(field("Next step").value).toBe("Send pricing");
    expect(field("Notes").value).toBe("");
  });

  test("a save sends only what was changed", async () => {
    const { onSave, onClose, user } = setup(native);
    await user.clear(field("Next step"));
    await user.type(field("Next step"), "Book the demo");
    await user.selectOptions(field("Stage"), "proposal");
    await save(user);
    expect(onSave).toHaveBeenCalledWith({ nextStep: "Book the demo", stage: "proposal" });
    expect(onClose).toHaveBeenCalled();
  });

  test("an emptied field is sent as null, which clears it", async () => {
    const { onSave, user } = setup(native);
    await user.clear(field("Contact"));
    await user.clear(field("Monthly fee (USD)"));
    await user.clear(field("Next step"));
    await save(user);
    expect(onSave).toHaveBeenCalledWith({ contact: null, amount: null, nextStep: null });
  });

  test("an amount is sent as a number, commas and all", async () => {
    const { onSave, user } = setup(native);
    await user.clear(field("Monthly fee (USD)"));
    await user.type(field("Monthly fee (USD)"), "1,250.50");
    await save(user);
    expect(onSave).toHaveBeenCalledWith({ amount: 1250.5 });
  });

  test("an amount that is not a number is refused before anything is sent", async () => {
    const { onSave, onClose, user } = setup(native);
    await user.clear(field("Monthly fee (USD)"));
    await user.type(field("Monthly fee (USD)"), "about 500");
    await save(user);
    expect(screen.getByRole("alert").textContent).toBe("That amount is not a number.");
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  test("a blank name is refused before anything is sent", async () => {
    const { onSave, user } = setup(native);
    await user.clear(field("Company"));
    await save(user);
    expect(screen.getByRole("alert").textContent).toBe("A deal needs a company name.");
    expect(onSave).not.toHaveBeenCalled();
  });

  test("saving with nothing changed just closes", async () => {
    const { onSave, onClose, user } = setup(native);
    await save(user);
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  test("what was typed wins over what the server sends meanwhile", async () => {
    // A push, a save landing or another device must never replace unsaved words.
    const { onSave, user, update } = setup(native);
    await user.type(field("Notes"), "Wants a pilot in November");
    await user.type(field("Contact"), " Jr");
    update({
      ...native,
      notes: "Something from elsewhere",
      contact: "Someone Else",
      nextStep: "Changed elsewhere",
    });
    expect(field("Notes").value).toBe("Wants a pilot in November");
    expect(field("Contact").value).toBe("Dana Lee Jr");
    // A field with nothing typed in it does follow the server.
    expect(field("Next step").value).toBe("Changed elsewhere");
    await save(user);
    expect(onSave).toHaveBeenCalledWith({
      contact: "Dana Lee Jr",
      notes: "Wants a pilot in November",
    });
  });

  test("a failed save says why and keeps the text and the dialog", async () => {
    const { onSave, onClose, user } = setup(native);
    onSave.mockRejectedValue(new ConvexError("That next step is too long (300 characters at most)."));
    await user.type(field("Notes"), "Kept");
    await save(user);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That next step is too long (300 characters at most).",
    );
    expect(field("Notes").value).toBe("Kept");
    expect(onClose).not.toHaveBeenCalled();
  });

  test("deleting asks first", async () => {
    const { onDelete, onClose, user } = setup(native);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText("Delete this deal?")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.queryByText("Delete this deal?")).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  test("a failed delete says why", async () => {
    const { onDelete, onClose, user } = setup(native);
    onDelete.mockRejectedValue(new ConvexError("That deal is no longer on the board."));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That deal is no longer on the board.",
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("CardEditor: a mirrored card", () => {
  test("says where it comes from and what can be changed here", () => {
    setup(mirrored, "KZT");
    expect(
      screen.getByText(
        "Mirrored from the Kazakhstan CRM. Its name, contact, stage and amount are changed there. The next step and notes are yours and stay here.",
      ),
    ).toBeTruthy();
  });

  test("shows what the source owns as text, with nothing to type into", () => {
    setup(mirrored, "KZT");
    expect(screen.getByText("Almaty Dental")).toBeTruthy();
    expect(screen.getByText("Dana Lee")).toBeTruthy();
    expect(screen.getByText("₸250K")).toBeTruthy();
    expect(screen.getByText("Qualified")).toBeTruthy();
    expect(screen.getByText("(there: Переговоры)")).toBeTruthy();
    for (const label of ["Company", "Contact", "Monthly fee (USD)", "Stage"]) {
      expect(screen.queryByLabelText(label), label).toBeNull();
    }
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
  });

  test("offers no delete", () => {
    setup(mirrored);
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  test("a save sends the next step and the notes and nothing the source owns", async () => {
    const { onSave, user } = setup(mirrored);
    await user.type(field("Next step"), "Ask for an intro");
    await user.type(field("Notes"), "Met in Almaty");
    await save(user);
    expect(onSave).toHaveBeenCalledWith({ nextStep: "Ask for an intro", notes: "Met in Almaty" });
  });

  test("a push landing while the notes are being written updates the card and keeps the notes", async () => {
    const { user, update } = setup(mirrored, "KZT");
    await user.type(field("Notes"), "Half a thought");
    update({ ...mirrored, name: "Almaty Dental Group", stage: "demo", sourceStage: "Презентация", notes: null });
    expect(screen.getByText("Almaty Dental Group")).toBeTruthy();
    expect(screen.getByText("Demo")).toBeTruthy();
    expect(field("Notes").value).toBe("Half a thought");
  });

  test("missing source fields read as not given, never as zero", () => {
    setup({ ...mirrored, contact: null, amount: null }, "KZT");
    expect(screen.getAllByText("None given")).toHaveLength(2);
    expect(screen.queryByText("₸0")).toBeNull();
  });
});

describe("CardEditor: a card that leaves the board while open", () => {
  test("keeps the typed text on screen, says it cannot be saved, and does not save", async () => {
    const { onSave, onClose, user, update } = setup(mirrored);
    await user.type(field("Notes"), "Do not lose this");
    update(null);
    expect(field("Notes").value).toBe("Do not lose this");
    expect(field("Notes").disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe(
      "This deal left the board while you were editing, so it can no longer be saved. Copy anything you need before closing.",
    );
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Close without saving" }));
    expect(onClose).toHaveBeenCalled();
  });
});
