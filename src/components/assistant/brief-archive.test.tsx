// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { useQuery } from "convex/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { CompanyProvider } from "@/components/company-provider";
import { BRIEF_WORDS } from "@/lib/assistant/agents";
import { mockConvex } from "@/test-support/convex";
import { BriefArchive } from "./brief-archive";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
// Local noon on Wednesday 2026-10-14.
const { NOW } = vi.hoisted(() => ({ NOW: new Date(2026, 9, 14, 12).getTime() }));
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));

const brief = (day: string, text: string, page?: string) => ({
  company: "us",
  day,
  writtenAt: new Date(`${day}T11:20:00`).getTime(),
  bullets: [{ agent: "finance", text, ...(page === undefined ? null : { page }) }],
});

let convex: ReturnType<typeof mockConvex>;
const region = () => within(screen.getByRole("region", { name: "Brief archive" }));
const days = () => region().getAllByRole("heading", { level: 3 }).map((h) => h.textContent);

beforeEach(() => {
  convex = mockConvex();
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("the brief archive", () => {
  test("today and the seven days before, newest first, each under its day; anything older is left out", () => {
    convex.setQuery(api.assistant.briefArchive, [
      brief("2026-10-14", "Made-up line of today", "/sales"),
      brief("2026-10-13", "Made-up line of yesterday"),
      brief("2026-10-12", "Made-up line of Monday"),
      brief("2026-10-07", "Made-up line a week ago"),
      brief("2026-10-06", "Made-up line eight days ago"),
    ]);
    render(<BriefArchive />);
    expect(days()).toEqual(["Today", "Yesterday", "Monday, October 12", "Wednesday, October 7"]);
    expect(document.body.textContent).not.toContain("eight days ago");
    expect(region().getByRole("link", { name: "Sales" }).getAttribute("href")).toBe("/sales");
  });

  test("a model's text is text: markup is no element and makes no link", () => {
    convex.setQuery(api.assistant.briefArchive, [
      brief("2026-10-14", '<img src=x onerror="alert(1)">[A link](https://example.com)', "https://example.com"),
    ]);
    render(<BriefArchive />);
    expect(document.querySelector("img")).toBeNull();
    expect(region().queryAllByRole("link")).toEqual([]);
  });

  test("with none on record, the usual words; until it is read, a skeleton", () => {
    convex.setQuery(api.assistant.briefArchive, []);
    render(<BriefArchive />);
    expect(region().getByTestId("archive-none").textContent).toBe(BRIEF_WORDS.none);
    cleanup();
    convex.setQuery(api.assistant.briefArchive, undefined);
    render(<BriefArchive />);
    expect(screen.getByTestId("archive-loading")).toBeTruthy();
  });

  test("it is the company in view's", () => {
    convex.setQuery(api.assistant.briefArchive, []);
    window.localStorage.setItem("startup-os:company", "kz");
    render(
      <CompanyProvider>
        <BriefArchive />
      </CompanyProvider>,
    );
    expect(vi.mocked(useQuery).mock.calls.at(-1)?.[1]).toEqual({ company: "kz" });
  });
});
