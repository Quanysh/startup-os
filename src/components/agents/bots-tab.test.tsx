// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { DEFAULT_BOT_LIMITS, LOCKED_BOT_AREAS, instructionLine } from "@convex/lib/botRules";
import { mockConvex } from "@/test-support/convex";
import { BotsTab, NEW_TOKEN_NOTE, REVOKED_NOTE, SHARED_CLIENT_NOTE } from "./bots-tab";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

// The address, as the page holds it: `replace` and `push` change it and the
// tab reads it again, so a click that writes the view is seen to take effect.
const nav = vi.hoisted(() => ({
  query: "view=bots",
  calls: [] as { how: "replace" | "push"; href: string }[],
  listeners: new Set<() => void>(),
}));
vi.mock("next/navigation", async () => {
  const React = await import("react");
  const go = (how: "replace" | "push") => (href: string) => {
    nav.calls.push({ how, href });
    nav.query = href.includes("?") ? href.slice(href.indexOf("?") + 1) : "";
    for (const listener of nav.listeners) listener();
  };
  return {
    useSearchParams: () =>
      new URLSearchParams(
        React.useSyncExternalStore(
          (listener: () => void) => {
            nav.listeners.add(listener);
            return () => nav.listeners.delete(listener);
          },
          () => nav.query,
        ),
      ),
    usePathname: () => "/agents",
    useRouter: () => ({ replace: go("replace"), push: go("push") }),
  };
});

// The Bots tab on /agents, with made-up bots: the figures over one table of
// every bot, a filter and a search in the address, one bot open at a time in
// its own panel (Overview, Activity, Permissions, Autonomy, Plays, Week), and
// the settings for every bot folded away.

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  nav.query = "view=bots";
  nav.calls = [];
  convex = mockConvex();
  convex.setQuery(api.assistant.clients, [{ id: "c1", kind: "token", name: "Made-up Grok", scope: "act" }]);
});
afterEach(() => cleanup());

const NOW = Date.parse("2026-10-18T12:00:00Z");
const bot = {
  id: "b1",
  botId: "fundraising",
  name: "Made-up Fundraising Bot",
  role: "Fundraising",
  clients: "any",
  permissions: [
    { area: "fundraising", level: "write" },
    { area: "board", level: "write" },
    { area: "sales", level: "read" },
  ],
  limits: DEFAULT_BOT_LIMITS,
  enabled: true,
  suggested: true,
  lastCallAt: NOW - 5 * 60_000,
  callsToday: 7,
  refusalsToday: 1,
};
const other = {
  ...bot,
  id: "b2",
  botId: "research",
  name: "Made-up Research Bot",
  role: "Research",
  suggested: false,
  enabled: false,
  refusalsToday: 0,
  callsToday: 0,
};

const telemetryRow = (over: Record<string, unknown>) => ({
  botId: "fundraising",
  name: "Made-up Fundraising Bot",
  provider: "external_grok",
  owner: "owner",
  company: null,
  monthlyBudgetUsd: null,
  enabled: true,
  calls7d: null,
  errorRate7d: null,
  schemaFailureRate7d: null,
  p95Ms7d: null,
  lastSeenDay: null,
  idle7d: true,
  approvalRate: null,
  costMonthUsd: null,
  costWhy: "external_not_reported",
  ...over,
});

const table = () => screen.getByRole("table", { name: "Bots" });
const rowOf = (name: string) => within(table()).getAllByRole("row").find((row) => row.textContent?.includes(name))!;
const open = (name: string) => fireEvent.click(within(table()).getByRole("button", { name }));
const detail = () => screen.getByRole("region", { name: /^Bot / });
const tab = (name: string) => fireEvent.click(within(detail()).getByRole("tab", { name }));
const lastHref = () => nav.calls.at(-1)?.href ?? "";

