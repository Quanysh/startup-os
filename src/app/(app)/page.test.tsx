// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { AREAS, areasOf, type Area, type Role } from "@convex/lib/roles";
import { CompanyProvider } from "@/components/company-provider";
import { useRunway } from "@/components/home/use-runway";
import { ViewerProvider } from "@/components/viewer-provider";
import { agreement, obligation } from "@/lib/compliance/fixtures";
import { US, clinic } from "@/lib/customers/fixtures";
import { timeLabel } from "@/lib/work/days";
import { mockConvex } from "@/test-support/convex";
import TodayPage from "./page";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
// Local noon on Monday 2026-10-12, so "today" is the 12th in any timezone.
const { NOW, push } = vi.hoisted(() => ({ NOW: new Date(2026, 9, 12, 12).getTime(), push: vi.fn() }));
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
// The runway is Finance's own figure (src/components/home/use-runway.test.tsx);
// here it is what the line does with it.
vi.mock("@/components/home/use-runway", async (original) => ({
  ...(await original<typeof import("@/components/home/use-runway")>()),
  useRunway: vi.fn(),
}));

// Today, the one start page: the opening line, "Needs you", the owner's
// brief, the viewer's own day, then the company. Every name and title here
// is made up.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ME = "me@example.test";
const OK = { state: "ok", message: null, lastOkAt: NOW - 3 * HOUR };
const LATE = { lastPaymentDate: "2026-06-01" };

const BRIEF = {
  company: "us",
  day: "2026-10-12",
  writtenAt: NOW - 2 * HOUR,
  bullets: [{ agent: "engineering", text: "Two made-up pull requests waited.", page: "/engineering" }],
};
const proposal = (id: string) => ({
  id,
  agent: "engineering",
  kind: "task_create",
  company: "us",
  reason: "Made-up reason.",
  createdAt: NOW - 2 * HOUR,
  payload: { title: `Made-up proposal ${id}`, column: "this_week" },
  about: { task: null, deal: null, assignee: null },
  // As the approvals inbox lists it (`assistant.inbox`).
  source: "proposal",
  bot: null,
  changes: [],
  tool: null,
  toolName: null,
  arguments: null,
});
const note = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "mentioned",
  actor: { type: "user", name: "Olga Example" },
  title: `Made-up card ${id}`,
  company: null,
  taskId: `task-${id}`,
  decisionId: null,
  column: null,
  to: null,
  due: null,
  createdAt: NOW - 3 * HOUR,
  read: false,
  ...over,
});
let n = 0;
const task = (title: string, patch: Record<string, unknown> = {}) => ({
  id: `t${++n}`,
  title,
  notes: null,
  kind: "task",
  column: "backlog",
  due: null,
  goalId: null,
  goalTitle: null,
  doneAt: null,
  company: null,
  createdAt: NOW - 30 * DAY,
  assignee: { status: "teammate", email: ME, name: null },
  origin: null,
  ...patch,
});
const board = (backlog: unknown[] = []) => ({ backlog, this_week: [], doing: [], done: [] });
const event = (hour: number, title = "Made-up meeting") => ({
  eventId: `e${hour}`,
  title,
  startsAt: new Date(2026, 9, 12, hour).getTime(),
  endsAt: new Date(2026, 9, 12, hour + 1).getTime(),
  allDay: false,
  attendees: [],
  attendeeCount: 0,
  hasMeetingLink: false,
});
const quietDeal = {
  id: "d1",
  name: "SECRET DEAL",
  stage: "lead",
  amount: null,
  lastActivityAt: NOW - 41 * DAY,
  closedAt: null,
  nextStep: "Call",
};

// Globex's Intercom inbox (api.support.overview), before and after a push.
const NO_PUSH = { state: null, lastRunAt: null, lastOkAt: null, failure: null };
const waiting = (id: string, hours: number, pushedAt: number) => ({
  intercomId: id,
  createdAt: pushedAt - 30 * HOUR,
  updatedAt: pushedAt - hours * HOUR,
  state: "open",
  open: true,
  waitingSince: pushedAt - hours * HOUR,
  origin: "customer",
  pageArea: "studies",
  finParticipated: true,
  finOutcome: "escalated",
  humanRepliedAt: null,
  timeToHumanReply: null,
  lastCustomerReplyAt: pushedAt - hours * HOUR,
  lastHumanReplyAt: null,
  assigneeId: null,
  assigneeName: null,
  articles: ["SECRET article"],
});

