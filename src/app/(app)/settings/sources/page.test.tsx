// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { AREAS } from "@convex/lib/roles";
import { ViewerProvider } from "@/components/viewer-provider";
import { useNow } from "@/hooks/use-now";
import { mockConvex } from "@/test-support/convex";
import SourcesPage from "./page";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
vi.mock("@/hooks/use-now", () => ({ useNow: vi.fn() }));
// Their own tests cover them; here they would only ask for more queries.
vi.mock("@/components/manual-entry", () => ({ ManualEntry: () => null }));
vi.mock("@/components/targets-editor", () => ({ TargetsEditor: () => null }));

const NOW = Date.UTC(2026, 9, 12, 12);
const HOUR = 60 * 60 * 1000;

const source = (id: string, label: string, extra: Record<string, unknown> = {}) => ({
  id,
  label,
  kind: "api" as "manual" | "ingest" | "api",
  description: `What ${label} feeds`,
  configured: true,
  fedBy: "pull" as "manual" | "push" | "pull" | null,
  canBackfill: true,
  missingEnv: [] as string[],
  pushEnv: null as string | null,
  status: null as null | {
    state: string;
    lastRunAt: number;
    lastOkAt: number | null;
    message: string | null;
  },
  ...extra,
});
const ran = (state: string, hoursAgo: number, message: string | null = null) => ({
  state,
  lastRunAt: NOW - hoursAgo * HOUR,
  lastOkAt: NOW - 30 * HOUR,
  message,
});

const BANK = source("mercury", "Mercury", { status: ran("ok", 3) });
const SITE = source("vercel", "Vercel", {
  canBackfill: false,
  status: ran("error", 5, "The request was refused."),
});
const TYPED = source("manual", "Manual entry", { kind: "manual", fedBy: "manual" });
const BOOK = source("cfo_workbook", "CFO workbook", { kind: "ingest", fedBy: "push" });
const UNSET = source("posthog", "PostHog", {
  configured: false,
  fedBy: null,
  missingEnv: ["POSTHOG_KEY"],
});

let convex: ReturnType<typeof mockConvex>;
const table = (name: string) => screen.getByRole("table", { name });
const columns = (name: string) =>
  within(table(name))
    .getAllByRole("columnheader")
    .map((th) => th.textContent);
const cells = (name: string, header: string) =>
  within(within(table(name)).getByRole("rowheader", { name: header }).closest("tr")!)
    .getAllByRole("cell")
    .map((td) => td.textContent);

beforeEach(() => {
  convex = mockConvex();
  convex.setQuery(api.sources.list, [BANK, SITE, TYPED, BOOK, UNSET]);
  convex.setQuery(api.sources.recentRuns, []);
  vi.mocked(useNow).mockReturnValue(NOW);
});
afterEach(cleanup);

describe("the sources page: connected sources", () => {
  test("the sources are a table: what each feeds, how it arrives, its last run and its state", () => {
    render(<SourcesPage />);
    expect(columns("Connected sources")).toEqual([
      "Source",
      "Feeds",
      "How it arrives",
      "Last run",
      "State",
      "Actions",
    ]);
    for (const th of within(table("Connected sources")).getAllByRole("columnheader")) {
      expect(th.getAttribute("scope")).toBe("col");
    }
    expect(
      within(table("Connected sources"))
        .getAllByRole("rowheader")
        .map((th) => th.textContent),
    ).toEqual(["Mercury", "Vercel", "Manual entry", "CFO workbook", "PostHog"]);
    // How it arrives now says how often (the manifest's cadence); the last
    // run says whether its numbers are on time (src/lib/source-freshness.ts).
    // Mercury ran 3h ago but last read well 30h ago: late for a daily read.
    expect(cells("Connected sources", "Mercury").slice(0, 4)).toEqual([
      "What Mercury feeds",
      expect.stringMatching(/^SyncedRead daily at about \d\d:00$/),
      "3h agoLate",
      "Working",
    ]);
    expect(cells("Connected sources", "Manual entry")).toEqual([
      "What Manual entry feeds",
      "ManualTyped in when it changes",
      "No runs",
      "Ready",
      "",
    ]);
    expect(cells("Connected sources", "CFO workbook")).toEqual([
      "What CFO workbook feeds",
      "PushedPushed, expected monthly",
      "Not yet",
      "Configured, nothing received yet",
      "",
    ]);
  });

  test("a failed run says so, with its message and when the numbers were last confirmed", () => {
    render(<SourcesPage />);
    const [, , lastRun, state] = cells("Connected sources", "Vercel");
    // "Failed", as the page headers say it for the same run.
    expect(lastRun).toBe("5h agoFailed");
    expect(state).toContain("Last run failed");
    expect(state).toContain("The request was refused.");
    expect(state).toContain("Numbers on screen were last confirmed 1d ago.");
  });

  test("a source with a variable missing names it, and has nothing to run", () => {
    render(<SourcesPage />);
    const row = cells("Connected sources", "PostHog");
    expect(row[2]).toBe("Not yet");
    expect(row[3]).toContain("Not configured");
    expect(row[3]).toContain("POSTHOG_KEY");
    expect(row[4]).toBe("");
  });

  test("only a pulled source can be run, by buttons named for it", async () => {
    const user = userEvent.setup();
    render(<SourcesPage />);
    const row = (label: string) =>
      within(
        within(table("Connected sources")).getByRole("rowheader", { name: label }).closest("tr")!,
      );
    expect(row("Mercury").getByRole("button", { name: "Run now: Mercury" })).toBeTruthy();
    expect(row("Mercury").getByRole("button", { name: /^Backfill \d+ months: Mercury$/ })).toBeTruthy();
    // Every run of this one already reads all the source keeps.
    expect(row("Vercel").queryByRole("button", { name: /Backfill/ })).toBeNull();
    expect(row("Manual entry").queryByRole("button")).toBeNull();
    expect(row("CFO workbook").queryByRole("button")).toBeNull();

    await user.click(row("Mercury").getByRole("button", { name: "Run now: Mercury" }));
    expect(convex.mutation(api.sources.runNow)).toHaveBeenCalledWith({ source: "mercury" });
  });

  test("until the sources are in there is a placeholder and no table", () => {
    convex.setQuery(api.sources.list, undefined);
    render(<SourcesPage />);
    expect(screen.queryByRole("table", { name: "Connected sources" })).toBeNull();
  });
});