test("over the table: how many bots, on and off, idle, the week's calls and today's refusals", () => {
  convex.setQuery(api.bots.list, { bots: [bot, other], suggestedMissing: 0 });
  convex.setQuery(api.bots.telemetry, [
    telemetryRow({ calls7d: 120, idle7d: false }),
    telemetryRow({ botId: "research", name: "Made-up Research Bot", enabled: false }),
  ]);
  // The one count of what waits (the inbox's length, both companies), as the navigation shows it.
  convex.setQuery(api.assistant.inbox, [{ id: "p1" }, { id: "p2" }, { id: "a1" }]);
  convex.setQuery(api.devRequests.openCount, 4);
  render(<BotsTab now={NOW} />);
  const figures = screen.getByRole("list", { name: "Bots at a glance" });
  const said = (label: string) => within(figures).getByText(label).parentElement!.textContent;
  expect(said("Bots")).toBe("Bots2");
  expect(said("On")).toBe("On1");
  expect(said("Off")).toBe("Off1");
  expect(said("Idle 7 days")).toBe("Idle 7 days1");
  expect(said("Calls, 7 days")).toBe("Calls, 7 days120");
  expect(said("Refused today")).toBe("Refused today1");
  expect(said("Waiting on Approvals")).toBe("Waiting on Approvals3");
  expect(said("Open requests")).toBe("Open requests4");
});

test("a bot's row names it, its role and its marks; opening it says what it may do, its limits and its use today", () => {
  convex.setQuery(api.bots.list, { bots: [bot], suggestedMissing: 0 });
  render(<BotsTab now={NOW} />);
  const row = rowOf("Made-up Fundraising Bot");
  expect(row.textContent).toContain("Fundraising");
  expect(row.textContent).toContain("Suggested");
  expect(row.textContent).toContain("1 refused today");
  open("Made-up Fundraising Bot");
  expect(lastHref()).toBe("/agents?view=bots&bot=fundraising");
  // Opening a bot is a step of its own, so Back closes it.
  expect(nav.calls.at(-1)?.how).toBe("push");
  const overview = within(detail()).getByRole("tabpanel", { name: "Overview" });
  expect(overview.textContent).toContain("Any client");
  expect(overview.textContent).toContain("Writes Fundraising, Board · reads 1 more");
  expect(overview.textContent).toContain("600 calls and 120 changes per 10 min");
  expect(overview.textContent).toContain("7 calls, 1 refused");
  expect(overview.textContent).toContain(instructionLine("fundraising"));
});

test("one bot is open at a time, from the address; Close and Escape close it and focus goes back to its row", async () => {
  convex.setQuery(api.bots.list, { bots: [bot, other], suggestedMissing: 0 });
  nav.query = "view=bots&bot=research";
  render(<BotsTab now={NOW} />);
  expect(screen.getAllByRole("region", { name: /^Bot / })).toHaveLength(1);
  expect(detail().getAttribute("aria-label")).toBe("Bot Made-up Research Bot");
  fireEvent.click(within(detail()).getByRole("button", { name: "Close" }));
  expect(lastHref()).toBe("/agents?view=bots");
  expect(screen.queryByRole("region", { name: /^Bot / })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(within(table()).getByRole("button", { name: "Made-up Research Bot" })));

  open("Made-up Fundraising Bot");
  expect(detail().getAttribute("aria-label")).toBe("Bot Made-up Fundraising Bot");
  fireEvent.keyDown(within(detail()).getByRole("tab", { name: "Overview" }), { key: "Escape" });
  expect(screen.queryByRole("region", { name: /^Bot / })).toBeNull();
  await waitFor(() =>
    expect(document.activeElement).toBe(within(table()).getByRole("button", { name: "Made-up Fundraising Bot" })),
  );
});

test("a bot the address names and the owner does not have opens nothing", () => {
  convex.setQuery(api.bots.list, { bots: [bot], suggestedMissing: 0 });
  nav.query = "view=bots&bot=nobody";
  render(<BotsTab now={NOW} />);
  expect(screen.queryByRole("region", { name: /^Bot / })).toBeNull();
});

