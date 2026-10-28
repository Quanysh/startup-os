// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { InvestorExtras } from "@/lib/fundraising/sync";
import { SyncChips } from "./sync-chips";

afterEach(cleanup);

const extras = (over: Partial<InvestorExtras>) => ({
  id: "i1",
  name: "Example Ventures",
  sync: null,
  changedInVisible: false,
  ...over,
});

describe("SyncChips", () => {
  test("nothing to say, nothing shown", () => {
    const { container } = render(<SyncChips card={extras({})} onRetry={vi.fn()} />);
    expect(container.textContent).toBe("");
  });

  test("pending and sent say it is on its way", () => {
    render(<SyncChips card={extras({ sync: { status: "pending", queuedAt: 1 } })} onRetry={vi.fn()} />);
    expect(screen.getByText("Syncing to Visible")).toBeTruthy();
    cleanup();
    render(<SyncChips card={extras({ sync: { status: "sent", queuedAt: 1 } })} onRetry={vi.fn()} />);
    expect(screen.getByText("Syncing to Visible")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("a confirmed send says nothing", () => {
    const { container } = render(
      <SyncChips card={extras({ sync: { status: "confirmed", queuedAt: 1 } })} onRetry={vi.fn()} />,
    );
    expect(container.textContent).toBe("");
  });

  test("a failure says why in words, never the code, and Retry queues it again", async () => {
    const onRetry = vi.fn(async () => null);
    const user = userEvent.setup();
    render(
      <SyncChips
        card={extras({ sync: { status: "failed", errorCode: "unmapped_stage", queuedAt: 1 } })}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("Sync failed: Visible has no stage that matches")).toBeTruthy();
    expect(screen.queryByText(/unmapped_stage/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry sending Example Ventures to Visible" }));
    expect(onRetry).toHaveBeenCalledWith("i1");
  });

  test("a retry the server refuses is said in its words", async () => {
    const onRetry = vi.fn(async () => {
      throw new ConvexError("That investor is no longer on the board.");
    });
    const user = userEvent.setup();
    render(<SyncChips card={extras({ sync: { status: "failed", queuedAt: 1 } })} onRetry={onRetry} />);
    expect(screen.getByText("Sync failed: Visible did not take the change")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Retry/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("That investor is no longer on the board.");
  });

  test("a change made in Visible is flagged", () => {
    render(<SyncChips card={extras({ changedInVisible: true })} onRetry={vi.fn()} />);
    expect(screen.getByText("Changed in Visible")).toBeTruthy();
  });
});