describe("the sources page: recent runs", () => {
  test("with no runs it is a sentence, not an empty table", () => {
    render(<SourcesPage />);
    expect(screen.getByText("No pushes or syncs yet. They are listed here as they happen.")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Recent runs" })).toBeNull();
  });

  test("each run is a row: its source, its result, what it wrote and when", () => {
    convex.setQuery(api.sources.recentRuns, [
      {
        id: "r1",
        source: "mercury",
        batchId: null,
        startedAt: NOW - 2 * HOUR,
        finishedAt: NOW - 2 * HOUR,
        status: "ok",
        message: null,
        inserted: 4,
        updated: 1,
        unchanged: 0,
      },
      {
        id: "r2",
        source: "vercel",
        batchId: null,
        startedAt: NOW - 26 * HOUR,
        finishedAt: NOW - 26 * HOUR,
        status: "error",
        message: "The request was refused.",
        inserted: 0,
        updated: 0,
        unchanged: 0,
      },
    ]);
    render(<SourcesPage />);
    expect(columns("Recent runs")).toEqual(["Source", "Result", "New", "Changed", "Same", "When"]);
    expect(cells("Recent runs", "Mercury")).toEqual(["OK", "4", "1", "0", "2h ago"]);
    expect(cells("Recent runs", "Vercel")).toEqual([
      "FailedThe request was refused.",
      "0",
      "0",
      "0",
      "1d ago",
    ]);
    const count = within(table("Recent runs")).getByRole("cell", { name: "4" });
    expect(count.className).toContain("text-right");
    expect(count.className).toContain("font-num");
  });
});

// A teammate who was given "Sources and Telegram" is sent their companies'
// sources only (convex/sources.ts). The page says so, so a short list is not
// taken for a broken one.
describe("who is reading the page", () => {
  const NOTE =
    "You see the sources that serve Globex. The owner's own work tools (mail, calendar, Linear and Fireflies) are not listed here.";

  test("a teammate on one company is told whose sources they see, and that the owner's work tools are not here", () => {
    convex.setQuery(api.sources.list, [BOOK]);
    convex.setQuery(api.sources.recentRuns, []);
    render(
      <ViewerProvider
        viewer={{ role: "engineer", companies: ["kz"], areas: ["settings"], email: null, name: null }}
      >
        <SourcesPage />
      </ViewerProvider>,
    );
    expect(screen.getByText(NOTE)).toBeTruthy();
  });

  test("a teammate on both is told of both", () => {
    convex.setQuery(api.sources.list, [BOOK]);
    convex.setQuery(api.sources.recentRuns, []);
    render(
      <ViewerProvider
        viewer={{
          role: "engineer",
          companies: ["us", "kz"],
          areas: ["settings"],
          email: null,
          name: null,
        }}
      >
        <SourcesPage />
      </ViewerProvider>,
    );
    expect(
      screen.getByText(/^You see the sources that serve Startup and Globex\. The owner's own work tools/),
    ).toBeTruthy();
  });

  test("the owner's four work tools are not rows here: their state is on Settings › Connections, once", () => {
    const tools = ["gmail", "google_calendar", "linear", "fireflies"].map((id) => source(id, `Tool ${id}`));
    convex.setQuery(api.sources.list, [BANK, ...tools]);
    convex.setQuery(api.sources.recentRuns, []);
    render(
      <ViewerProvider
        viewer={{ role: "owner", companies: ["us", "kz"], areas: AREAS, email: null, name: null }}
      >
        <SourcesPage />
      </ViewerProvider>,
    );
    expect(
      within(table("Connected sources"))
        .getAllByRole("rowheader")
        .map((th) => th.textContent),
    ).toEqual(["Mercury"]);
    expect(screen.getByRole("link", { name: "Settings › Connections" }).getAttribute("href")).toBe(
      "/settings/connections",
    );
  });

  test("the owner, who is sent every source, is told nothing of the kind", () => {
    convex.setQuery(api.sources.list, [BOOK]);
    convex.setQuery(api.sources.recentRuns, []);
    render(
      <ViewerProvider
        viewer={{ role: "owner", companies: ["us", "kz"], areas: AREAS, email: null, name: null }}
      >
        <SourcesPage />
      </ViewerProvider>,
    );
    expect(screen.queryByText(/^You see the sources that serve/)).toBeNull();
  });
});
