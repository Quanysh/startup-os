// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import type { ObligationRow } from "@convex/lib/obligationShape";
import { obligation } from "@/lib/compliance/fixtures";
import { deferred, mockConvex } from "@/test-support/convex";
import { ObligationEditor } from "./obligation-editor";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

let convex: ReturnType<typeof mockConvex>;
const onClose = vi.fn();
const editor = (row: ObligationRow | null) => (
  <ObligationEditor obligation={row} category="soc2" onClose={onClose} />
);
const field = <T extends HTMLElement = HTMLInputElement>(label: string) =>
  screen.getByLabelText(label) as T;
const setDate = (value: string) => fireEvent.change(field("Date"), { target: { value } });
const save = () => screen.getByRole("button", { name: "Save" });
const alertText = async () => (await screen.findByRole("alert")).textContent;

beforeEach(() => {
  convex = mockConvex();
  onClose.mockClear();
});
afterEach(cleanup);

describe("ObligationEditor: adding", () => {
  test("a new item needs only a title; nothing is filled in for it", async () => {
    const user = userEvent.setup();
    render(editor(null));
    await user.type(field("Title"), "Annual access review");
    await user.click(save());
    // No date, no confirmation, no link, no note: none is invented.
    expect(convex.mutation(api.obligations.create)).toHaveBeenCalledWith({
      category: "soc2",
      title: "Annual access review",
      recurrence: "none",
    });
    expect(onClose).toHaveBeenCalled();
  });

  test("a date typed in is sent unconfirmed unless the owner ticks that they checked it", async () => {
    const user = userEvent.setup();
    render(editor(null));
    await user.type(field("Title"), "Report");
    setDate("2027-03-01");
    await user.click(save());
    expect(convex.mutation(api.obligations.create)).toHaveBeenCalledWith(
      expect.objectContaining({ due: "2027-03-01", dueConfirmed: false }),
    );
    cleanup();

    render(editor(null));
    await user.type(field("Title"), "Report");
    setDate("2027-03-01");
    await user.click(field("I have checked this date"));
    await user.click(save());
    expect(convex.mutation(api.obligations.create)).toHaveBeenLastCalledWith(
      expect.objectContaining({ due: "2027-03-01", dueConfirmed: true }),
    );
  });

  test("with no date there is nothing to confirm", async () => {
    const user = userEvent.setup();
    render(editor(null));
    await user.click(field("I have checked this date"));
    expect(field("I have checked this date").checked).toBe(false);
    expect(
      screen.getByText("With no date, the item is listed as having none: it is never shown as due."),
    ).toBeTruthy();
  });

  test.each([
    ["no title", async () => {}, "A compliance item needs a title."],
    [
      "a link that is not https",
      async (user: ReturnType<typeof userEvent.setup>) => {
        await user.type(field("Title"), "x");
        await user.type(field("Evidence link"), "javascript:alert(1)");
      },
      "An evidence link must be a full https:// address.",
    ],
    [
      "a plain http link",
      async (user: ReturnType<typeof userEvent.setup>) => {
        await user.type(field("Title"), "x");
        await user.type(field("Evidence link"), "http://example.com/report.pdf");
      },
      "An evidence link must be a full https:// address.",
    ],
  ])("%s is refused before anything is sent", async (_label, fill, message) => {
    const user = userEvent.setup();
    render(editor(null));
    await fill(user);
    await user.click(save());
    expect(await alertText()).toBe(message);
    expect(convex.mutation(api.obligations.create)).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  test("a new item cannot be deleted: there is nothing to delete", () => {
    render(editor(null));
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });
});

describe("ObligationEditor: editing", () => {
  const row = () =>
    obligation({
      title: "Franchise tax",
      category: "corporate_tax",
      due: "2027-03-01",
      dueConfirmed: true,
      recurrence: "annual",
      evidenceUrl: "https://example.com/receipt",
      note: "Pay online",
    });

  test("it opens on the item's values and saves every field", async () => {
    const user = userEvent.setup();
    const item = row();
    render(editor(item));
    expect(field("Title").value).toBe("Franchise tax");
    expect(field("I have checked this date").checked).toBe(true);
    await user.selectOptions(field<HTMLSelectElement>("Status"), "in_progress");
    await user.click(save());
    expect(convex.mutation(api.obligations.update)).toHaveBeenCalledWith({
      id: item.id,
      category: "corporate_tax",
      title: "Franchise tax",
      due: "2027-03-01",
      dueConfirmed: true,
      recurrence: "annual",
      status: "in_progress",
      note: "Pay online",
      evidenceUrl: "https://example.com/receipt",
    });
  });

  test("changing the date clears the tick: the confirmation was of the old date", async () => {
    const user = userEvent.setup();
    render(editor(row()));
    setDate("2027-03-15");
    expect(field("I have checked this date").checked).toBe(false);
    expect(
      screen.getByText(
        "Until it is ticked, the date is shown as unconfirmed and is never counted as due or overdue.",
      ),
    ).toBeTruthy();
    await user.click(save());
    expect(convex.mutation(api.obligations.update)).toHaveBeenCalledWith(
      expect.objectContaining({ due: "2027-03-15", dueConfirmed: false }),
    );
  });

  test("clearing the date, the link and the note sends null for each", async () => {
    const user = userEvent.setup();
    render(editor(row()));
    setDate("");
    await user.clear(field("Evidence link"));
    await user.clear(field<HTMLTextAreaElement>("Note"));
    await user.click(save());
    expect(convex.mutation(api.obligations.update)).toHaveBeenCalledWith(
      expect.objectContaining({ due: null, dueConfirmed: false, evidenceUrl: null, note: null }),
    );
  });

  test("a finished item stays done unless reopened; done is never offered otherwise", async () => {
    const user = userEvent.setup();
    const done = { ...row(), status: "done" as const };
    render(editor(done));
    expect(field<HTMLSelectElement>("Status").value).toBe("done");
    await user.click(save());
    // No status is sent, so it stays as it is.
    expect(convex.mutation(api.obligations.update)).toHaveBeenCalledWith(
      expect.not.objectContaining({ status: expect.anything() }),
    );
    cleanup();

    render(editor(row()));
    const options = [...field<HTMLSelectElement>("Status").options].map((o) => o.value);
    expect(options).toEqual(["open", "in_progress", "not_applicable"]);
  });

  test("what has been typed survives a live update of the item", async () => {
    const user = userEvent.setup();
    const item = row();
    const view = render(editor(item));
    await user.clear(field<HTMLTextAreaElement>("Note"));
    await user.type(field<HTMLTextAreaElement>("Note"), "Typed and not saved");
    view.rerender(editor({ ...item, note: "Written elsewhere", title: "Renamed elsewhere" }));
    expect(field<HTMLTextAreaElement>("Note").value).toBe("Typed and not saved");
    expect(field("Title").value).toBe("Franchise tax");
  });

  test("a failed save shows the server's reason and keeps the form open", async () => {
    const user = userEvent.setup();
    convex
      .mutation(api.obligations.update)
      .mockRejectedValueOnce(new ConvexError("The due date is not a date."));
    render(editor(row()));
    await user.click(save());
    expect(await alertText()).toBe("The due date is not a date.");
    expect(onClose).not.toHaveBeenCalled();
    // And it can be sent again.
    await user.click(save());
    expect(convex.mutation(api.obligations.update)).toHaveBeenCalledTimes(2);
  });

  test("while saving, the button stays focusable and a second click sends nothing", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    convex.mutation(api.obligations.update).mockReturnValueOnce(pending.promise);
    render(editor(row()));
    await user.click(save());
    expect(save().getAttribute("aria-disabled")).toBe("true");
    expect((save() as HTMLButtonElement).disabled).toBe(false);
    await user.click(save());
    expect(convex.mutation(api.obligations.update)).toHaveBeenCalledTimes(1);
    pending.resolve(null);
  });

  test("deleting asks first", async () => {
    const user = userEvent.setup();
    const item = row();
    render(editor(item));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Delete this item?")).toBeTruthy();
    expect(convex.mutation(api.obligations.remove)).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(convex.mutation(api.obligations.remove)).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(convex.mutation(api.obligations.remove)).toHaveBeenCalledWith({ id: item.id });
    expect(onClose).toHaveBeenCalled();
  });

  test("a failed delete is shown, and the item is still there to edit", async () => {
    const user = userEvent.setup();
    convex.mutation(api.obligations.remove).mockRejectedValueOnce(new Error("network"));
    render(editor(row()));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(await alertText()).toBe("That item could not be deleted. Try again.");
    expect(onClose).not.toHaveBeenCalled();
  });
});
