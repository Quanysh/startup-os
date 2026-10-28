// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { useQuery } from "convex/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { CompanyProvider } from "@/components/company-provider";
import { useNow } from "@/hooks/use-now";
import { BRIEF_FRESH_MS, BRIEF_WORDS } from "@/lib/assistant/agents";
import { briefFooter } from "@/lib/assistant/words";
import { mockConvex } from "@/test-support/convex";
import { TodayBrief } from "./today-brief";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
vi.mock("@/hooks/use-now", () => ({ useNow: vi.fn() }));

// Local noon, so "today" is the 14th in any timezone.
const NOW = new Date(2026, 9, 14, 12).getTime();
const WRITTEN = new Date(2026, 9, 14, 11, 20).getTime();

const HTML = '<img src=x onerror="alert(1)"><b>Bold</b> <a href="https://example.com">a link</a>';
const MARKDOWN = "[A link](https://example.com) and **stars** and `code`";

const brief = (patch: Record<string, unknown> = {}) => ({
  company: "us",
  day: "2026-10-14",
  writtenAt: WRITTEN,
  bullets: [
    { agent: "engineering", text: "Two made-up pull requests waited over three days.", page: "/engineering" },
    { agent: "finance", text: "Cash: not read yet." },
    { agent: "chief_of_staff", text: HTML },
    { agent: "sales", text: MARKDOWN, page: "/sales" },
  ],
  ...patch,
});

let convex: ReturnType<typeof mockConvex>;
const show = () => render(<TodayBrief />);
const region = () => within(screen.getByRole("region", { name: "Brief" }));

beforeEach(() => {
  convex = mockConvex();
  vi.mocked(useNow).mockReturnValue(NOW);
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("the brief on the owner's Today", () => {
  test("a sentence a bullet, each with its agent's chip and its page's link, and who wrote it when", () => {
    convex.setQuery(api.assistant.brief, brief());
    show();
    const items = region().getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0]!.textContent).toContain("Engineering manager");
    expect(items[0]!.textContent).toContain("Two made-up pull requests waited over three days.");
    expect(within(items[0]!).getByRole("link", { name: "Engineering" }).getAttribute("href")).toBe("/engineering");
    expect(items[1]!.textContent).toContain("Finance and compliance");
    expect(within(items[1]!).queryByRole("link")).toBeNull();
    expect(items[2]!.querySelector("[data-slot=kind-tag]")!.textContent).toBe("Chief of staff");
    expect(screen.getByTestId("brief-footer").textContent).toBe(
      "Written by Claude at 11:20 from the OS's figures.",
    );
    expect(screen.getByTestId("brief-footer").textContent).toBe(briefFooter(WRITTEN, NOW));
  });

  test("a model's text is shown as the characters it is: no element, no link, no markdown", () => {
    convex.setQuery(api.assistant.brief, brief());
    show();
    const items = region().getAllByRole("listitem");
    expect(items[2]!.textContent).toContain(HTML);
    expect(items[3]!.textContent).toContain(MARKDOWN);
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("b")).toBeNull();
    expect(document.querySelector("code")).toBeNull();
    // The only links are the way to the Assistant and the ones made from the
    // closed list of the app's pages.
    expect(region().getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "/engineering",
      "/sales",
      "/assistant",
    ]);
  });

  test("a page that is not one of the app's own is not made a link, whatever was stored", () => {
    convex.setQuery(
      api.assistant.brief,
      brief({
        bullets: [
          { agent: "sales", text: "One", page: "https://example.com/phish" },
          { agent: "sales", text: "Two", page: "javascript:alert(1)" },
          { agent: "sales", text: "Three", page: "/payroll" },
        ],
      }),
    );
    show();
    expect(region().getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/assistant"]);
    expect(region().getAllByRole("listitem")).toHaveLength(3);
  });

  test("one written thirty-six hours ago is still shown; a moment older, it is not", () => {
    convex.setQuery(api.assistant.brief, brief({ writtenAt: NOW - BRIEF_FRESH_MS }));
    show();
    expect(region().getAllByRole("listitem")).toHaveLength(4);
    expect(screen.queryByTestId("brief-none")).toBeNull();
    cleanup();

    convex.setQuery(api.assistant.brief, brief({ writtenAt: NOW - BRIEF_FRESH_MS - 1 }));
    show();
    expect(region().queryAllByRole("listitem")).toEqual([]);
    expect(screen.getByTestId("brief-none").textContent).toBe(
      "No brief today yet. The next run is at about 11:20.",
    );
    expect(document.body.textContent).not.toContain("pull requests");
  });

  test("the page's own clock decides: the same brief goes as the clock moves on", () => {
    convex.setQuery(api.assistant.brief, brief());
    const { rerender } = show();
    expect(region().getAllByRole("listitem")).toHaveLength(4);
    vi.mocked(useNow).mockReturnValue(WRITTEN + BRIEF_FRESH_MS + 60_000);
    rerender(<TodayBrief />);
    expect(region().queryAllByRole("listitem")).toEqual([]);
    expect(screen.getByTestId("brief-none").textContent).toBe(BRIEF_WORDS.none);
  });

  test("with none written, it says when the next run is; until it is read, nothing is said", () => {
    convex.setQuery(api.assistant.brief, null);
    show();
    expect(screen.getByTestId("brief-none").textContent).toBe(BRIEF_WORDS.none);
    cleanup();
    convex.setQuery(api.assistant.brief, undefined);
    show();
    expect(screen.getByTestId("brief-loading")).toBeTruthy();
    expect(screen.queryByTestId("brief-none")).toBeNull();
  });

  test("it is the company in view's", () => {
    convex.setQuery(api.assistant.brief, null);
    window.localStorage.setItem("startup-os:company", "kz");
    render(
      <CompanyProvider>
        <TodayBrief />
      </CompanyProvider>,
    );
    const asked = vi.mocked(useQuery).mock.calls.map(([, args]) => args);
    expect(asked.at(-1)).toEqual({ company: "kz" });
  });
});