let convex: ReturnType<typeof mockConvex>;
type Viewer = { role?: Role; areas?: readonly Area[]; companies?: ("us" | "kz")[]; company?: "us" | "kz" };
const OWNER: Viewer = { role: "owner", areas: AREAS };
const show = ({ role = "owner", areas = AREAS, companies = ["us", "kz"], company = "us" }: Viewer = {}) => {
  window.localStorage.setItem("startup-os:company", company);
  return render(
    <CompanyProvider allowed={companies}>
      <ViewerProvider viewer={{ role, companies, areas, email: ME, name: null }}>
        <TodayPage />
      </ViewerProvider>
    </CompanyProvider>,
  );
};
type Ref = Parameters<typeof getFunctionName>[0];
const sentArgs = (ref: Ref) =>
  vi
    .mocked(useQuery)
    .mock.calls.filter(([called]) => getFunctionName(called as never) === getFunctionName(ref))
    .map(([, args]) => args)
    .filter((args) => args !== "skip");
const sentNames = () =>
  vi
    .mocked(useQuery)
    .mock.calls.filter(([, args]) => args !== "skip")
    .map(([ref]) => getFunctionName(ref as never));
const markets = () => sentArgs(api.deals.board).map((args) => (args as { market: string }).market);
const h2 = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
const region = (name: string | RegExp) => screen.queryByRole("region", { name });
const needs = () => within(region(/^Needs you/)!);
/** Each row of "Needs you": what it is, without the words for its mark. */
const titles = () =>
  needs()
    .queryAllByRole("listitem")
    .map((li) =>
      [...li.querySelector("p")!.childNodes]
        .filter((node) => !(node instanceof HTMLElement && node.classList.contains("sr-only")))
        .map((node) => node.textContent)
        .join(""),
    );
const opening = () => screen.getByTestId("opening-line");

