// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, describe, expect, test, vi } from "vitest";
import { deferred } from "@/test-support/convex";
import { AddCard } from "./add-card";

afterEach(cleanup);

const open = async (
  user: ReturnType<typeof userEvent.setup>,
  onAdd: (name: string) => Promise<unknown>,
) => {
  render(
    <AddCard
      label="Add a deal"
      fieldLabel="New deal in Lead"
      placeholder="Clinic or company"
      onAdd={onAdd}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Add a deal" }));
  return screen.getByLabelText("New deal in Lead") as HTMLInputElement;
};

describe("AddCard", () => {
  test("adds a card and is ready for the next one", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn(async () => null);
    const input = await open(user, onAdd);
    await user.type(input, "Austin Vertical{Enter}");
    expect(onAdd).toHaveBeenCalledWith("Austin Vertical");
    expect(input.value).toBe("");
  });

  test("what is typed for the next card while the last one is saving is kept", async () => {
    const user = userEvent.setup();
    const gate = deferred();
    const input = await open(user, () => gate.promise);
    await user.type(input, "First{Enter}");
    await user.type(input, "Second");
    gate.resolve(null);
    await waitFor(() => expect(input.value).toBe("Second"));
  });

  test("a failed add puts the name back and says why", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn(async () => {
      throw new ConvexError("That name is too long (120 characters at most).");
    });
    const input = await open(user, onAdd);
    await user.type(input, "Far too long{Enter}");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That name is too long (120 characters at most).",
    );
    expect(input.value).toBe("Far too long");
  });

  test("a failed add does not overwrite what was typed since", async () => {
    const user = userEvent.setup();
    const gate = deferred();
    const input = await open(user, () => gate.promise);
    await user.type(input, "First{Enter}");
    await user.type(input, "Second");
    gate.reject(new ConvexError("Nope."));
    await screen.findByRole("alert");
    expect(input.value).toBe("Second");
  });

  test("a blank name adds nothing and closes the form", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn(async () => null);
    const input = await open(user, onAdd);
    await user.type(input, "   {Enter}");
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Add a deal" })).toBeTruthy();
  });

  test("Escape closes the form and returns focus to the add button", async () => {
    const user = userEvent.setup();
    await open(user, async () => null);
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add a deal" }));
  });
});
