// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { NO_LINKS_OR_CONTACTS, presentIntel, type StoredIntel } from "@convex/lib/dealIntel";
import { areasOf, type Area, type Role } from "@convex/lib/roles";
import { ViewerProvider } from "@/components/viewer-provider";
import type { CompanyId } from "@/lib/company";
import { DEAL_COLUMNS } from "@/lib/pipeline/stages";
import { mockConvex } from "@/test-support/convex";
import { DealPage } from "./deal-page";

// One US deal's page: what research found about it, its next best action,
// and both editors. Startup's deals only.

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
const { NOW, replace } = vi.hoisted(() => ({ NOW: Date.UTC(2026, 9, 15, 12), replace: { fn: (_url: string) => {} } }));
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: (url: string) => replace.fn(url) }) }));

const DAY = 24 * 60 * 60 * 1000;
const ARTIFACT = "https://claude.ai/artifact/made-up-1";

const card = (extra: Record<string, unknown> = {}) => ({
  id: "deal1",
  market: "us",
  mirrored: false,
  source: "manual",
  name: "Sample Bone and Joint",
  contact: "Robin Sample",
  stage: "qualified",
  sourceStage: null,
  amount: 2400,
  lastActivityAt: NOW - 3 * DAY,
  closedAt: null,
  nextStep: null,
  notes: "Made-up note",
  priority: "high",
  region: "OH",
  physicians: 59,
  locations: 29,
  sources: [],
  ...extra,
});
const boardOf = (cards: ReturnType<typeof card>[]) =>
  Object.fromEntries(
    [...DEAL_COLUMNS.map((c) => c.id), "unmapped"].map((stage) => [stage, cards.filter((c) => c.stage === stage)]),
  );

const FULL: StoredIntel = {
  summary: "Made-up summary.\n\nA second paragraph.",
  ownership: "Physician-owned",
  ehr: "Sample EHR",
  pm: "Sample PM",
  billingModel: "outsourced",
  rcmVendor: "Placeholder RCM",
  specialties: ["Spine", "Hand"],
  ancillaries: ["MRI"],
  workersComp: "About a fifth of visits",
  competitors: [{ name: "Placeholder RCM", note: "The incumbent" }],
  signals: [
    { date: "2026-05", kind: "growth", text: "Opened a site", source: "Sample paper" },
    { date: "2026-09-02", kind: "hiring", text: "Hiring a director", source: "Sample job board" },
  ],
  people: [{ name: "Dr. Robin Sample", role: "Managing partner", note: "Signs off on vendors" }],
  painPoints: ["Prior authorizations"],
  talkingPoints: ["Imaging denials"],
  risks: ["Bound to the incumbent"],
  angle: "Lead with prior authorizations.",
  nextBestAction: "Ask for twenty minutes with the billing lead",
  fit: { score: 84, reasons: ["Large group", "Outsourced billing"] },
  sources: [{ title: "Made-up market scan", url: ARTIFACT }],
  researchedAt: "2026-10-01",
  updatedAt: 1,
};

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  vi.mocked(useQuery).mockClear();
  convex = mockConvex();
  convex.setQuery(api.deals.board, boardOf([card()]));
  convex.setQuery(api.dealIntel.get, presentIntel(FULL));
  replace.fn = vi.fn();
});
afterEach(cleanup);

const as = (role: Role = "sales", companies: CompanyId[] = ["us"], dealId = "deal1") =>
  render(
    <ViewerProvider viewer={{ role, companies, areas: areasOf(role), email: null, name: null }}>
      <DealPage dealId={dealId} />
    </ViewerProvider>,
  );
const region = (name: string) => screen.getByRole("region", { name });
const sent = (name: string) =>
  vi
    .mocked(useQuery)
    .mock.calls.filter(([ref, args]) => getFunctionName(ref as never) === name && args !== "skip")
    .map(([, args]) => args);

