// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import type { CustomerRow } from "@convex/lib/customerShape";
import { US, clinic } from "@/lib/customers/fixtures";
import { health } from "@/lib/customers/health";
import { deferred, mockConvex } from "@/test-support/convex";
import { CustomerDrawer } from "./customer-drawer";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

const NOW = new Date(2026, 9, 12, 12).getTime();
const REG = { day: "2026-10-12", label: "Oct 12" };

let convex: ReturnType<typeof mockConvex>;
const onClose = vi.fn();
const drawer = (row: CustomerRow) => (
  <CustomerDrawer clinic={row} health={health(row, REG)} now={NOW} onClose={onClose} />
);
const note = () => screen.getByLabelText("Note") as HTMLTextAreaElement;
const nextTouch = () => screen.getByLabelText("Next touch") as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: "Save" });
const saved = () => convex.mutation(api.customers.setOwnerFields);

beforeEach(() => {
  convex = mockConvex();
  onClose.mockClear();
});
afterEach(cleanup);

describe("CustomerDrawer: what it shows", () => {
  test("every reason for the verdict, known or not, and the register's figures", () => {
    const row = clinic({
      name: "SECRET A",
      ...US,
      monthlyFee: 1_000,
      amountOwed: 2_500,
      lastUsageDate: null,
      lastPaymentDate: "2026-10-01",
    });
    render(drawer(row));
    expect(screen.getByRole("dialog", { name: "SECRET A" })).toBeTruthy();
    expect(screen.getByText("Paid 11 days before the register was pushed on Oct 12.")).toBeTruthy();
    expect(
      screen.getByText("Owes $2,500: 2.5 months of fees (watch above 1, at risk above 2)."),
    ).toBeTruthy();
    // No usage data is listed as unknown, not held against the clinic.
    expect(screen.getByText("No usage data.")).toBeTruthy();
    expect(screen.getByText("No date on record")).toBeTruthy();
    expect(screen.getAllByText("At risk").length).toBeGreaterThanOrEqual(1);
  });

  test("a clinic that is not assessed says why, and lists no reasons", () => {
    render(drawer(clinic({ status: "churned", lastPaymentDate: "2026-01-01" })));
    expect(screen.getByText("Churned in the client register.")).toBeTruthy();
    expect(screen.queryByText(/Last paid/)).toBeNull();
  });

  test("a clinic no longer in the register says its note is kept", () => {
    render(drawer(clinic({ archived: true, note: "Left in September" })));
    expect(
      screen.getByText("The last push of the register did not carry this clinic. Its note is kept."),
    ).toBeTruthy();
    expect(note().value).toBe("Left in September");
  });
});

describe("CustomerDrawer: the owner's two fields", () => {
  test("only what was typed is sent, trimmed of nothing: the server cleans it", async () => {
    const user = userEvent.setup();
    const row = clinic({ note: "Old note", nextTouch: "2026-10-20" });
    render(drawer(row));
    await user.clear(note());
    await user.type(note(), "Call the director");
    await user.click(saveButton());
    // The next touch was not touched, so it is not sent.
    expect(saved()).toHaveBeenCalledWith({ id: row.id, note: "Call the director" });
    expect(await screen.findByText("Saved")).toBeTruthy();
  });

  test("clearing a field sends null, which removes it", async () => {
    const user = userEvent.setup();
    const row = clinic({ note: "Old note", nextTouch: "2026-10-20" });
    render(drawer(row));
    await user.clear(note());
    await user.clear(nextTouch());
    await user.click(saveButton());
    expect(saved()).toHaveBeenCalledWith({ id: row.id, note: null, nextTouch: null });
  });

  test("unsaved text wins over what the server sends", async () => {
    const user = userEvent.setup();
    const row = clinic({ note: "Old note" });
    const view = render(drawer(row));
    await user.type(note(), " and more");
    // Another device saves a note, and a next touch, while this one is being typed.
    view.rerender(drawer({ ...row, note: "Written elsewhere", nextTouch: "2026-11-01" }));
    expect(note().value).toBe("Old note and more");
    // The field with no draft follows the server.
    expect(nextTouch().value).toBe("2026-11-01");
    expect(screen.getByText("Not saved yet")).toBeTruthy();
  });

  test("a field with no draft follows the server live", () => {
    const row = clinic({ note: "Old note" });
    const view = render(drawer(row));
    view.rerender(drawer({ ...row, note: "Written elsewhere" }));
    expect(note().value).toBe("Written elsewhere");
  });

  test("a failed save shows the server's reason and keeps what was typed", async () => {
    const user = userEvent.setup();
    saved().mockRejectedValueOnce(new ConvexError("The next touch is not a date."));
    render(drawer(clinic()));
    await user.type(note(), "Keep me");
    await user.click(saveButton());
    expect((await screen.findByRole("alert")).textContent).toBe("The next touch is not a date.");
    expect(note().value).toBe("Keep me");
    // Still unsaved, so it can be sent again.
    await user.click(saveButton());
    expect(saved()).toHaveBeenCalledTimes(2);
  });

  test("an unexpected failure gets the fallback, not the error's own words", async () => {
    const user = userEvent.setup();
    saved().mockRejectedValueOnce(new Error("internal SECRET detail"));
    render(drawer(clinic()));
    await user.type(note(), "x");
    await user.click(saveButton());
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That could not be saved. Try again.",
    );
  });

  test("while saving, the button stays focusable and a second click sends nothing", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    saved().mockReturnValueOnce(pending.promise);
    render(drawer(clinic()));
    await user.type(note(), "x");
    await user.click(saveButton());
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false);
    await user.click(saveButton());
    expect(saved()).toHaveBeenCalledTimes(1);
    pending.resolve(null);
    expect(await screen.findByText("Saved")).toBeTruthy();
  });

  test("text typed while a save is in flight is still a draft afterwards", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    saved().mockReturnValueOnce(pending.promise);
    const row = clinic();
    const view = render(drawer(row));
    await user.type(note(), "first");
    await user.click(saveButton());
    await user.type(note(), " second");
    pending.resolve(null);
    // The save lands, and the server echoes what was sent.
    view.rerender(drawer({ ...row, note: "first" }));
    expect(await screen.findByText("Not saved yet")).toBeTruthy();
    expect(note().value).toBe("first second");
  });

  test("with nothing typed there is nothing to save", async () => {
    const user = userEvent.setup();
    render(drawer(clinic({ note: "Old note" })));
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
    await user.click(saveButton());
    expect(saved()).not.toHaveBeenCalled();
  });

  test("a note over the cap is refused before it is sent", async () => {
    const user = userEvent.setup();
    render(drawer(clinic()));
    await user.click(note());
    await user.paste("x".repeat(5_001));
    expect(screen.getByRole("alert").textContent).toBe(
      "That note is too long (5000 characters at most).",
    );
    await user.click(saveButton());
    expect(saved()).not.toHaveBeenCalled();
  });
});
