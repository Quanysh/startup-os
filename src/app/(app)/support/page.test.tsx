// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import type { Area } from "@convex/lib/roles";
import type { SupportRowView } from "@convex/lib/supportMetrics";
import { ViewerProvider } from "@/components/viewer-provider";
import { useNow } from "@/hooks/use-now";
import { mockConvex } from "@/test-support/convex";
import SupportPage from "./page";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
vi.mock("@/hooks/use-now", () => ({ useNow: vi.fn() }));

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Saturday 2026-10-17, 09:00 UTC. */
const NOW = Date.parse("2026-10-17T09:00:00Z");
const APP = "made0up1";

let next = 1;
function chat(over: Partial<SupportRowView> = {}): SupportRowView {
  return {
    intercomId: String(900 + next++),
    createdAt: NOW - 6 * HOUR,
    updatedAt: NOW - 5 * HOUR,
    state: "open",
    open: true,
    waitingSince: NOW - 60_000 - 5 * HOUR - 12 * 60 * 1000,
    origin: "customer",
    pageArea: "studies/report",
    finParticipated: true,
    finOutcome: "escalated",
    humanRepliedAt: null,
    timeToHumanReply: null,
    lastCustomerReplyAt: NOW - 5 * HOUR,
    lastHumanReplyAt: null,
    assigneeId: null,
    assigneeName: null,
    articles: [],
    ...over,
  };
}

/** The daily push, a minute ago unless a test says otherwise. */
const OK = { state: "ok", lastRunAt: NOW - 60_000, lastOkAt: NOW - 60_000, failure: null } as const;
const overview = (rows: SupportRowView[], over: Record<string, unknown> = {}) => ({
  configured: true,
  appId: APP,
  status: OK,
  rows,
  ...over,
});

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  convex = mockConvex();
  vi.mocked(useNow).mockReturnValue(NOW);
});
afterEach(cleanup);

function show(areas: Area[] = ["support"], companies: ("us" | "kz")[] = ["kz"]) {
  return render(
    <ViewerProvider viewer={{ role: "sales", companies, areas, email: "someone@example.test", name: null }}>
      <SupportPage />
    </ViewerProvider>,
  );
}

const asked = () =>
  vi.mocked(useQuery).mock.calls.filter(([ref, args]) => getFunctionName(ref as never) === "support:overview" && args !== "skip");