describe("a US deal's page", () => {
  test("the header: name, stage, priority, where it is, how big, who owns it, its fit and when researched", () => {
    as();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Sample Bone and Joint");
    expect(screen.getByText("Qualified")).toBeTruthy();
    expect(screen.getByText("High priority")).toBeTruthy();
    expect(screen.getByText("OH")).toBeTruthy();
    expect(screen.getByText("59 physicians, 29 locations")).toBeTruthy();
    expect(screen.getByText("Physician-owned")).toBeTruthy();
    expect(screen.getByText("Researched Oct 1, 2026")).toBeTruthy();
    const fit = screen.getByRole("button", { name: "Fit 84 of 100" });
    // Its reasons are what describes it: on hover, on focus, and on a press.
    const reasons = screen.getByRole("tooltip", { hidden: true });
    expect(fit.getAttribute("aria-describedby")).toBe(reasons.id);
    expect(within(reasons).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Large group",
      "Outsourced billing",
    ]);
    expect(sent("dealIntel:get")).toEqual([{ dealId: "deal1" }]);
  });

  test("every section, in its words: signals newest first, people by initials, sources as links", () => {
    as();
    expect(within(region("Summary")).getByText(/A second paragraph/)).toBeTruthy();
    expect(within(region("Summary")).getByText("Lead with prior authorizations.")).toBeTruthy();
    const signals = within(region("Signals")).getAllByRole("listitem");
    expect(signals.map((li) => li.textContent)).toEqual([
      "Sep 2, 2026HiringHiring a directorSource: Sample job board",
      "May 2026GrowthOpened a siteSource: Sample paper",
    ]);
    const person = within(region("People")).getByRole("listitem");
    expect(person.textContent).toBe("RSDr. Robin SampleManaging partnerSigns off on vendors");
    const tech = region("Tech and billing");
    for (const text of ["Sample EHR", "Sample PM", "Outsourced", "Placeholder RCM", "Spine", "MRI", "About a fifth of visits"]) {
      expect(within(tech).getByText(text)).toBeTruthy();
    }
    expect(within(region("Competitors")).getByText("The incumbent")).toBeTruthy();
    const points = region("Pain points, talking points and risks");
    expect(within(points).getByText("Prior authorizations")).toBeTruthy();
    expect(within(points).getByText("Bound to the incumbent")).toBeTruthy();
    const link = within(region("Sources")).getByRole("link", { name: /Made-up market scan/ });
    expect(link.getAttribute("href")).toBe(ARTIFACT);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
    expect(within(region("On the board")).getByText("Robin Sample")).toBeTruthy();
    expect(within(region("On the board")).getByText("3 days ago")).toBeTruthy();
  });

  test("a section with nothing in it is left out", () => {
    convex.setQuery(api.dealIntel.get, presentIntel({ ehr: "Sample EHR", updatedAt: 1 }));
    as();
    expect(region("Tech and billing")).toBeTruthy();
    for (const name of ["Summary", "Signals", "People", "Competitors", "Sources", "Next best action"]) {
      expect(screen.queryByRole("region", { name })).toBeNull();
    }
    expect(screen.queryByRole("button", { name: /^Fit/ })).toBeNull();
  });

  test("a deal with no research says so in one line, and offers to add it", async () => {
    convex.setQuery(api.dealIntel.get, null);
    const user = userEvent.setup();
    as();
    expect(screen.getByText("No research on this deal yet.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Summary" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add intelligence" }));
    expect(screen.getByRole("dialog", { name: "Sales intelligence" })).toBeTruthy();
  });

  test("the next best action becomes the deal's next step, through deals.update", async () => {
    const user = userEvent.setup();
    as();
    const band = region("Next best action");
    expect(within(band).getByText("The deal has no next step yet.")).toBeTruthy();
    await user.click(within(band).getByRole("button", { name: "Make it the next step" }));
    expect(convex.mutation(api.deals.update)).toHaveBeenCalledWith({
      id: "deal1",
      nextStep: "Ask for twenty minutes with the billing lead",
    });
  });

  test("once it is the next step, the band says so; a refusal is said in the server's words", async () => {
    convex.setQuery(api.deals.board, boardOf([card({ nextStep: "Ask for twenty minutes with the billing lead" })]));
    as();
    expect(within(region("Next best action")).getByText("It is the next step")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Make it the next step" })).toBeNull();
    cleanup();

    convex.setQuery(api.deals.board, boardOf([card({ nextStep: "Old step" })]));
    convex.mutation(api.deals.update).mockRejectedValueOnce(new ConvexError("That deal is no longer on the board."));
    const user = userEvent.setup();
    as();
    expect(screen.getByText("Next step now: Old step")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Make it the next step" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That deal is no longer on the board.");
  });

  test("text from research is shown as text, and a link that is not an artifact's is no link", () => {
    convex.setQuery(
      api.dealIntel.get,
      presentIntel({
        summary: '<img src=x onerror="alert(1)"> [click](https://example.test)',
        sources: [{ title: "Sneaked in", url: "javascript:alert(1)" }],
        updatedAt: 1,
      }),
    );
    as();
    const summary = region("Summary");
    expect(summary.querySelector("img")).toBeNull();
    expect(within(summary).queryByRole("link")).toBeNull();
    expect(within(summary).getByText(/<img src=x/)).toBeTruthy();
    expect(within(region("Sources")).queryByRole("link")).toBeNull();
    expect(within(region("Sources")).getByText("Sneaked in")).toBeTruthy();
  });

  test("Edit details opens the deal's editor with its details; a save goes to deals.update", async () => {
    const user = userEvent.setup();
    as();
    await user.click(screen.getByRole("button", { name: "Edit details" }));
    const dialog = screen.getByRole("dialog");
    expect((within(dialog).getByLabelText("Region") as HTMLInputElement).value).toBe("OH");
    await user.selectOptions(within(dialog).getByLabelText("Priority"), "medium");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(convex.mutation(api.deals.update)).toHaveBeenCalledWith({ id: "deal1", priority: "medium" });
  });

  test("deleting the deal from its editor goes back to Sales", async () => {
    const user = userEvent.setup();
    as();
    await user.click(screen.getByRole("button", { name: "Edit details" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(convex.mutation(api.deals.remove)).toHaveBeenCalledWith({ id: "deal1" });
    expect(replace.fn).toHaveBeenCalledWith("/sales");
  });

  test("Edit intelligence sends only what changed, and refuses before sending what the server would", async () => {
    const user = userEvent.setup();
    as();
    await user.click(screen.getByRole("button", { name: "Edit intelligence" }));
    let dialog = screen.getByRole("dialog", { name: "Sales intelligence" });
    expect((within(dialog).getByLabelText("EHR") as HTMLInputElement).value).toBe("Sample EHR");
    expect((within(dialog).getByLabelText("Signal 1: kind") as HTMLSelectElement).value).toBe("growth");

    await user.clear(within(dialog).getByLabelText("Summary"));
    await user.click(within(dialog).getByLabelText("Summary"));
    await user.paste("Write to someone@example.test");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(within(dialog).getByRole("alert").textContent).toBe(NO_LINKS_OR_CONTACTS);
    expect(convex.mutation(api.dealIntel.update)).not.toHaveBeenCalled();

    await user.clear(within(dialog).getByLabelText("Summary"));
    await user.clear(within(dialog).getByLabelText("EHR"));
    await user.click(within(dialog).getByLabelText("EHR"));
    await user.paste("Placeholder EHR");
    await user.click(within(dialog).getByRole("button", { name: "Add a competitor" }));
    await user.click(within(dialog).getByLabelText("Competitor 2: name"));
    await user.paste("Mock Billing Suite");
    await user.click(within(dialog).getByRole("button", { name: "Remove person 1" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(convex.mutation(api.dealIntel.update)).toHaveBeenCalledWith({
      dealId: "deal1",
      summary: null,
      ehr: "Placeholder EHR",
      competitors: [
        { name: "Placeholder RCM", note: "The incumbent" },
        { name: "Mock Billing Suite", note: null },
      ],
      people: null,
    });
    dialog = screen.queryByRole("dialog") as HTMLElement;
    expect(dialog).toBeNull();
  });

  test("a deal not on the US board is said in one line", () => {
    as("sales", ["us"], "gone");
    expect(screen.getByRole("heading", { name: "This deal is not on the board" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sales" }).getAttribute("href")).toBe("/sales");
  });

  test("someone on Globex alone is told it is Startup's, and nothing is asked for", () => {
    as("sales", ["kz"]);
    expect(screen.getByRole("heading", { name: "Nothing here for Globex" })).toBeTruthy();
    expect(sent("dealIntel:get")).toEqual([]);
    expect(sent("deals:board")).toEqual([]);
  });
});

describe("a won deal on Customers", () => {
  const withAreas = (areas: Area[]) =>
    render(
      <ViewerProvider viewer={{ role: "sales", companies: ["us"], areas, email: null, name: null }}>
        <DealPage dealId="deal1" />
      </ViewerProvider>,
    );

  test("says it is on Customers, with a link there for a viewer who has Customers", () => {
    convex.setQuery(api.deals.board, boardOf([card({ stage: "won" })]));
    convex.setQuery(api.customers.ofDeal, { onCustomers: true });
    withAreas(["sales", "customers"]);
    expect(screen.getByRole("link", { name: "On Customers" }).getAttribute("href")).toBe("/customers");
    expect(sent("customers:ofDeal")).toEqual([{ dealId: "deal1" }]);
  });

  test("a viewer without Customers reads the words, with no link", () => {
    convex.setQuery(api.deals.board, boardOf([card({ stage: "won" })]));
    convex.setQuery(api.customers.ofDeal, { onCustomers: true });
    withAreas(["sales"]);
    expect(screen.getByText("On Customers")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "On Customers" })).toBeNull();
  });

  test("a deal not on Customers says nothing of it", () => {
    convex.setQuery(api.customers.ofDeal, { onCustomers: false });
    withAreas(["sales", "customers"]);
    expect(screen.queryByText("On Customers")).toBeNull();
  });

  test("someone not on Startup asks nothing", () => {
    as("sales", ["kz"]);
    expect(sent("customers:ofDeal")).toEqual([]);
  });
});