test("the filters and the search are the address; a filter from the address narrows the table", () => {
  convex.setQuery(api.bots.list, { bots: [bot, other], suggestedMissing: 0 });
  const { rerender } = render(<BotsTab now={NOW} />);
  const filters = screen.getByRole("group", { name: "Show" });
  expect(within(filters).getByRole("button", { name: "All (2)" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(within(filters).getByRole("button", { name: "Off (1)" }));
  expect(lastHref()).toBe("/agents?view=bots&filter=off");
  expect(nav.calls.at(-1)?.how).toBe("replace");
  expect(within(table()).queryByText("Made-up Fundraising Bot")).toBeNull();
  expect(within(table()).getByText("Made-up Research Bot")).toBeTruthy();

  nav.query = "view=bots";
  rerender(<BotsTab now={NOW} />);
  fireEvent.change(screen.getByRole("searchbox", { name: "Find a bot" }), { target: { value: "fund" } });
  expect(lastHref()).toBe("/agents?view=bots&q=fund");
  expect(within(table()).queryByText("Made-up Research Bot")).toBeNull();

  // Nothing matches: said, with the way back.
  fireEvent.change(screen.getByRole("searchbox", { name: "Find a bot" }), { target: { value: "nothing like it" } });
  expect(screen.getByText("No bot matches.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show every bot" }));
  expect(lastHref()).toBe("/agents?view=bots");
});

test("problems first: a bot refused today leads the table", () => {
  convex.setQuery(api.bots.list, {
    bots: [{ ...bot, refusalsToday: 0 }, { ...other, enabled: true, refusalsToday: 3 }],
    suggestedMissing: 0,
  });
  render(<BotsTab now={NOW} />);
  const names = within(table())
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.querySelector("th")?.textContent ?? "");
  expect(names[0]).toContain("Made-up Research Bot");
  expect(names[0]).toContain("3 refused today");
});

test("a column's header sorts by it, in the address", () => {
  convex.setQuery(api.bots.list, { bots: [bot], suggestedMissing: 0 });
  nav.query = "view=bots&sort=calls&dir=desc";
  render(<BotsTab now={NOW} />);
  const calls = within(table()).getByRole("columnheader", { name: /Calls/ });
  expect(calls.getAttribute("aria-sort")).toBe("descending");
  fireEvent.click(within(calls).getByRole("button"));
  expect(lastHref()).toBe("/agents?view=bots&sort=calls&dir=asc");
});

test("each row's switch turns its bot off or on at once", async () => {
  convex.setQuery(api.bots.list, { bots: [bot], suggestedMissing: 0 });
  render(<BotsTab now={NOW} />);
  fireEvent.click(within(table()).getByRole("switch", { name: "Made-up Fundraising Bot on" }));
  await waitFor(() => expect(convex.mutation(api.bots.update)).toHaveBeenCalledWith({ id: "b1", enabled: false }));
  // The switch is no way into the bot.
  expect(screen.queryByRole("region", { name: /^Bot / })).toBeNull();
});

test("the matrix offers none, read and write for bot areas, and locks the rest", () => {
  convex.setQuery(api.bots.list, { bots: [bot], suggestedMissing: 0 });
  nav.query = "view=bots&bot=fundraising";
  render(<BotsTab now={NOW} />);
  tab("Permissions");
  expect(screen.getByRole("radiogroup", { name: "Board" })).toBeTruthy();
  expect(within(screen.getByRole("radiogroup", { name: "Board" })).getByRole("radio", { name: "write" }).getAttribute("aria-checked")).toBe("true");
  for (const name of ["Payroll", "Costs", "Settings", "Team", "Today"]) {
    expect(screen.queryByRole("radiogroup", { name })).toBeNull();
  }
  expect(screen.getAllByText("Never for a bot")).toHaveLength(LOCKED_BOT_AREAS.length);
});

test("with no bots, the suggested ones are added once, and the tab says there are none", async () => {
  convex.setQuery(api.bots.list, { bots: [], suggestedMissing: 10 });
  const { rerender } = render(<BotsTab now={NOW} />);
  rerender(<BotsTab now={NOW} />);
  await waitFor(() => expect(convex.mutation(api.bots.addSuggested)).toHaveBeenCalledTimes(1));
  expect(screen.getByText(/No bots yet/)).toBeTruthy();
});

test("while the bots load, the tab says so rather than showing an empty table", () => {
  render(<BotsTab now={NOW} />);
  expect(screen.getByTestId("bots-loading")).toBeTruthy();
  expect(screen.queryByRole("table")).toBeNull();
});

test("beside its token, a bot's overview says that bots sharing a client can claim each other's names", () => {
  convex.setQuery(api.bots.list, { bots: [bot], suggestedMissing: 0 });
  nav.query = "view=bots&bot=fundraising";
  render(<BotsTab now={NOW} />);
  expect(within(detail()).getByRole("tabpanel", { name: "Overview" }).textContent).toContain(SHARED_CLIENT_NOTE);
});

test("Make a token for this bot makes one and shows it once", async () => {
  convex.setQuery(api.bots.list, { bots: [bot], suggestedMissing: 0 });
  convex.mutation(api.bots.makeToken).mockResolvedValue({ token: "sosa_FAKE-token-for-tests-0123456789-abcdefghij", id: "t9" });
  nav.query = "view=bots&bot=fundraising";
  render(<BotsTab now={NOW} />);
  fireEvent.click(screen.getByRole("button", { name: "Make a token for this bot" }));
  await waitFor(() => expect(screen.getByTestId("bot-token").textContent).toBe("sosa_FAKE-token-for-tests-0123456789-abcdefghij"));
  const sent = convex.mutation(api.bots.makeToken).mock.calls[0]![0] as { id: string; entropy: string };
  expect(sent.id).toBe("b1");
  expect(sent.entropy.length).toBeGreaterThanOrEqual(43);
});

test("the owner is told a new token stops the bot's previous one, and when one was stopped", async () => {
  convex.setQuery(api.bots.list, { bots: [bot], suggestedMissing: 0 });
  convex.mutation(api.bots.makeToken).mockResolvedValue({ token: "sosa_FAKE-token-for-tests-0123456789-abcdefghij", id: "t9", revoked: 1 });
  nav.query = "view=bots&bot=fundraising";
  render(<BotsTab now={NOW} />);
  expect(within(detail()).getByRole("tabpanel", { name: "Overview" }).textContent).toContain(NEW_TOKEN_NOTE);
  fireEvent.click(screen.getByRole("button", { name: "Make a token for this bot" }));
  await waitFor(() => expect(screen.getByText(REVOKED_NOTE)).toBeTruthy());
});

test("each bot shows its own connector address, with Copy and the steps for Grok", () => {
  convex.setQuery(api.bots.list, { bots: [bot], suggestedMissing: 0 });
  nav.query = "view=bots&bot=fundraising";
  render(<BotsTab now={NOW} mcpUrl="https://os.example.test/mcp/v1" />);
  const overview = within(detail()).getByRole("tabpanel", { name: "Overview" });
  expect(overview.textContent).toContain("Connector address");
  expect(within(overview).getByText("https://os.example.test/mcp/v1/bot/fundraising")).toBeTruthy();
  expect(within(overview).getByRole("button", { name: "Copy address" })).toBeTruthy();
  expect(overview.textContent).toContain("Add it in Grok");
  expect(overview.textContent).toContain("keeps its instructions and memory");
});

test("with no public address known, no connector address is made up", () => {
  convex.setQuery(api.bots.list, { bots: [bot], suggestedMissing: 0 });
  nav.query = "view=bots&bot=fundraising";
  render(<BotsTab now={NOW} mcpUrl={null} />);
  expect(screen.queryByText(/\/mcp\/v1\/bot\//)).toBeNull();
});

test("the settings for every bot are folded away until opened, and open in the address", () => {
  convex.setQuery(api.bots.list, { bots: [bot], suggestedMissing: 0 });
  const { rerender } = render(<BotsTab now={NOW} />);
  const toggle = screen.getByRole("button", { name: "Settings for every bot" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("region", { name: "Rules for every bot" })).toBeNull();
  fireEvent.click(toggle);
  expect(lastHref()).toBe("/agents?view=bots&settings=open");
  rerender(<BotsTab now={NOW} />);
  expect(screen.getByRole("button", { name: "Settings for every bot" }).getAttribute("aria-expanded")).toBe("true");
  // What every bot is held to, said in full inside.
  expect(document.body.textContent).toContain("2,000 calls and 600 changes in 10 minutes");
  expect(document.body.textContent).toContain("Sales stays on the Mac.");
});

test("the owner edits the rules and each bot's note, and publishes them as the next version", async () => {
  convex.setQuery(api.bots.list, { bots: [bot], suggestedMissing: 0 });
  convex.setQuery(api.bots.rules, { version: 3, publishedAt: NOW - 60_000, rules: "Made-up rules three.", notes: [] });
  convex.mutation(api.bots.publishRules).mockResolvedValue({ version: 4 });
  nav.query = "view=bots&settings=open";
  render(<BotsTab now={NOW} mcpUrl={null} />);
  const rules = screen.getByRole("region", { name: "Rules for every bot" });
  expect(rules.textContent).toContain("Version 3");
  const text = within(rules).getByLabelText("Rules every bot follows") as HTMLTextAreaElement;
  expect(text.value).toBe("Made-up rules three.");
  fireEvent.change(text, { target: { value: "Made-up rules four." } });
  fireEvent.change(within(rules).getByLabelText("Note for Made-up Fundraising Bot"), { target: { value: "Made-up note." } });
  fireEvent.click(within(rules).getByRole("button", { name: "Publish as version 4" }));
  await waitFor(() =>
    expect(convex.mutation(api.bots.publishRules)).toHaveBeenCalledWith({
      rules: "Made-up rules four.",
      notes: [{ bot: "fundraising", text: "Made-up note." }],
    }),
  );
});

test("every area a bot may hold has its label: Partnerships is said by name", () => {
  convex.setQuery(api.bots.list, {
    bots: [{ ...bot, permissions: [{ area: "partnerships", level: "write" }, { area: "board", level: "write" }] }],
    suggestedMissing: 0,
  });
  nav.query = "view=bots&bot=fundraising";
  render(<BotsTab now={NOW} />);
  expect(within(detail()).getByRole("tabpanel", { name: "Overview" }).textContent).toContain("Writes Partnerships, Board");
  tab("Permissions");
  expect(screen.getByRole("radiogroup", { name: "Partnerships" })).toBeTruthy();
});

test("a bot's activity: its last calls, its refusals today by code, and Grant on a repeated not-permitted", async () => {
  convex.setQuery(api.bots.list, { bots: [bot], suggestedMissing: 0 });
  convex.setQuery(api.bots.activity, [
    {
      id: "b1",
      botId: "fundraising",
      recent: [
        { id: "r1", tool: "deals", outcome: "ok", at: NOW - 60_000, code: null },
        { id: "r2", tool: "deal_update", outcome: "refused", at: NOW - 120_000, code: "not_permitted" },
      ],
      refusals: [
        { code: "not_permitted", area: "sales", need: "write", count: 6 },
        { code: "rate_limited", area: null, need: null, count: 1 },
      ],
    },
  ]);
  nav.query = "view=bots&bot=fundraising";
  render(<BotsTab now={NOW} />);
  // Today's refusals are said on the tab's name, so they are not missed.
  tab("Activity · 7 refused");
  const calls = screen.getByRole("list", { name: "Last calls of Made-up Fundraising Bot" });
  expect(within(calls).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
    expect.stringContaining("deals"),
    expect.stringContaining("deal_update"),
  ]);
  expect(calls.textContent).toContain("Not permitted");
  const refused = screen.getByTestId("refusals-b1");
  expect(refused.textContent).toContain("6× Not permitted on Sales (write)");
  expect(refused.textContent).toContain("1× Over a limit");
  fireEvent.click(screen.getByRole("button", { name: "Grant write on Sales to Made-up Fundraising Bot" }));
  await waitFor(() =>
    expect(convex.mutation(api.bots.grant)).toHaveBeenCalledWith({ id: "b1", area: "sales", level: "write" }),
  );
  // One refusal is not a pattern: no Grant for a single one.
  expect(screen.getAllByRole("button", { name: /^Grant / })).toHaveLength(1);
});

test("a bot's week on Approvals is on its Week tab, and each of the four say theirs at the foot", () => {
  convex.setQuery(api.bots.list, { bots: [bot], suggestedMissing: 0 });
  convex.setQuery(api.bots.weeklyStats, [
    {
      key: "bot:fundraising",
      bot: "fundraising",
      agent: "chief_of_staff",
      decided: 4,
      approved: 3,
      rejected: 1,
      expired: 0,
      approvalRate: 0.75,
      medianDecisionMs: 3 * 3_600_000,
      topRejectReasons: [{ code: "rewrite_tone", count: 1 }],
    },
  ]);
  nav.query = "view=bots&bot=fundraising";
  render(<BotsTab now={NOW} />);
  tab("Week");
  expect(screen.getByTestId("bot-week").textContent).toBe(
    "This week: 4 decided · 75% approved · 3 h median to decide · top reasons: Rewrite tone (1).",
  );
  const own = screen.getByRole("region", { name: "Your four agents on Approvals" });
  expect(within(own).getAllByRole("listitem")).toHaveLength(4);
  expect(own.textContent).toContain("This week: nothing decided.");
});

test("a bot's plays and the autonomy it was given are tabs of their own", () => {
  convex.setQuery(api.bots.list, { bots: [bot], suggestedMissing: 0 });
  convex.setQuery(api.outcomes.playsByBot, [
    { by: "fundraising", plays: [{ play: "warm intro", worked: 2, failed: 1, pending: 0, winRate: 2 / 3 }] },
  ]);
  convex.setQuery(api.trust.grants, [
    { proposer: "fundraising", name: "Made-up Fundraising Bot", kind: "task_create", paused: null },
  ]);
  nav.query = "view=bots&bot=fundraising";
  render(<BotsTab now={NOW} />);
  tab("Plays");
  expect(screen.getByRole("table", { name: "Made-up Fundraising Bot's plays, last 30 days" }).textContent).toContain("warm intro");
  tab("Autonomy");
  expect(screen.getByRole("list", { name: "Approved without asking" }).textContent).toContain("task_create");
});

test("a bot's requests for a fix are a tab of their own, asked for that bot alone", () => {
  convex.setQuery(api.bots.list, { bots: [bot], suggestedMissing: 0 });
  convex.setQueryBy(api.devRequests.forBot, (args) =>
    (args as { botId: string }).botId === "fundraising"
      ? [
          {
            id: "r1",
            title: "Made-up: investors needs a stage filter",
            status: "needs_owner",
            decision: "The owner decides.",
            tool: "investors",
            refusalCode: null,
            issueUrl: "https://github.com/Made-Up-Org/made-up-os/issues/5",
            prUrl: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ]
      : [],
  );
  nav.query = "view=bots&bot=fundraising";
  render(<BotsTab now={NOW} />);
  tab("Requests");
  const panel = within(detail()).getByRole("tabpanel", { name: "Requests" });
  expect(panel.textContent).toContain("Needs you");
  expect(panel.textContent).toContain("Made-up: investors needs a stage filter");
  expect(within(panel).getByRole("link", { name: "Issue #5" })).toBeTruthy();
});

test("a bot with no plays and nothing approved without asking says so", () => {
  convex.setQuery(api.bots.list, { bots: [bot], suggestedMissing: 0 });
  convex.setQuery(api.outcomes.playsByBot, []);
  convex.setQuery(api.trust.grants, []);
  nav.query = "view=bots&bot=fundraising";
  render(<BotsTab now={NOW} />);
  tab("Plays");
  expect(within(detail()).getByRole("tabpanel", { name: "Plays" }).textContent).toContain("No play logged");
  tab("Autonomy");
  expect(within(detail()).getByRole("tabpanel", { name: "Autonomy" }).textContent).toContain("Nothing is approved");
});

test("the external owner-agents can be set up before its first call, and the duplicate threshold is the owner's", async () => {
  convex.setQuery(api.bots.list, { bots: [bot], suggestedMissing: 0, externalMissing: ["chief_of_staff", "engineering"] });
  convex.setQuery(api.duplicates.settings, { threshold: 0.82, isDefault: true, defaultThreshold: 0.82 });
  nav.query = "view=bots&settings=open";
  render(<BotsTab now={NOW} />);
  fireEvent.click(screen.getByRole("button", { name: "Set up the external chief of staff" }));
  await waitFor(() => expect(convex.mutation(api.bots.addExternalProfile)).toHaveBeenCalledWith({ id: "chief_of_staff" }));
  expect(screen.getByRole("button", { name: "Set up the external engineering agent" })).toBeTruthy();
  const form = screen.getByRole("form", { name: "Duplicate threshold" });
  fireEvent.change(within(form).getByLabelText("Duplicate threshold"), { target: { value: "0.9" } });
  fireEvent.click(within(form).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(convex.mutation(api.duplicates.setThreshold)).toHaveBeenCalledWith({ threshold: 0.9 }));
});

test("the table holds the last seven days: each bot's calls, approval, errors, last day seen, cost against budget, and an idle flag", () => {
  convex.setQuery(api.bots.list, { bots: [bot, other], suggestedMissing: 0 });
  convex.setQuery(api.bots.telemetry, [
    telemetryRow({
      calls7d: 120,
      errorRate7d: 0.025,
      schemaFailureRate7d: 0.1,
      p95Ms7d: 500,
      lastSeenDay: "2026-10-18",
      idle7d: false,
      approvalRate: 0.75,
      costMonthUsd: 1.2,
      costWhy: null,
      monthlyBudgetUsd: 50,
      company: "kz",
    }),
    telemetryRow({ botId: "research", name: "Made-up Research Bot", lastSeenDay: "2026-10-02" }),
  ]);
  render(<BotsTab now={NOW} />);
  const busy = rowOf("Made-up Fundraising Bot");
  expect(busy.textContent).toContain("120");
  expect(busy.textContent).toContain("75%");
  expect(busy.textContent).toContain("2.5%");
  expect(busy.textContent).toContain("10%");
  expect(busy.textContent).toContain("500 ms");
  expect(busy.textContent).toContain("2026-10-18");
  expect(busy.textContent).toContain("$1.20 of $50.00");
  expect(busy.textContent).toContain("Globex");
  expect(busy.textContent).not.toContain("Idle 7 days");
  const idle = rowOf("Made-up Research Bot");
  expect(idle.textContent).toContain("Idle 7 days");
  expect(idle.textContent).toContain("Not reported");
  expect(idle.textContent).toContain("2026-10-02");
  expect(idle.textContent).toContain("Off");
  // Nothing reported is said, never 0.
  expect(idle.textContent).not.toMatch(/\b0%/);
});

test("the same seven days are on the bot's Week tab, where a phone has no room for the columns", () => {
  convex.setQuery(api.bots.list, { bots: [bot], suggestedMissing: 0 });
  convex.setQuery(api.bots.telemetry, [
    telemetryRow({ calls7d: 120, schemaFailureRate7d: 0.1, p95Ms7d: 500, idle7d: false, lastSeenDay: "2026-10-18" }),
  ]);
  nav.query = "view=bots&bot=fundraising";
  render(<BotsTab now={NOW} />);
  tab("Week");
  const week = within(detail()).getByRole("tabpanel", { name: "Week" });
  expect(week.textContent).toContain("Bad arguments10%");
  expect(week.textContent).toContain("p95500 ms");
  expect(week.textContent).toContain("Cost this monthNot reported");
});

test("a bot's company and monthly budget are edited on its Permissions tab", async () => {
  convex.setQuery(api.bots.list, { bots: [{ ...bot, company: null, monthlyBudgetUsd: null }], suggestedMissing: 0 });
  nav.query = "view=bots&bot=fundraising";
  render(<BotsTab now={NOW} />);
  tab("Permissions");
  fireEvent.change(screen.getByLabelText("Company"), { target: { value: "kz" } });
  fireEvent.change(screen.getByLabelText("Monthly budget (USD)"), { target: { value: "50" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(convex.mutation(api.bots.update)).toHaveBeenCalledWith(
      expect.objectContaining({ id: "b1", company: "kz", monthlyBudgetUsd: 50 }),
    ),
  );
});

test("an empty budget takes it away; a company not set is not sent", async () => {
  convex.setQuery(api.bots.list, { bots: [{ ...bot, company: null, monthlyBudgetUsd: 20 }], suggestedMissing: 0 });
  nav.query = "view=bots&bot=fundraising";
  render(<BotsTab now={NOW} />);
  tab("Permissions");
  expect((screen.getByLabelText("Monthly budget (USD)") as HTMLInputElement).value).toBe("20");
  fireEvent.change(screen.getByLabelText("Monthly budget (USD)"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(convex.mutation(api.bots.update)).toHaveBeenCalled());
  const sent = convex.mutation(api.bots.update).mock.calls[0]![0] as Record<string, unknown>;
  expect(sent.monthlyBudgetUsd).toBeNull();
  expect("company" in sent).toBe(false);
});

test("Add a bot opens the form above the table; adding it opens the new bot", async () => {
  convex.setQuery(api.bots.list, { bots: [bot], suggestedMissing: 0 });
  render(<BotsTab now={NOW} />);
  fireEvent.click(screen.getByRole("button", { name: "Add a bot" }));
  const form = screen.getByRole("region", { name: "Add a bot" });
  fireEvent.change(within(form).getByLabelText("Id"), { target: { value: "growth" } });
  fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Made-up Growth Bot" } });
  await act(async () => {
    fireEvent.click(within(form).getByRole("button", { name: "Add bot" }));
  });
  expect(convex.mutation(api.bots.create)).toHaveBeenCalledWith(expect.objectContaining({ botId: "growth", name: "Made-up Growth Bot" }));
  expect(lastHref()).toBe("/agents?view=bots&bot=growth");
});
