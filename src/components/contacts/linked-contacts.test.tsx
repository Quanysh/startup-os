// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { ViewerProvider } from "@/components/viewer-provider";
import { mockConvex } from "@/test-support/convex";
import { LinkedContacts } from "./linked-contacts";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
});
afterEach(cleanup);

const contact = {
  id: "c1",
  name: "Jane Example",
  emails: ["jane@example.test"],
  phone: null,
  linkedin: null,
  org: "Initech Health",
  title: null,
  company: "us",
  category: "investor" as const,
  linkedRecords: [{ type: "investor" as const, id: "inv1" }],
  howMet: null,
  introducedBy: null,
  canIntroTo: [],
  lastContactAt: null,
  interactionCount: 0,
  owner: null,
  notes: null,
  normalizedName: "jane example",
  createdAt: 1,
  updatedAt: 1,
};

describe("LinkedContacts", () => {
  test("someone without the contacts area is shown nothing, and the query is not sent", () => {
    convex.setQuery(api.contacts.forRecord, [contact]);
    const { container } = render(
      <ViewerProvider viewer={{ role: "sales", companies: ["us"], areas: ["sales"], email: null, name: null }}>
        <LinkedContacts company="us" type="investor" recordId="inv1" />
      </ViewerProvider>,
    );
    expect(container.textContent).toBe("");
    const asked = vi.mocked(useQuery).mock.calls.map((call) => getFunctionName(call[0] as never));
    expect(asked).not.toContain("contacts:forRecord");
  });

  test("shows a linked contact and unlinks it", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.contacts.forRecord, [contact]);
    render(<LinkedContacts company="us" type="investor" recordId="inv1" />);
    expect(screen.getByRole("region", { name: "Linked contacts" })).toBeDefined();
    expect(screen.getByText("Jane Example")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Unlink" }));
    expect(convex.mutation(api.contacts.link)).toHaveBeenCalledWith({
      contactId: "c1",
      type: "investor",
      id: "inv1",
      linked: false,
    });
  });
});