describe("the Support page", () => {
  test("placeholders, and no figure, until the inbox and the clock are in", () => {
    convex.setQuery(api.support.overview, undefined);
    const { container } = show();
    expect(screen.getByRole("heading", { level: 1, name: "Support" })).toBeTruthy();
    expect(container.querySelector("[aria-busy]")).not.toBeNull();
    cleanup();
    convex.setQuery(api.support.overview, overview([chat()]));
    vi.mocked(useNow).mockReturnValue(null);
    const again = show();
    expect(again.container.querySelector("[aria-busy]")).not.toBeNull();
    expect(screen.queryByText("Waiting on a person")).toBeNull();
  });

  test("before the push token is set: how to set up the daily task, and no figure", () => {
    convex.setQuery(api.support.overview, {
      configured: false,
      appId: null,
      status: { state: null, lastRunAt: null, lastOkAt: null, failure: null },
      rows: [],
    });
    show();
    const setup = screen.getByRole("region", { name: "Connect Intercom" });
    expect(setup.textContent).toContain("Set up the daily Intercom task on the owner's Mac (docs/setup.md, “Intercom”)");
    expect(setup.textContent).toContain("INGEST_TOKEN_INTERCOM");
    expect(setup.textContent).not.toContain("Developer Hub");
    expect(screen.queryByRole("list", { name: "Key figures" })).toBeNull();
  });

  test("once chats have arrived, no setup panel: a quiet line by the freshness says no new push can arrive", () => {
    convex.setQuery(api.support.overview, overview([chat()], { configured: false }));
    show();
    expect(screen.queryByRole("region", { name: "Connect Intercom" })).toBeNull();
    const header = screen.getByRole("banner");
    expect(header.textContent).toContain("Push token not set: no new push can arrive");
    expect(screen.getByRole("list", { name: "Key figures" })).toBeTruthy();
  });

  test("with the token set, no such line", () => {
    convex.setQuery(api.support.overview, overview([chat()]));
    show();
    expect(screen.queryByText(/Push token not set/)).toBeNull();
    expect(screen.queryByRole("region", { name: "Connect Intercom" })).toBeNull();
  });

  test("set but nothing pushed yet: said so, and nothing reads as zero", () => {
    convex.setQuery(api.support.overview, overview([], { appId: null, status: { state: null, lastRunAt: null, lastOkAt: null, failure: null } }));
    show();
    expect(screen.getByText(/Waiting for the first push from the daily Intercom task/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Key figures" })).toBeNull();
  });

  test("no chats at all: one quiet line", () => {
    convex.setQuery(api.support.overview, overview([]));
    show();
    expect(screen.getByText("No chats in the last 90 days.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  test("the key figures: who waits (in the danger tone, with the longest wait), open chats, reply time, Fin's share", () => {
    convex.setQuery(
      api.support.overview,
      overview([
        chat(),
        chat({ finOutcome: "assumed_resolution" }),
        chat({ finOutcome: "assumed_resolution", state: "closed", open: false, timeToHumanReply: 1800 }),
      ]),
    );
    show();
    const strip = screen.getByRole("list", { name: "Key figures" });
    const figure = (label: string) => within(strip).getByText(label).closest("li")!;
    expect(figure("Waiting on a person").textContent).toContain("1");
    expect(figure("Waiting on a person").textContent).toContain("Longest 5 h 12 min");
    expect(figure("Waiting on a person").querySelector("[data-tone=danger]")).not.toBeNull();
    expect(figure("Open customer chats").textContent).toContain("2");
    expect(figure("First reply by a person, median").textContent).toContain("30 min");
    expect(figure("Resolved by Fin").textContent).toContain("67%");
  });

  test("a figure that cannot be known says so, never 0", () => {
    convex.setQuery(api.support.overview, overview([chat({ finParticipated: false, finOutcome: null })]));
    show();
    const strip = screen.getByRole("list", { name: "Key figures" });
    expect(within(strip).getByText("First reply by a person, median").closest("li")!.textContent).toContain("Not known");
    expect(within(strip).getByText("Resolved by Fin").closest("li")!.textContent).toContain("Not known");
  });

  test("nobody waiting: the figure is calm", () => {
    convex.setQuery(api.support.overview, overview([chat({ finOutcome: "assumed_resolution" })]));
    show();
    const strip = screen.getByRole("list", { name: "Key figures" });
    expect(strip.querySelector("[data-tone=danger]")).toBeNull();
    expect(screen.getByText("Nobody is waiting on a person.")).toBeTruthy();
  });

  test("the waiting list: oldest first, its page, Fin's outcome, the assignee or Unassigned, and a link into Intercom", () => {
    const old = chat({ waitingSince: NOW - 60_000 - 30 * HOUR, assigneeId: "41", assigneeName: "Made-up Teammate", finParticipated: false, finOutcome: null, pageArea: null });
    const fresh = chat({ waitingSince: NOW - 60_000 - 2 * HOUR });
    convex.setQuery(api.support.overview, overview([fresh, old]));
    show();
    const table = screen.getByRole("table", { name: "Waiting on a person" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getByRole("rowheader").textContent)).toEqual(["1 d 6 h", "2 h"]);
    expect(rows[0]!.textContent).toContain("Made-up Teammate");
    expect(rows[0]!.textContent).toContain("Fin did not answer");
    expect(rows[0]!.textContent).toContain("Not known");
    expect(rows[1]!.textContent).toContain("Unassigned");
    expect(rows[1]!.textContent).toContain("Handed to a person");
    expect(rows[1]!.textContent).toContain("/studies/report");
    const link = within(rows[0]!).getByRole("link", { name: /Open in Intercom/ });
    expect(link.getAttribute("href")).toBe(`https://app.intercom.com/a/inbox/${APP}/inbox/conversation/${old.intercomId}`);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noreferrer");
    // A wait past four hours wears the danger tone; the two-hour one does not.
    expect(rows[0]!.getAttribute("data-tone")).toBe("danger");
    expect(rows[1]!.getAttribute("data-tone")).toBeNull();
  });

  test("an assignee the push did not name is shown by Intercom's id", () => {
    convex.setQuery(api.support.overview, overview([chat({ assigneeId: "77", assigneeName: null })]));
    show();
    expect(screen.getByRole("table", { name: "Waiting on a person" }).textContent).toContain("Teammate 77");
  });

  test("without the workspace's id there is no link, rather than a wrong one", () => {
    convex.setQuery(api.support.overview, overview([chat()], { appId: null }));
    show();
    expect(screen.queryByRole("link", { name: /Open in Intercom/ })).toBeNull();
  });

  test("chats a week: customers and tests as two series with a legend, the rest said in words", () => {
    convex.setQuery(
      api.support.overview,
      overview([chat(), chat({ origin: "test" }), chat({ origin: "other" }), chat({ origin: "unknown" })]),
    );
    show();
    const figure = screen.getByRole("group", { name: "Chats a week" }).closest("figure")!;
    expect(within(figure).getByRole("list", { name: "Legend" }).textContent).toBe("CustomersTests");
    expect(screen.getByText("Not drawn: 1 from other products sharing the workspace, 1 with no page known.")).toBeTruthy();
  });

  test("Fin's outcomes over thirty days, and the help articles it used, rendered as text", () => {
    convex.setQuery(
      api.support.overview,
      overview([
        chat({ finOutcome: "assumed_resolution", articles: ["<b>Upload</b> a [study](https://evil.example)"] }),
        chat({ finOutcome: "negative_feedback", articles: ["<b>Upload</b> a [study](https://evil.example)"] }),
      ]),
    );
    const { container } = show();
    const outcomes = screen.getByRole("table", { name: "Fin's outcomes, last 30 days" });
    const resolved = within(outcomes).getByText("Resolved by Fin").closest("tr")!;
    expect(resolved.textContent).toContain("1");
    expect(resolved.textContent).toContain("50%");
    const articles = screen.getByRole("list", { name: "Help articles Fin used most" });
    expect(articles.textContent).toContain("<b>Upload</b> a [study](https://evil.example)");
    expect(articles.textContent).toContain("2 chats");
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector('a[href="https://evil.example"]')).toBeNull();
  });

  test("inbox hygiene: test chats left open and chats open over thirty days, each with the inbox's link", () => {
    convex.setQuery(
      api.support.overview,
      overview([chat({ origin: "test" }), chat({ origin: "test" }), chat({ createdAt: NOW - 40 * DAY, finOutcome: "assumed_resolution" })]),
    );
    show();
    const hygiene = screen.getByRole("region", { name: "Inbox hygiene" });
    expect(hygiene.textContent).toContain("2 test chats still open");
    expect(hygiene.textContent).toContain("1 chat open more than 30 days");
    for (const link of within(hygiene).getAllByRole("link")) {
      expect(link.getAttribute("href")).toBe(`https://app.intercom.com/a/inbox/${APP}/inbox`);
    }
  });

  test("a refused push is said in the page's words, over what was pushed before; never the stored message", () => {
    convex.setQuery(
      api.support.overview,
      overview([chat()], { status: { state: "error", lastRunAt: NOW, lastOkAt: NOW - DAY, failure: "refused" } }),
    );
    show();
    expect(screen.getByRole("alert").textContent).toContain("The last push from the daily Intercom task was refused");
    expect(screen.getByRole("list", { name: "Key figures" })).toBeTruthy();
  });

  test("waits are counted to the last push, which is said", () => {
    const pushedAt = NOW - 10 * HOUR;
    convex.setQuery(
      api.support.overview,
      overview([chat({ waitingSince: pushedAt - 2 * HOUR })], {
        status: { state: "ok", lastRunAt: pushedAt, lastOkAt: pushedAt, failure: null },
      }),
    );
    show();
    const table = screen.getByRole("table", { name: "Waiting on a person" });
    expect(within(table).getByRole("rowheader").textContent).toBe("2 h");
    expect(screen.getByText(/As of the last push/)).toBeTruthy();
  });

  test("a viewer without Support, or not on Globex, is never sent the query", () => {
    convex.setQuery(api.support.overview, overview([chat()]));
    vi.mocked(useQuery).mockClear();
    show(["customers"], ["kz"]);
    show(["support"], ["us"]);
    expect(asked().length).toBe(0);
  });
});
