// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { deferred, mockConvex } from "@/test-support/convex";
import { DomainLists } from "./domain-lists";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

let convex: ReturnType<typeof mockConvex>;
const set = (investorDomains: string[], customerDomains: string[]) =>
  convex.setQuery(api.workTools.settings, { off: [], investorDomains, customerDomains });

const investor = () => screen.getByLabelText("Investor domains") as HTMLTextAreaElement;
const customer = () => screen.getByLabelText("Customer domains") as HTMLTextAreaElement;
const save = () => screen.getByRole("button", { name: "Save" });

beforeEach(() => {
  convex = mockConvex();
  set(["example-fund.test"], ["clinic.test", "hospital.test"]);
});
afterEach(cleanup);

describe("DomainLists", () => {
  test("a skeleton while loading", () => {
    convex.setQuery(api.workTools.settings, undefined);
    render(<DomainLists />);
    expect(screen.getByTestId("domains-loading")).toBeTruthy();
  });

  test("shows the stored lists, one domain per line, and what they are for", () => {
    render(<DomainLists />);
    expect(investor().value).toBe("example-fund.test");
    expect(customer().value).toBe("clinic.test\nhospital.test");
    expect(
      screen.getByText(
        'Mail from these domains is grouped on the Today page. Everything else is "Other".',
      ),
    ).toBeTruthy();
    expect(screen.getByText("One domain per line.")).toBeTruthy();
  });

  test("Save sends both lists as lines, then says so", async () => {
    const user = userEvent.setup();
    render(<DomainLists />);
    await user.type(investor(), "\nanother-fund.test");
    await user.click(save());
    expect(convex.mutation(api.workTools.setDomains)).toHaveBeenCalledWith({
      investor: ["example-fund.test", "another-fund.test"],
      customer: ["clinic.test", "hospital.test"],
    });
    expect((await screen.findByRole("status")).textContent).toBe("Saved.");
  });

  test("a draft survives a settings update arriving mid-edit", async () => {
    const user = userEvent.setup();
    const view = render(<DomainLists />);
    await user.type(investor(), "\nhalf-typed");
    // A live update lands (another tab saved, or a sync touched the row).
    set(["someone-else.test"], ["clinic.test"]);
    view.rerender(<DomainLists />);
    expect(investor().value).toBe("example-fund.test\nhalf-typed");
    // The field that was not touched follows the server.
    expect(customer().value).toBe("clinic.test");
  });

  test("a failed save shows the reason and keeps what was typed", async () => {
    const user = userEvent.setup();
    convex
      .mutation(api.workTools.setDomains)
      .mockRejectedValue(
        new ConvexError('"not a domain" is not a domain. Write it like "example.com".'),
      );
    render(<DomainLists />);
    await user.clear(customer());
    await user.type(customer(), "not a domain");
    await user.click(save());
    expect((await screen.findByRole("alert")).textContent).toBe(
      '"not a domain" is not a domain. Write it like "example.com".',
    );
    expect(customer().value).toBe("not a domain");
    expect(screen.queryByText("Saved.")).toBeNull();
  });

  test("while saving, the button is aria-disabled, not disabled, and saves once", async () => {
    const user = userEvent.setup();
    const gate = deferred();
    convex.mutation(api.workTools.setDomains).mockReturnValue(gate.promise);
    render(<DomainLists />);
    await user.click(save());
    expect(save().getAttribute("aria-disabled")).toBe("true");
    expect(save().hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(save());
    await user.click(save());
    expect(convex.mutation(api.workTools.setDomains)).toHaveBeenCalledTimes(1);
    gate.resolve(null);
    expect((await screen.findByRole("status")).textContent).toBe("Saved.");
  });

  test("after a save the field shows the list as the server tidied it", async () => {
    const user = userEvent.setup();
    const view = render(<DomainLists />);
    await user.clear(investor());
    await user.type(investor(), "@Example-Fund.TEST");
    await user.click(save());
    await screen.findByText("Saved.");
    set(["example-fund.test"], ["clinic.test", "hospital.test"]);
    view.rerender(<DomainLists />);
    expect(investor().value).toBe("example-fund.test");
  });

  test("typing during a save is not thrown away when the save lands", async () => {
    const user = userEvent.setup();
    const gate = deferred();
    convex.mutation(api.workTools.setDomains).mockReturnValue(gate.promise);
    render(<DomainLists />);
    await user.click(save());
    await user.type(investor(), "\nlate.test");
    gate.resolve(null);
    await screen.findByRole("status");
    expect(investor().value).toBe("example-fund.test\nlate.test");
  });
});
