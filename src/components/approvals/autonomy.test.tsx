// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { mockConvex } from "@/test-support/convex";
import { AutonomyOffers, BotGrants, FlagAuto, Grants } from "./autonomy";
import { EditThenApprove } from "./edit-then-approve";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
const NOW = Date.UTC(2026, 9, 18, 9);
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));
vi.mock("@/components/company-provider", () => ({ useCompany: () => null }));

// Every name and title is made up.
let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
  convex.setQuery(api.trust.offers, [{ proposer: "growth", name: "Growth", kind: "deal_next_step", streak: 10 }]);
  convex.setQuery(api.trust.grants, [
    { id: "g1", proposer: "growth", name: "Growth", kind: "task_create", grantedAt: NOW - 1000 },
    { id: "g2", proposer: "engineering", name: "Engineering manager", kind: "task_change", grantedAt: NOW - 1000 },
  ]);
});
afterEach(cleanup);

test("the offer names the bot and the kind, and Yes / Not yet call the server", async () => {
  render(<AutonomyOffers />);
  expect(screen.getByText(/Let Growth do/)).toBeTruthy();
  expect(screen.getByText("deal_next_step")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Yes" }));
  await waitFor(() =>
    expect(convex.mutation(api.trust.grant)).toHaveBeenCalledWith({ proposer: "growth", kind: "deal_next_step" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Not yet" }));
  await waitFor(() =>
    expect(convex.mutation(api.trust.notYet)).toHaveBeenCalledWith({ proposer: "growth", kind: "deal_next_step" }),
  );
});

test("on Decided: every grant, each revoked in one click; an automatic approval is flagged with a reason", async () => {
  render(<Grants />);
  expect(screen.getByText("Growth:", { exact: false })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Revoke Engineering manager: task_change" }));
  await waitFor(() =>
    expect(convex.mutation(api.trust.revoke)).toHaveBeenCalledWith({ proposer: "engineering", kind: "task_change" }),
  );
  cleanup();
  render(<FlagAuto id="p1" name="Growth" />);
  fireEvent.click(screen.getByRole("button", { name: "Flag and revoke" }));
  fireEvent.change(screen.getByLabelText(/Why/), { target: { value: "Made-up: wrong" } });
  fireEvent.click(screen.getByRole("button", { name: "Flag and revoke" }));
  await waitFor(() => expect(convex.mutation(api.trust.flag)).toHaveBeenCalledWith({ id: "p1", reason: "Made-up: wrong" }));
});

test("a bot's card lists its own grants, each revoked in one click", async () => {
  render(<BotGrants botId="growth" />);
  expect(screen.getByText("task_create")).toBeTruthy();
  expect(screen.queryByText("task_change")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Revoke/ }));
  await waitFor(() =>
    expect(convex.mutation(api.trust.revoke)).toHaveBeenCalledWith({ proposer: "growth", kind: "task_create" }),
  );
});

test("a grant paused for want of write on the kind's area says so", () => {
  convex.setQuery(api.trust.grants, [
    {
      id: "g1",
      proposer: "growth",
      name: "Growth",
      kind: "task_create",
      grantedAt: NOW - 1000,
      paused: { area: "board", name: "Board" },
    },
  ]);
  render(<BotGrants botId="growth" />);
  expect(screen.getByText("paused: needs write on Board")).toBeTruthy();
});

test("Edit then approve sends the whole payload of the same kind; a bot's permission has nothing to edit", async () => {
  const step = {
    source: "proposal",
    id: "p9",
    agent: "sales",
    bot: "growth",
    kind: "deal_next_step",
    company: "us",
    reason: "Made-up reason.",
    createdAt: NOW,
    payload: { dealId: "d1", nextStep: "Made-up step" },
  } as never;
  render(<EditThenApprove row={step} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit then approve" }));
  fireEvent.change(screen.getByLabelText("Next step"), { target: { value: "Made-up: owner's step" } });
  fireEvent.click(screen.getByRole("button", { name: "Approve with changes" }));
  await waitFor(() =>
    expect(convex.mutation(api.assistant.approve)).toHaveBeenCalledWith({
      id: "p9",
      edit: { dealId: "d1", nextStep: "Made-up: owner's step" },
    }),
  );
  cleanup();
  const { container } = render(
    <EditThenApprove row={{ ...(step as object), kind: "bot_permission", payload: { bot: "growth", area: "sales", level: "write" } } as never} />,
  );
  expect(container.innerHTML).toBe("");
});