beforeEach(() => {
  convex = mockConvex();
  push.mockClear();
  vi.mocked(useQuery).mockClear();
  vi.mocked(useRunway).mockReturnValue(null);
  convex.setQuery(api.metrics.scorecard, { tiles: [], sources: {} });
  convex.setQuery(api.metrics.series, []);
  convex.setQuery(api.targets.list, []);
  convex.setQuery(api.customers.list, { customers: [], lastPushAt: NOW - DAY });
  convex.setQuery(api.obligations.list, []);
  convex.setQuery(api.handoffs.waiting, []);
  convex.setQuery(api.evidence.agreements, []);
  convex.setQuery(api.deals.board, {});
  convex.setQuery(api.investors.board, {});
  convex.setQuery(api.partnerships.board, {});
  convex.setQuery(api.goals.list, []);
  convex.setQuery(api.tasks.board, board());
  convex.setQuery(api.tasks.openIssues, []);
  convex.setQuery(api.workTools.pullRequests, { readAt: NOW, rows: [] });
  convex.setQuery(api.team.myGithub, { login: null });
  convex.setQuery(api.notifications.mine, { rows: [], more: false });
  convex.setQuery(api.notifications.unreadCount, 0);
  convex.setQuery(api.decisions.mineToRevisit, []);
  convex.setQuery(api.assistant.inbox, []);
  convex.setQuery(api.bots.refusedLately, []);
  convex.setQuery(api.assistant.brief, BRIEF);
  convex.setQuery(api.workTools.events, { source: OK, events: [] });
  convex.setQuery(api.workTools.needsReply, { source: OK, threads: [] });
  convex.setQuery(api.workTools.myIssues, { source: OK, issues: [] });
  convex.setQuery(api.workTools.meetings, { source: OK, meetings: [] });
  convex.setQuery(api.connect.status, {
    owner: false,
    token: { createdAt: NOW - 50 * HOUR, lastUsedAt: NOW - 3 * HOUR },
    tools: ["gmail", "google_calendar", "linear", "fireflies"].map((s) => ({ source: s, lastOkAt: NOW - 3 * HOUR, held: 1 })),
  });
  convex.setQuery(api.freshness.forPage, []);
  convex.setQuery(api.support.overview, { configured: false, appId: null, status: NO_PUSH, rows: [] });
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("Today, top to bottom", () => {
  test("the owner: the opening line, what needs them, the brief, their day, then the company", () => {
    show(OWNER);
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Today"]);
    expect(h2()).toEqual(["Needs you", "Brief", "Your day", "The company"]);
    // A way to the chat, never a second field to ask in.
    expect(screen.getByRole("link", { name: "Ask Claude" }).getAttribute("href")).toBe("/assistant");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  test("sales without their own day: what needs them and the company, nothing of the owner's", () => {
    show({ role: "sales", areas: areasOf("sales") });
    expect(h2()).toEqual(["Needs you", "The company"]);
    expect(screen.queryByRole("link", { name: "Ask Claude" })).toBeNull();
    // A person's own mail and calendar are the `today` area's: never sent.
    for (const ref of [api.workTools.events, api.workTools.needsReply, api.workTools.myIssues, api.connect.status]) {
      expect(sentArgs(ref), getFunctionName(ref)).toEqual([]);
    }
  });

  test("a teammate given their own day who has connected nothing is shown how, briefly", () => {
    convex.setQuery(api.connect.status, {
      owner: false,
      token: null,
      tools: ["gmail"].map((s) => ({ source: s, lastOkAt: null, held: 0 })),
    });
    show({ role: "sales", areas: [...areasOf("sales"), "today"] });
    const day = within(region("Your day")!);
    expect(day.getByRole("link", { name: "Connect your Claude" }).getAttribute("href")).toBe("/settings/connections");
    expect(day.queryByRole("region", { name: "Meetings today" })).toBeNull();
  });
});

describe("the opening line", () => {
  test("the owner: the runway, what needs them and their first meeting, each a link to where it is acted on", () => {
    vi.mocked(useRunway).mockReturnValue({ subject: "Group cash", runOut: { kind: "date", date: "2026-11-08", days: 27 } });
    convex.setQuery(api.workTools.events, { source: OK, events: [event(15), event(17)] });
    convex.setQuery(api.assistant.inbox, [proposal("p1")]);
    convex.setQuery(api.tasks.board, board([task("Made-up late", { due: "2026-10-09" })]));
    show(OWNER);
    const time = timeLabel(new Date(2026, 9, 12, 15).getTime());
    expect(opening().textContent).toBe(
      `Group cash runs out around 8 Nov. 2 things need you; your first meeting is at ${time}.`,
    );
    expect(within(opening()).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Group cash runs out around 8 Nov", "/finance"],
      ["2 things need you", "#needs-you"],
      [`your first meeting is at ${time}`, "#your-day"],
    ]);
    // The date and the company in view, quietly, under it.
    expect(screen.getByText("Monday, October 12")).toBeTruthy();
    expect(screen.getByText("Startup, US")).toBeTruthy();
  });

  test("with nothing needing them and no meetings: one calm sentence", () => {
    show(OWNER);
    expect(opening().textContent).toBe("Nothing needs you; no meetings today.");
    expect(needs().getByText("Nothing needs you.")).toBeTruthy();
  });

  test("a teammate without finance or their own day: no runway and no meeting, never a guess", () => {
    convex.setQuery(api.tasks.board, board([task("Made-up today", { due: "2026-10-12" })]));
    show({ role: "sales", areas: areasOf("sales") });
    expect(opening().textContent).toBe("1 thing needs you.");
  });

  test("it waits for what needs the viewer, and never grows a clause after it is read", () => {
    convex.setQuery(api.notifications.mine, undefined);
    show(OWNER);
    expect(screen.getByTestId("opening-loading")).toBeTruthy();
    expect(screen.queryByTestId("opening-line")).toBeNull();
  });
});

describe("Needs you: vendor agreements", () => {
  test("agreements past or near their end are counted and never named", () => {
    convex.setQuery(api.evidence.agreements, [
      agreement({ vendor: "SECRET Co", expiresOn: "2026-10-01" }),
      agreement({ vendor: "SECRET Two", expiresOn: "2026-11-30" }),
      agreement({ vendor: "SECRET Far", expiresOn: "2027-06-01" }),
    ]);
    show(OWNER);
    expect(titles()).toEqual([
      "1 vendor agreement past the expiry date",
      "1 vendor agreement ending in the next 60 days",
    ]);
    expect(document.body.textContent).not.toContain("SECRET");
  });
});

describe("Needs you: one list, most urgent first", () => {
  test.each([
    ["the clinics", () => convex.setQuery(api.customers.list, undefined)],
    ["the obligations", () => convex.setQuery(api.obligations.list, undefined)],
    ["the handoffs", () => convex.setQuery(api.handoffs.waiting, undefined)],
    ["the vendor agreements", () => convex.setQuery(api.evidence.agreements, undefined)],
    ["the deals", () => convex.setQuery(api.deals.board, undefined)],
    ["the investors", () => convex.setQuery(api.investors.board, undefined)],
    ["the partners", () => convex.setQuery(api.partnerships.board, undefined)],
    ["the pull requests", () => convex.setQuery(api.workTools.pullRequests, undefined)],
    ["the notifications", () => convex.setQuery(api.notifications.unreadCount, undefined)],
    ["the board", () => convex.setQuery(api.tasks.board, undefined)],
    ["the proposals", () => convex.setQuery(api.assistant.inbox, undefined)],
    ["the bots refused lately", () => convex.setQuery(api.bots.refusedLately, undefined)],
  ])("it does not say there is nothing until %s have been read", (_name, withhold) => {
    withhold();
    show(OWNER);
    expect(screen.queryByText("Nothing needs you.")).toBeNull();
    expect(screen.getByTestId("needs-loading")).toBeTruthy();
  });

  test("the viewer's own and the company's, merged, ranked and said once", () => {
    convex.setQuery(api.assistant.inbox, [proposal("p1")]);
    const late = task("Made-up late task", { due: "2026-10-09" });
    const given = task("Made-up given task", { createdAt: NOW - HOUR });
    convex.setQuery(api.tasks.board, board([late, given, task("Made-up later", { due: "2026-11-30" })]));
    convex.setQuery(api.notifications.mine, {
      rows: [note("n1", { taskId: given.id, kind: "assigned" }), note("n2"), note("n3", { read: true })],
      more: false,
    });
    convex.setQuery(api.notifications.unreadCount, 2);
    convex.setQuery(api.decisions.mineToRevisit, [{ id: "dc1", title: "Made-up decision", revisitOn: "2026-10-10" }]);
    convex.setQuery(api.obligations.list, [obligation({ title: "SECRET tax", due: "2026-10-09", dueConfirmed: true })]);
    convex.setQuery(api.metrics.scorecard, {
      tiles: [],
      sources: { mercury: { state: "error", lastRunAt: NOW, lastOkAt: null, message: "x" } },
    });
    show(OWNER);
    expect(titles()).toEqual([
      // Late: my overdue task, then the company's failures and what is overdue.
      "Made-up late task",
      "Mercury: last run failed",
      "1 obligation overdue",
      // Waiting on me today: the proposal.
      "Create a task: \"Made-up proposal p1\", in This week",
      // Then what I was told (once: the task given me is said by the task), decisions, what is new for me.
      "Olga Example mentioned you in Made-up card n2",
      "Made-up decision",
      "Made-up given task",
    ]);
    expect(needs().getByRole("heading", { level: 2 }).textContent).toBe("Needs you7");
    // Each row leads to where it is acted on.
    const actions = needs()
      .getAllByRole("listitem")
      .map((li) => li.querySelector("a")?.getAttribute("href") ?? li.querySelector("button")?.textContent ?? null);
    expect(actions).toEqual([
      `/board?task=${late.id}`,
      "/settings/sources",
      "/compliance",
      // That row on /approvals, brought into view.
      "/approvals?id=p1",
      "Open: Olga Example mentioned you in Made-up card n2",
      "/memory?decision=dc1",
      `/board?task=${given.id}`,
    ]);
    expect(document.body.textContent).not.toContain("SECRET");
  });

  test("opening a notification marks it read and goes to its card", async () => {
    convex.setQuery(api.notifications.mine, { rows: [note("n2")], more: false });
    convex.setQuery(api.notifications.unreadCount, 1);
    show(OWNER);
    await userEvent.click(needs().getByRole("button", { name: /^Open/ }));
    expect(convex.mutation(api.notifications.markRead)).toHaveBeenCalledWith({ id: "n2" });
    expect(push).toHaveBeenCalledWith("/board?task=task-n2");
  });

  test("more unread than are listed: the rest are a press away, in the bell's panel", async () => {
    convex.setQuery(api.notifications.mine, { rows: ["a", "b", "c", "d", "e", "f"].map((id) => note(id)), more: false });
    convex.setQuery(api.notifications.unreadCount, 9);
    const opened = vi.fn();
    window.addEventListener("startup-os:open-notifications", opened);
    show(OWNER);
    expect(titles()).toHaveLength(5);
    await userEvent.click(needs().getByRole("button", { name: "4 more notifications" }));
    expect(opened).toHaveBeenCalledTimes(1);
    window.removeEventListener("startup-os:open-notifications", opened);
  });

  test("clinics and obligations are counted and never named, worst first", () => {
    convex.setQuery(api.customers.list, {
      customers: [clinic({ ...US, ...LATE }), clinic({ ...US, ...LATE }), clinic(US), clinic()],
      lastPushAt: Date.UTC(2026, 7, 20, 9),
    });
    convex.setQuery(api.obligations.list, [
      obligation({ title: "SECRET tax", due: "2026-10-09", dueConfirmed: true }),
      obligation({ title: "Renew SECRET CLINIC's contract", due: "2026-10-20", dueConfirmed: true }),
      obligation({ title: "SECRET guess", due: "2026-01-01" }),
    ]);
    show(OWNER);
    expect(titles()).toEqual([
      "1 obligation overdue",
      "2 clinics are at risk",
      "1 obligation due in the next 30 days",
      "The client register is out of date",
      "3 US clinics have no BAA date on record",
      "1 obligation has a date to confirm",
    ]);
    expect(document.body.textContent).not.toContain("SECRET");
  });

  test("an open handoff nobody took for a day is one line with a count, and names nothing", () => {
    convex.setQuery(api.handoffs.waiting, [
      { company: "us", status: "open", openSince: NOW - 25 * HOUR },
      { company: "us", status: "open", openSince: NOW - HOUR },
    ]);
    show(OWNER);
    expect(titles()).toEqual(["1 handoff has no taker"]);
  });

  test("a bot refused more than five times in the hour is one line for the owner, leading to the Bots tab", () => {
    convex.setQuery(api.bots.refusedLately, [{ id: "b1", botId: "growth", name: "Made-up Growth Bot", refusals: 6 }]);
    show(OWNER);
    expect(titles()).toEqual(["Made-up Growth Bot was refused 6 times in the last hour"]);
    expect(needs().getByRole("link", { name: /Open/ }).getAttribute("href")).toBe("/agents?view=bots");
  });

  test("a teammate is never sent the owner's proposals, and a failed source they cannot fix has no link", () => {
    convex.setQuery(api.metrics.scorecard, {
      tiles: [],
      sources: { mercury: { state: "error", lastRunAt: NOW, lastOkAt: null, message: "x" } },
    });
    show({ role: "cofounder", areas: areasOf("cofounder") });
    expect(sentArgs(api.assistant.inbox)).toEqual([]);
    expect(sentArgs(api.bots.refusedLately)).toEqual([]);
    expect(titles()).toEqual(["Mercury: last run failed"]);
    expect(needs().queryByRole("link")).toBeNull();
  });
});

describe("Needs you: customers waiting on a person (Support)", () => {
  const PUSHED = NOW - 2 * HOUR;
  const inbox = {
    configured: true,
    appId: "made0up1",
    status: { state: "ok", lastRunAt: PUSHED, lastOkAt: PUSHED, failure: null },
    rows: [waiting("901", 6, PUSHED), waiting("902", 3, PUSHED)],
  };

  test("with Globex in view and Support: a chat waiting more than four hours at the last push, with Intercom's link", () => {
    convex.setQuery(api.support.overview, inbox);
    show({ ...OWNER, company: "kz" });
    expect(titles()).toEqual(["A customer is waiting on a person"]);
    const row = needs().getAllByRole("listitem")[0]!;
    expect(row.textContent).toContain("Waited 6 h at the last push · /studies · Handed to a person");
    const link = within(row).getByRole("link", { name: /^Open in Intercom/ });
    expect(link.getAttribute("href")).toBe("https://app.intercom.com/a/inbox/made0up1/inbox/conversation/901");
    expect(document.body.textContent).not.toContain("SECRET");
  });

  test("it waits for the inbox before saying there is nothing", () => {
    convex.setQuery(api.support.overview, undefined);
    show({ ...OWNER, company: "kz" });
    expect(screen.getByTestId("needs-loading")).toBeTruthy();
  });

  test("never asked with Startup in view, or by someone without Support", () => {
    convex.setQuery(api.support.overview, inbox);
    show(OWNER);
    expect(sentArgs(api.support.overview)).toEqual([]);
    cleanup();
    show({ role: "cofounder", areas: areasOf("cofounder"), companies: ["kz"], company: "kz" });
    expect(sentArgs(api.support.overview)).toEqual([]);
    expect(titles()).not.toContain("A customer is waiting on a person");
  });
});

describe("one company at a time", () => {
  test("Globex hears about Kazakhstan's deals, never the US's or investors; Startup the other way", () => {
    convex.setQueryBy(api.deals.board, (args) => ((args as { market: string }).market === "kz" ? {} : { lead: [quietDeal] }));
    show({ ...OWNER, company: "kz" });
    expect(titles()).toEqual([]);
    expect(new Set(markets())).toEqual(new Set(["kz"]));
    cleanup();
    show({ ...OWNER, company: "us" });
    expect(titles()).toEqual(["1 US deal has gone quiet"]);
    expect(document.body.textContent).not.toContain("SECRET");
  });

  test("partners gone quiet with a next step overdue are counted per company and never named", () => {
    const quiet = (name: string) => ({
      id: name,
      company: "us",
      name,
      stage: "in_talks",
      lastActivityAt: NOW - 30 * DAY,
      nextStep: "Chase",
      nextStepOn: "2026-10-01",
    });
    convex.setQueryBy(api.partnerships.board, (args) =>
      (args as { company: string }).company === "us" ? { in_talks: [quiet("SECRET PARTNER")] } : { in_talks: [] },
    );
    show({ ...OWNER, company: "us" });
    expect(titles()).toEqual(["1 Startup partner has gone quiet with a next step overdue"]);
    expect(document.body.textContent).not.toContain("SECRET");
    cleanup();
    show({ ...OWNER, company: "kz" });
    expect(titles()).toEqual([]);
  });

  test("a viewer without the partnerships area is never sent the partners", () => {
    show({ role: "sales", areas: areasOf("sales"), companies: ["us"], company: "us" });
    expect(sentArgs(api.partnerships.board)).toEqual([]);
  });

  test("a failed run of a source that feeds only Startup is not Globex's alarm", () => {
    convex.setQuery(api.metrics.scorecard, {
      tiles: [],
      sources: { mercury: { state: "error", lastRunAt: NOW, lastOkAt: null, message: "x" } },
    });
    show({ ...OWNER, company: "kz" });
    expect(titles()).toEqual([]);
  });

  test("a viewer on Globex alone: no Startup block, read or word, whatever their browser remembers", () => {
    convex.setQueryBy(api.deals.board, (args) => ((args as { market: string }).market === "kz" ? {} : undefined));
    show({ role: "cofounder", areas: areasOf("cofounder"), companies: ["kz"], company: "us" });
    expect(new Set(markets())).toEqual(new Set(["kz"]));
    expect(sentArgs(api.investors.board)).toEqual([]);
    expect(region("Fundraising")).toBeNull();
    expect(region("Go to market")).toBeNull();
    expect(screen.getByText("Globex, KZ")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Startup/);
  });
});

describe("the brief is the owner's alone", () => {
  test("the owner: today's lines, folded away with a press, and the way to the Assistant", () => {
    show(OWNER);
    const brief = within(region("Brief")!);
    expect(brief.getByText("Two made-up pull requests waited.")).toBeTruthy();
    expect(brief.getByRole("link", { name: "Open in Assistant" }).getAttribute("href")).toBe("/assistant");
    expect(region("Brief")!.querySelector("details[open]")).not.toBeNull();
  });

  test.each([
    ["a co-founder with every page they can be given", "cofounder", AREAS.filter((a) => a !== "personal" && a !== "admin")],
    ["a co-founder with the role's own pages", "cofounder", [...areasOf("cofounder"), "today"]],
    ["sales", "sales", [...areasOf("sales"), "today"]],
    ["an engineer with their own day", "engineer", [...areasOf("engineer"), "today"]],
  ] as const)("%s: no brief, no approvals, no chat, and none of them sent", (_who, role, areas) => {
    convex.setQuery(api.assistant.inbox, [proposal("p1")]);
    show({ role: role as Role, areas });
    expect(region("Brief")).toBeNull();
    expect(document.body.textContent).not.toContain("Two made-up pull requests waited.");
    expect(document.body.textContent).not.toContain("Made-up proposal p1");
    expect(screen.queryByRole("link", { name: "Ask Claude" })).toBeNull();
    expect(sentNames().filter((name) => name.startsWith("assistant:") || name.startsWith("chat:"))).toEqual([]);
  });
});

describe("your day", () => {
  test("today's meetings in time order, the past ones quieter, and the rest of the week a press away", () => {
    convex.setQuery(api.workTools.events, {
      source: OK,
      events: [event(15, "Made-up later"), event(9, "Made-up morning")],
    });
    show(OWNER);
    const meetings = within(region("Meetings today")!);
    const rows = meetings.getAllByRole("listitem").filter((li) => li.hasAttribute("data-past") || li.parentElement?.tagName === "OL");
    expect(rows.map((li) => li.textContent).filter(Boolean).join(" ")).toMatch(/Made-up morning.*Made-up later/);
    expect(region("Meetings today")!.querySelector("[data-past]")?.textContent).toContain("Made-up morning");
    expect(screen.getByText("Show the rest of the week")).toBeTruthy();
    expect(screen.getByText("Show recent meetings")).toBeTruthy();
  });
});

describe("the company", () => {
  /** Each block under "The company", by the heading of its own region. */
  const blockNames = () =>
    [...region("The company")!.querySelectorAll("section[aria-labelledby] > h3")].map((h) => h.textContent);

  test("a strip of key figures, then the blocks: Money's figures are in the strip, not again below", () => {
    show(OWNER);
    const company = within(region("The company")!);
    expect(company.getByRole("list", { name: "Key figures" })).toBeTruthy();
    expect(company.getByText("Cash")).toBeTruthy();
    expect(company.getByText("Open pipeline")).toBeTruthy();
    expect(blockNames()).not.toContain("Money");
    expect(blockNames().slice(0, 3)).toEqual(["Customers", "Sales pipeline", "Fundraising"]);
  });

  test("no clinic, deal, investor, obligation or someone else's task is named anywhere on the page", () => {
    const secret = (stage: string) => ({ ...quietDeal, id: stage, stage, amount: 100, lastActivityAt: NOW - 30 * DAY });
    convex.setQuery(api.deals.board, { lead: [secret("lead")] });
    convex.setQuery(api.investors.board, { meeting: [secret("meeting")] });
    convex.setQuery(api.customers.list, { customers: [clinic(LATE)], lastPushAt: NOW - DAY });
    convex.setQuery(api.obligations.list, [obligation({ title: "SECRET item", due: "2026-10-01", dueConfirmed: true })]);
    convex.setQuery(api.tasks.board, board([task("SECRET TASK", { due: "2026-10-01", assignee: null })]));
    show(OWNER);
    expect(document.body.textContent).not.toContain("SECRET");
  });

  test("without finance or sales there is no strip, and no money figure is asked for", () => {
    show({ role: "engineer", areas: [...areasOf("engineer"), "scorecard"] });
    expect(within(region("The company")!).queryByRole("list", { name: "Key figures" })).toBeNull();
    expect(sentArgs(api.metrics.series)).toEqual([]);
    expect(blockNames()).toEqual(expect.arrayContaining(["Engineering", "Product"]));
  });
});
