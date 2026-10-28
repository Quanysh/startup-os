// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { CompanyProvider } from "@/components/company-provider";
import { ViewerProvider } from "@/components/viewer-provider";
import { agreement, answer, control, evidenceItem, questionnaire } from "@/lib/compliance/fixtures";
import { mockConvex } from "@/test-support/convex";
import { AgreementsTab } from "./agreements-tab";
import { AnswerBankTab } from "./answer-bank-tab";
import { EvidenceTab } from "./evidence-tab";
import { QuestionnairesTab } from "./questionnaires-tab";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
vi.mock("@/components/freshness/freshness-indicator", () => ({
  TypedFreshness: ({ label }: { label: string }) => <p>{`freshness of ${label}`}</p>,
}));

const TODAY = "2026-10-18";
const NOW = Date.UTC(2026, 9, 18, 12);
let convex: ReturnType<typeof mockConvex>;

function show(ui: ReactElement, companies: ("us" | "kz")[] = ["us", "kz"]) {
  window.localStorage.setItem("startup-os:company", "us");
  return render(
    <ViewerProvider viewer={{ role: "cofounder", companies, areas: ["compliance"], email: "me@example.com", name: null }}>
      <CompanyProvider allowed={companies}>{ui}</CompanyProvider>
    </ViewerProvider>,
  );
}

beforeEach(() => {
  convex = mockConvex();
});
afterEach(cleanup);

const BANNED = /\bcompliant\b|\bcertified\b|\bcovered\b/i;

describe("questionnaires", () => {
  test("shows a skeleton until the rows arrive", () => {
    const { container } = show(<QuestionnairesTab today={TODAY} now={NOW} />);
    expect(container.querySelector("[aria-busy]")).not.toBeNull();
  });

  test("counts by status, calls an open late one overdue, and links the document", () => {
    convex.setQuery(api.evidence.questionnaires, [
      questionnaire({ requester: "Initech Health", dueOn: "2026-10-10", link: "https://docs.example.com/q", changedBy: "Claude Code" }),
      questionnaire({ requester: "Beta Clinic", dueOn: "2026-10-10", status: "sent" }),
      questionnaire({ requester: "Kz Only", company: "kz" }),
    ]);
    show(<QuestionnairesTab today={TODAY} now={NOW} />);
    const summary = within(screen.getByRole("region", { name: "Questionnaire summary" }));
    expect(summary.getByText("Overdue").nextSibling?.textContent).toBe("1");
    // Only Startup's: the company in view is Startup.
    expect(screen.queryByText("Kz Only")).toBeNull();
    expect(screen.getByText("Overdue by 8 days")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Document/ }).getAttribute("href")).toBe("https://docs.example.com/q");
    expect(screen.getByText("Changed by Claude Code")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(BANNED);
  });

  test("adding one sends the fields, clears nothing it was not given, and refuses an http link before sending", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.evidence.questionnaires, []);
    show(<QuestionnairesTab today={TODAY} now={NOW} />);
    await user.click(screen.getByRole("button", { name: "Add a questionnaire" }));
    await user.type(screen.getByLabelText("Requester"), "Initech");
    await user.type(screen.getByLabelText("Document link"), "http://x.example.com");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("A document link must be a full https:// address.");
    expect(convex.mutation(api.evidence.questionnaireUpsert)).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText("Document link"));
    await user.type(screen.getByLabelText("Document link"), "https://docs.example.com/q");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(convex.mutation(api.evidence.questionnaireUpsert)).toHaveBeenCalledWith({
      requester: "Initech",
      company: "us",
      status: "todo",
      receivedOn: null,
      dueOn: null,
      owner: null,
      link: "https://docs.example.com/q",
      notes: null,
    });
  });

  test("a refusal from the server is shown", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.evidence.questionnaires, []);
    convex.mutation(api.evidence.questionnaireUpsert).mockRejectedValueOnce(new ConvexError("The due date is not a date."));
    show(<QuestionnairesTab today={TODAY} now={NOW} />);
    await user.click(screen.getByRole("button", { name: "Add a questionnaire" }));
    await user.type(screen.getByLabelText("Requester"), "Initech");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The due date is not a date.");
  });
});

describe("vendor agreements", () => {
  test("an active one past its end is danger, one within 60 days warns, and a draft is only its status", () => {
    convex.setQuery(api.evidence.agreements, [
      agreement({ vendor: "Gone Co", expiresOn: "2026-10-01" }),
      agreement({ vendor: "Soon Co", expiresOn: "2026-11-20" }),
      agreement({ vendor: "Later Co", expiresOn: "2027-09-01" }),
      agreement({ vendor: "Draft Co", status: "draft", expiresOn: "2026-10-20" }),
    ]);
    const { container } = show(<AgreementsTab today={TODAY} now={NOW} />);
    const row = (vendor: string) => screen.getByText(vendor).closest("tr")!;
    expect(row("Gone Co").getAttribute("data-tone")).toBe("danger");
    expect(within(row("Gone Co")).getByText(/^Expired 17 days ago/)).toBeTruthy();
    expect(within(row("Soon Co")).getByText(/^Expires in 33 days/)).toBeTruthy();
    expect(row("Draft Co").getAttribute("data-tone")).toBeNull();
    const summary = within(screen.getByRole("region", { name: "Agreement summary" }));
    expect(summary.getByText("Past the expiry date").nextSibling?.textContent).toBe("1");
    expect(summary.getByText("Ending in 60 days").nextSibling?.textContent).toBe("1");
    expect(container.textContent).not.toMatch(BANNED);
  });

  test("saving sends dates as null when blank, and refuses an end before the start", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.evidence.agreements, []);
    show(<AgreementsTab today={TODAY} now={NOW} />);
    await user.click(screen.getByRole("button", { name: "Add an agreement" }));
    await user.type(screen.getByLabelText("Vendor"), "Initech Cloud");
    await user.type(screen.getByLabelText("Signed"), "2026-05-01");
    await user.type(screen.getByLabelText("Renews or expires"), "2026-04-01");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("An agreement cannot expire before it was signed.");
    await user.clear(screen.getByLabelText("Renews or expires"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(convex.mutation(api.evidence.agreementUpsert)).toHaveBeenCalledWith(
      expect.objectContaining({ vendor: "Initech Cloud", type: "baa", signedOn: "2026-05-01", expiresOn: null, link: null }),
    );
  });
});

