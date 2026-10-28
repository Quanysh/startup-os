// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { TableDeal } from "@/lib/pipeline/table-view";
import { DEAL_COLUMNS } from "@/lib/pipeline/stages";
import { CardEditor, type EditorWords } from "./card-editor";

// A US deal's details in the editor: only when the page asks for them
// (`withDetails`), and only for a deal made here. Without the prop the editor
// is exactly what the boards have always opened (card-editor.test.tsx).

afterEach(cleanup);

const WORDS: EditorWords = {
  noun: "deal",
  title: "Deal",
  nameLabel: "Company",
  blankName: "A deal needs a company name.",
  amountLabel: "Monthly fee (USD)",
};

const deal: TableDeal = {
  id: "d1",
  name: "Austin Vertical",
  stage: "lead",
  amount: null,
  lastActivityAt: 0,
  closedAt: null,
  nextStep: null,
  mirrored: false,
  source: "manual",
  contact: null,
  sourceStage: null,
  notes: null,
  priority: "medium",
  region: "TX",
  physicians: 59,
  locations: null,
  sources: ["Made-up market scan", "Sample list"],
};

function setup(card: TableDeal, withDetails = true) {
  const onSave = vi.fn(async (_edit: unknown) => null as unknown);
  render(
    <CardEditor
      card={card}
      words={WORDS}
      columns={DEAL_COLUMNS}
      currency="USD"
      mirrorNamed={card.mirrored ? "the Kazakhstan CRM" : null}
      withDetails={withDetails}
      onSave={onSave}
      onDelete={vi.fn(async () => null)}
      onClose={vi.fn()}
    />,
  );
  return { onSave, user: userEvent.setup() };
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const DETAIL_LABELS = ["Priority", "Region", "Physicians", "Locations", "Sources"];

describe("CardEditor: a deal's details", () => {
  test("shows them from the deal", () => {
    setup(deal);
    expect(field("Priority").value).toBe("medium");
    expect(field("Region").value).toBe("TX");
    expect(field("Physicians").value).toBe("59");
    expect(field("Locations").value).toBe("");
    expect(field("Sources").value).toBe("Made-up market scan\nSample list");
  });

  test("sends only what changed, a blank as a clear, and the sources one per line", async () => {
    const { onSave, user } = setup(deal);
    await user.selectOptions(field("Priority"), "high");
    await user.clear(field("Region"));
    await user.type(field("Locations"), "29");
    await user.clear(field("Sources"));
    await user.type(field("Sources"), " One scan \n\nTwo ");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({
      priority: "high",
      region: null,
      locations: 29,
      sources: ["One scan", "Two"],
    });
  });

  test("no priority and no sources are sent as clears", async () => {
    const { onSave, user } = setup(deal);
    await user.selectOptions(field("Priority"), "");
    await user.clear(field("Sources"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ priority: null, sources: null });
  });

  test("a count that is not a whole number is said, and nothing is sent", async () => {
    const { onSave, user } = setup(deal);
    await user.clear(field("Physicians"));
    await user.type(field("Physicians"), "about 60");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert").textContent).toBe("Physicians must be a whole number.");
    expect(onSave).not.toHaveBeenCalled();
  });

  test("are not offered for a mirrored deal, nor where the page did not ask for them", () => {
    setup({ ...deal, mirrored: true, source: "kz_crm" });
    for (const label of DETAIL_LABELS) expect(screen.queryByLabelText(label)).toBeNull();
    cleanup();
    setup(deal, false);
    for (const label of DETAIL_LABELS) expect(screen.queryByLabelText(label)).toBeNull();
  });
});
