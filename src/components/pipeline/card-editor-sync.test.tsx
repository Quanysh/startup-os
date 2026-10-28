// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { BoardCard } from "@/lib/pipeline/derive";
import { INVESTOR_COLUMNS } from "@/lib/pipeline/stages";
import { CardEditor } from "./card-editor";

// A mirrored card whose source takes changes back (a Visible investor): its
// name, amount and stage are edited here and sent there; its contact stays
// the source's. And the archive action, which any investor has.

afterEach(cleanup);

const WORDS = {
  noun: "investor",
  title: "Investor",
  nameLabel: "Investor or firm",
  blankName: "An investor needs a name.",
  amountLabel: "Cheque (USD)",
};
const NOTE = "From Visible. Changes go there in the daily run.";

const visible: BoardCard = {
  id: "i1",
  name: "Example Ventures",
  stage: "meeting",
  amount: 250_000,
  lastActivityAt: 0,
  closedAt: null,
  nextStep: null,
  mirrored: true,
  source: "visible",
  contact: "Sam Example",
  sourceStage: "First meeting",
  notes: null,
};

function setup(card: BoardCard, props: { editable?: boolean; archive?: boolean } = {}) {
  const onSave = vi.fn(async (_edit: unknown) => null as unknown);
  const onDelete = vi.fn(async () => null as unknown);
  const onArchive = vi.fn(async () => null as unknown);
  const onClose = vi.fn();
  render(
    <CardEditor
      card={card}
      words={WORDS}
      columns={INVESTOR_COLUMNS}
      currency="USD"
      mirrorNamed="Visible"
      editable={props.editable}
      note={NOTE}
      onSave={onSave}
      onDelete={onDelete}
      onArchive={props.archive === false ? undefined : onArchive}
      onClose={onClose}
    />,
  );
  return { onSave, onDelete, onArchive, onClose, user: userEvent.setup() };
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe("CardEditor: a mirrored card that can be edited here", () => {
  test("offers its name, amount and stage, and shows its contact as text", () => {
    setup(visible, { editable: true });
    expect(field("Investor or firm").value).toBe("Example Ventures");
    expect(field("Cheque (USD)").value).toBe("250000");
    expect(field("Stage").value).toBe("meeting");
    expect(screen.queryByLabelText("Contact")).toBeNull();
    expect(screen.getByText("Sam Example")).toBeTruthy();
    expect(screen.getByText(NOTE)).toBeTruthy();
  });

  test("a save sends the fields changed, never the contact", async () => {
    const { onSave, user } = setup(visible, { editable: true });
    await user.clear(field("Investor or firm"));
    await user.type(field("Investor or firm"), "Example Capital");
    await user.clear(field("Cheque (USD)"));
    await user.type(field("Cheque (USD)"), "300,000");
    await user.selectOptions(field("Stage"), "diligence");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ name: "Example Capital", amount: 300_000, stage: "diligence" });
  });

  test("still offers no delete", () => {
    setup(visible, { editable: true });
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  test("without `editable` it is read-only as before", () => {
    setup(visible);
    expect(screen.queryByLabelText("Investor or firm")).toBeNull();
    expect(screen.getByText("Example Ventures")).toBeTruthy();
  });
});

describe("CardEditor: archive", () => {
  test("asks first, then archives and closes", async () => {
    const { onArchive, onClose, user } = setup(visible, { editable: true });
    await user.click(screen.getByRole("button", { name: "Archive" }));
    expect(onArchive).not.toHaveBeenCalled();
    expect(screen.getByText("Archive this investor? It can be restored.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Archive it" }));
    expect(onArchive).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  test("a refusal is said in the server's words and the editor stays", async () => {
    const { onArchive, onClose, user } = setup(visible, { editable: true });
    onArchive.mockRejectedValue(new ConvexError("That investor is no longer on the board."));
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await user.click(screen.getByRole("button", { name: "Archive it" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That investor is no longer on the board.");
    expect(onClose).not.toHaveBeenCalled();
  });

  test("not offered without onArchive", () => {
    setup(visible, { editable: true, archive: false });
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
  });
});