describe("answer bank", () => {
  test("cards can be searched by question, answer and tag; a Globex answer is not in Startup's view", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.evidence.answers, [
      answer({ question: "Do you encrypt data at rest?", answer: "Yes, AES-256.", tags: ["encryption"], lastReviewedOn: "2026-10-01" }),
      answer({ question: "Where is data kept?", answer: "In the US.", tags: ["residency"] }),
      answer({ question: "Kazakh question", company: "kz" }),
    ]);
    show(<AnswerBankTab today={TODAY} now={NOW} />);
    expect(screen.queryByText("Kazakh question")).toBeNull();
    expect(screen.getByText(/Reviewed Oct 1/)).toBeTruthy();
    await user.type(screen.getByRole("searchbox", { name: "Search the answer bank" }), "residency");
    expect(screen.queryByText("Do you encrypt data at rest?")).toBeNull();
    expect(screen.getByText("Where is data kept?")).toBeTruthy();
    await user.clear(screen.getByRole("searchbox", { name: "Search the answer bank" }));
    await user.type(screen.getByRole("searchbox", { name: "Search the answer bank" }), "zzz");
    expect(screen.getByText("No answer matches that search.")).toBeTruthy();
  });

  test("tags are sent as a list", async () => {
    const user = userEvent.setup();
    convex.setQuery(api.evidence.answers, []);
    show(<AnswerBankTab today={TODAY} now={NOW} />);
    await user.click(screen.getByRole("button", { name: "Add an answer" }));
    await user.type(screen.getByLabelText("Question"), "Q?");
    await user.type(screen.getByLabelText("Approved answer"), "A.");
    await user.type(screen.getByLabelText("Tags"), "one, two ,, three");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(convex.mutation(api.evidence.answerUpsert)).toHaveBeenCalledWith({
      question: "Q?",
      answer: "A.",
      tags: ["one", "two", "three"],
      company: null,
      lastReviewedOn: null,
    });
  });
});

describe("evidence", () => {
  const rows = () => [
    control({ controlId: "CC1.1", title: "Integrity", items: [evidenceItem({ title: "Policy", link: "https://d.example.com/p", validUntil: "2027-01-01" })] }),
    control({ controlId: "CC1.2", title: "Oversight", items: [evidenceItem({ title: "Old minutes", validUntil: "2026-01-01" })] }),
    control({ controlId: "CC1.3", title: "Authority" }),
    control({ framework: "hipaa", controlId: "164.308", title: "Risk analysis", items: [evidenceItem({ status: "accepted" })] }),
  ];

  test("per-framework tally of controls with valid evidence, and an expired item reads as expired", () => {
    convex.setQuery(api.evidence.controls, rows());
    const { container } = show(<EvidenceTab today={TODAY} now={NOW} />);
    const summary = within(screen.getByRole("region", { name: "Evidence summary" }));
    expect(summary.getByText("SOC 2").nextSibling?.textContent).toBe("1 of 3");
    expect(summary.getByText("HIPAA").nextSibling?.textContent).toBe("1 of 1");
    const expired = screen.getByText("Old minutes").closest("div")!;
    expect(within(expired).getByText("Expired")).toBeTruthy();
    expect(screen.getByText("No evidence yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Policy/ }).getAttribute("href")).toBe("https://d.example.com/p");
    expect(container.textContent).not.toMatch(BANNED);
    expect(container.querySelector(".text-good, .bg-good")).toBeNull();
  });

  test("adding evidence to a control sends its id; an end before collection is refused", async () => {
    const user = userEvent.setup();
    const list = rows();
    convex.setQuery(api.evidence.controls, list);
    show(<EvidenceTab today={TODAY} now={NOW} />);
    await user.click(screen.getByRole("button", { name: "Add evidence to CC1.3" }));
    await user.type(screen.getByLabelText("Title"), "Screenshot");
    await user.type(screen.getByLabelText("Collected"), "2026-09-01");
    await user.type(screen.getByLabelText("Valid until"), "2026-08-01");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Evidence cannot be valid until before it was collected.");
    await user.clear(screen.getByLabelText("Valid until"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(convex.mutation(api.evidence.evidenceItemUpsert)).toHaveBeenCalledWith(
      expect.objectContaining({ controlId: list[2]!.id, title: "Screenshot", status: "collected", validUntil: null }),
    );
  });

  test("someone on Globex alone gets ISO 27001 and none of Startup's frameworks", () => {
    convex.setQuery(api.evidence.controls, []);
    window.localStorage.setItem("startup-os:company", "kz");
    render(
      <ViewerProvider viewer={{ role: "cofounder", companies: ["kz"], areas: ["compliance"], email: "me@example.com", name: null }}>
        <CompanyProvider allowed={["kz"]}>
          <EvidenceTab today={TODAY} now={NOW} />
        </CompanyProvider>
      </ViewerProvider>,
    );
    expect(screen.getByRole("heading", { name: "ISO 27001" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "HIPAA" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "SOC 2" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Add a control" })).toHaveLength(1);
  });
});
