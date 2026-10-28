// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { PARTNER_STAGES, type PartnerCard } from "@convex/lib/partnerStages";
import { PartnerBoard } from "./partner-board";
import { PartnerEditor } from "./partner-editor";
import { PartnerTable } from "./partner-table";
import { PartnerTiles } from "./partner-tiles";

afterEach(cleanup);
beforeAll(() => {
  // jsdom has no CSS.escape, which the board uses to find a moved card's grip.
  window.CSS ??= { escape: (value: string) => value } as typeof CSS;
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 18, 12);
const TODAY = "2026-10-18";

let next = 0;
const partner = (name: string, over: Partial<PartnerCard> = {}): PartnerCard => ({
  id: `p${next++}`,
  company: "us",
  name,
  type: "channel",
  stage: "in_talks",
  owner: null,
  contact: null,
  contactRole: null,
  value: null,
  valueKind: null,
  notes: null,
  nextStep: null,
  nextStepOn: null,
  lastActivityAt: NOW,
  links: [],
  editedBy: null,
  ...over,
});
const boardOf = (cards: PartnerCard[]) => {
  const board: Record<string, PartnerCard[]> = Object.fromEntries(PARTNER_STAGES.map((stage) => [stage, []]));
  for (const card of cards) board[card.stage]!.push(card);
  return board;
};

describe("the board", () => {
  const setup = (cards: PartnerCard[]) => {
    const handlers = {
      onMove: vi.fn(async () => null as unknown),
      onCreate: vi.fn(async () => "p-new"),
      onSave: vi.fn(async () => null as unknown),
      onDelete: vi.fn(async () => null as unknown),
    };
    render(<PartnerBoard board={boardOf(cards)} now={NOW} today={TODAY} currency="USD" {...handlers} />);
    return { ...handlers, user: userEvent.setup() };
  };
  const column = (title: string) => screen.getByRole("region", { name: new RegExp(`^${title}`) });

  test("draws a column for each of the seven stages, with its count", () => {
    setup([partner("A"), partner("B"), partner("C", { stage: "live" })]);
    for (const title of ["Identified", "Contacted", "In talks", "Agreement", "Live", "Paused", "Lost"]) {
      expect(column(title)).toBeTruthy();
    }
    expect(within(column("In talks")).getByText("A")).toBeTruthy();
    expect(within(column("Live")).getByText("C")).toBeTruthy();
  });

  test("a card says its kind, contact, value, next step and date", () => {
    setup([
      partner("Billing Co", {
        contact: "Dana",
        contactRole: "Head of partnerships",
        value: 12,
        valueKind: "referrals",
        nextStep: "Send the deck",
        nextStepOn: "2026-10-25",
      }),
    ]);
    const card = within(column("In talks"));
    expect(card.getByText("Channel or reseller")).toBeTruthy();
    expect(card.getByText("Dana, Head of partnerships")).toBeTruthy();
    expect(card.getByText("12 referrals/mo")).toBeTruthy();
    expect(card.getByText(/Send the deck/)).toBeTruthy();
    expect(card.getByText(/by Oct 25/)).toBeTruthy();
  });

  test("quiet after fourteen days, with an overdue step said so; a live partner is not judged", () => {
    setup([
      partner("Quiet Co", { lastActivityAt: NOW - 20 * DAY, nextStep: "Chase", nextStepOn: "2026-10-01" }),
      partner("Fine Co", { lastActivityAt: NOW - DAY }),
      partner("Live Co", { stage: "live", lastActivityAt: NOW - 90 * DAY }),
    ]);
    expect(within(column("In talks")).getByText("Quiet 20 days")).toBeTruthy();
    expect(within(column("In talks")).getByText(/was due Oct 1/)).toBeTruthy();
    expect(within(column("Live")).queryByText(/Quiet/)).toBeNull();
    expect(screen.getAllByText(/^Quiet \d+ days$/)).toHaveLength(1);
  });

  test("a card changed through the owner's Claude says so", () => {
    setup([partner("A", { editedBy: "Claude Code on the Mac" })]);
    expect(screen.getByText("Last changed by Claude Code on the Mac")).toBeTruthy();
  });

  test("adding under the early stages only, and the editor opens for the new partner", async () => {
    const { onCreate, user } = setup([]);
    expect(within(column("Live")).queryByRole("button", { name: "Add a partner" })).toBeNull();
    await user.click(within(column("Contacted")).getByRole("button", { name: "Add a partner" }));
    await user.type(screen.getByLabelText("New partner in Contacted"), "New Co");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(onCreate).toHaveBeenCalledWith("contacted", "New Co");
  });

  test("opening a card edits it, and a save sends only what changed", async () => {
    const card = partner("Billing Co", { nextStep: "Call" });
    const { onSave, user } = setup([card]);
    await user.click(screen.getByRole("button", { name: "Billing Co" }));
    const dialog = screen.getByRole("dialog");
    await user.clear(within(dialog).getByLabelText("Next step"));
    await user.type(within(dialog).getByLabelText("Next step"), "Send pricing");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(card.id, { nextStep: "Send pricing" });
  });
});

describe("the editor", () => {
  const open = (over: Partial<PartnerCard> = {}) => {
    const handlers = {
      onSave: vi.fn(async () => null as unknown),
      onDelete: vi.fn(async () => null as unknown),
      onClose: vi.fn(),
    };
    render(<PartnerEditor partner={partner("Billing Co", over)} currency="USD" {...handlers} />);
    return { ...handlers, user: userEvent.setup() };
  };

  test("a value needs to say what it counts", async () => {
    const { onSave, user } = open();
    await user.type(screen.getByLabelText("Expected a month"), "8");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Say whether the value counts referrals or revenue.");
    expect(onSave).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByLabelText("It counts"), "referrals");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ value: 8, valueKind: "referrals" });
  });

  test("clearing a field sends null; links are read one a line", async () => {
    const { onSave, user } = open({ contact: "Dana" });
    await user.clear(screen.getByLabelText("Contact"));
    await user.type(screen.getByLabelText("Links"), "Their site | https://example.com");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({
      contact: null,
      links: [{ label: "Their site", url: "https://example.com" }],
    });
  });

  test("the server's reason is shown, and the editor stays open", async () => {
    const { onSave, onClose, user } = open();
    onSave.mockRejectedValueOnce(new Error("nope"));
    await user.type(screen.getByLabelText("Notes"), "x");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  test("deleting asks first", async () => {
    const { onDelete, onClose, user } = open();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(within(screen.getByText("Delete this partner?").parentElement!).getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalled();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  test("a partner that left the board cannot be saved", () => {
    const { rerender } = render(
      <PartnerEditor partner={partner("Gone Co")} currency="USD" onSave={vi.fn()} onDelete={vi.fn()} onClose={vi.fn()} />,
    );
    rerender(<PartnerEditor partner={null} currency="USD" onSave={vi.fn()} onDelete={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("alert").textContent).toMatch(/left the board/);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the table", () => {
  test("rows by stage then name, an overdue step marked in words, and a CSV to download", () => {
    render(
      <PartnerTable
        partners={[
          partner("Zed", { stage: "live" }),
          partner("Alpha", { nextStep: "Chase", nextStepOn: "2026-10-01", lastActivityAt: NOW - 30 * DAY }),
          partner("Beta", { stage: "identified" }),
        ]}
        company="Startup"
        now={NOW}
        today={TODAY}
        onOpen={vi.fn()}
      />,
    );
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("rowheader")[0]!.textContent)).toEqual(["Beta", "Alpha", "Zed"]);
    expect(screen.getByText("Was due Oct 1")).toBeTruthy();
    expect(screen.getByText("Quiet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download Startup partners as CSV" })).toBeTruthy();
  });

  test("a name opens the partner", async () => {
    const onOpen = vi.fn();
    const one = partner("Alpha");
    render(<PartnerTable partners={[one]} company="Startup" now={NOW} today={TODAY} onOpen={onOpen} />);
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    expect(onOpen).toHaveBeenCalledWith(one.id);
  });
});

describe("the tiles", () => {
  test("a count for every stage, the quiet partners, and those with a step overdue", () => {
    render(
      <PartnerTiles
        now={NOW}
        today={TODAY}
        partners={[
          partner("A", { lastActivityAt: NOW - 20 * DAY, nextStepOn: "2026-10-01" }),
          partner("B", { lastActivityAt: NOW - 20 * DAY }),
          partner("C", { stage: "live" }),
        ]}
      />,
    );
    const counts = within(screen.getByRole("list", { name: "Partners by stage" }));
    expect(counts.getAllByRole("listitem")).toHaveLength(7);
    expect(counts.getByText("In talks").textContent).toBe("In talks2");
    expect(counts.getByText("Live").textContent).toBe("Live1");
    expect(screen.getByText("Gone quiet").closest("div")!.textContent).toContain("2");
    expect(screen.getByText("Quiet with a next step overdue").closest("div")!.textContent).toContain("1");
  });

  test("nobody in conversation says so rather than a reassuring number", () => {
    render(<PartnerTiles now={NOW} today={TODAY} partners={[partner("C", { stage: "live" })]} />);
    expect(screen.getByText("No partner is in Contacted, In talks or Agreement.")).toBeTruthy();
  });
});
