"use client";

// The owner's bots (convex/bots.ts): external bots that call Startup OS through
// a connected client and name themselves. From the top: what the bots come to
// (counts, the week's calls, today's refusals, proposals to approve) and the
// buttons that add bots; one table of every bot with its last seven days, a
// filter, a search and a switch each; the open bot in a panel of its own
// (`BotDetail`); the settings every bot shares, folded away; and the week of
// the owner's four agents on Approvals. The filter, the search, the order,
// the open bot and the open settings live in the address (`bots-view.ts`).
// Owner only: the page mounts it for the owner.

import { useMutation, useQuery } from "convex/react";
import { ChevronDownIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { AGENT_IDS, AGENT_NAMES } from "@convex/lib/agents";
import { utcDayOf, type ExternalOwnerAgent } from "@convex/lib/botRules";
import { playsSince } from "@convex/lib/outcomes";
import { useWaitingCount } from "@/components/approvals/inbox";
import { Panel, fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import {
  BOT_FILTERS,
  BOT_FILTER_LABELS,
  DEFAULT_BOTS_VIEW,
  botFigures,
  filterCounts,
  readBotsView,
  shownBots,
  writeBotsView,
  type BotsView,
} from "@/lib/agents/bots-view";
import { weekLine, weekSince } from "@/lib/approvals/week";
import { messageOf } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { BotDetail } from "./bot-detail";
import { BotForm, blank, budgetOf, type Client, type Draft } from "./bot-form";
import { BotSettings } from "./bot-settings";
import { BotsTable, type BotTableRow } from "./bots-table";

/** The external profiles' set-up buttons: "Set up the external …". */
const EXTERNAL_LABELS: Record<ExternalOwnerAgent, string> = {
  chief_of_staff: "chief of staff",
  engineering: "engineering agent",
  finance: "finance bot",
};

export { GROK_STEPS, NEW_TOKEN_NOTE, REVOKED_NOTE, SHARED_CLIENT_NOTE, connectorAddressOf } from "./bot-detail";

/** One figure of the strip over the table. */
function Figure({ label, children, href }: { label: string; children: ReactNode; href?: string }) {
  const inner = (
    <>
      <p className="text-xs text-ink-2">{label}</p>
      <p className="mt-1 text-xl text-ink">{children}</p>
    </>
  );
  return (
    <li className="min-w-0">
      {href === undefined ? (
        <div className="h-full rounded-inner bg-surface p-2.5 sm:p-3">{inner}</div>
      ) : (
        <Link
          href={href}
          className="block h-full rounded-inner bg-surface p-2.5 outline-none sm:p-3 transition hover:bg-table-hover focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {inner}
        </Link>
      )}
    </li>
  );
}

export function BotsTab({ now, mcpUrl = null }: { now: number; mcpUrl?: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const view = readBotsView(params);

  const data = useQuery(api.bots.list, { today: utcDayOf(now) });
  // The page's UTC day, from its own clock: a query reads none.
  const activity = useQuery(api.bots.activity, { since: Date.parse(`${utcDayOf(now)}T00:00:00Z`) });
  const connected = useQuery(api.assistant.clients, {});
  // Each proposer's week on /approvals.
  const week = useQuery(api.bots.weeklyStats, { since: weekSince(now) });
  // Each bot's plays and their win rates over the last 30 days (Bot Loop v3).
  const plays = useQuery(api.outcomes.playsByBot, { since: playsSince(now) });
  // Every bot's last seven days and this month (Bot Loop v3, J), to the page's UTC day.
  const telemetry = useQuery(api.bots.telemetry, { today: utcDayOf(now) });
  // What waits on /approvals, both companies: the one count, as the navigation shows it.
  const toApprove = useWaitingCount();
  // The bots' requests for a fix still waiting on an answer or a release (convex/devRequests.ts).
  const openRequests = useQuery(api.devRequests.openCount, {});
  const create = useMutation(api.bots.create);
  const update = useMutation(api.bots.update);
  const addSuggested = useMutation(api.bots.addSuggested);
  const addExternalProfile = useMutation(api.bots.addExternalProfile);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seeded = useRef(false);
  // Each bot's name button in the table, so focus returns to it when its bot is closed.
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const returnTo = useRef<string | null>(null);
  // Set when a click opens a bot: its panel takes the focus. Not when the address opened it on load.
  const [clicked, setClicked] = useState<string | null>(null);

  // The suggested bots are added once, the first time the owner has none.
  useEffect(() => {
    if (data === undefined || seeded.current || data.bots.length > 0 || data.suggestedMissing === 0) return;
    seeded.current = true;
    void addSuggested({}).catch((failure: unknown) => setError(messageOf(failure)));
  }, [data, addSuggested]);

  // A bot closed: focus goes back to its row.
  useEffect(() => {
    if (view.bot !== null || returnTo.current === null) return;
    buttons.current.get(returnTo.current)?.focus();
    returnTo.current = null;
  }, [view.bot]);

  if (data === undefined || connected === undefined) {
    return (
      <div className="space-y-6" data-testid="bots-loading" aria-busy>
        <Skeleton className="h-36 rounded-card" />
        <Skeleton className="h-96 rounded-card" />
      </div>
    );
  }
  const clients: Client[] = connected.map((c) => ({ id: c.id, kind: c.kind, name: c.name }));

  const go = (next: BotsView, how: "replace" | "push" = "replace") => {
    const text = writeBotsView(params, next);
    const href = text === "" ? pathname : `${pathname}?${text}`;
    if (how === "push") router.push(href, { scroll: false });
    else router.replace(href, { scroll: false });
  };
  const openBot = (botId: string) => {
    if (botId === view.bot) return;
    setClicked(botId);
    go({ ...view, bot: botId }, "push");
  };
  const close = () => {
    returnTo.current = view.bot;
    setClicked(null);
    go({ ...view, bot: null });
  };
  const fail = (failure: unknown) => setError(messageOf(failure));

  const save = (id: Id<"bots"> | null) => async (draft: Draft) => {
    const permissions = draft.permissions.map((p) => ({ area: p.area as string, level: p.level as string }));
    const company = draft.company === null ? null : { company: draft.company };
    const monthlyBudgetUsd = budgetOf(draft.budget);
    if (id === null) {
      const { company: _company, budget: _budget, ...rest } = draft;
      await create({ ...rest, permissions, ...company, ...(monthlyBudgetUsd === null ? null : { monthlyBudgetUsd }) });
      setAdding(false);
      openBot(draft.botId);
    } else {
      await update({
        id,
        name: draft.name,
        role: draft.role,
        clients: draft.clients,
        permissions,
        limits: draft.limits,
        ...company,
        monthlyBudgetUsd,
      });
    }
  };

  const toggle = (botId: string, enabled: boolean) => {
    const bot = data.bots.find((b) => b.botId === botId);
    if (bot === undefined) return;
    setBusy(botId);
    setError(null);
    void update({ id: bot.id, enabled })
      .catch(fail)
      .finally(() => setBusy(null));
  };

  const weekOf = (botId: string) =>
    telemetry === undefined ? undefined : (telemetry.find((row) => row.botId === botId) ?? null);
  const rows: BotTableRow[] = data.bots.map((bot) => {
    const days = weekOf(bot.botId);
    return {
      botId: bot.botId,
      name: bot.name,
      role: bot.role,
      enabled: bot.enabled,
      suggested: bot.suggested,
      refusalsToday: bot.refusalsToday,
      idle: days?.idle7d ?? false,
      calls7d: days?.calls7d ?? null,
      approvalRate: days?.approvalRate ?? null,
      errorRate7d: days?.errorRate7d ?? null,
      lastSeenDay: days?.lastSeenDay ?? null,
      costMonthUsd: days?.costMonthUsd ?? null,
      week: days,
    };
  });
  const shown = shownBots(rows, view);
  const counts = filterCounts(rows);
  const figures = botFigures(rows);
  const open = view.bot === null ? undefined : data.bots.find((bot) => bot.botId === view.bot);
  const statOf = (key: string) => (week === undefined ? undefined : (week.find((stat) => stat.key === key) ?? null));

  return (
    <div className="space-y-6">
      <Panel aria-labelledby="bots-title" className="min-w-0 space-y-4">
        <div>
          <h2 id="bots-title" className="text-base">
            Bots
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-ink-2">
            Your external bots: who each is, what it may read and change, and its limits. A bot may use only the areas
            you give it, never payroll, costs, settings, the team, Today or your own pages. Only you see this.
          </p>
        </div>
        <ul aria-label="Bots at a glance" className="grid grid-cols-3 gap-2 sm:grid-cols-4 xl:grid-cols-8">
          <Figure label="Bots">{figures.bots}</Figure>
          <Figure label="On">{figures.on}</Figure>
          <Figure label="Off">{figures.off}</Figure>
          <Figure label="Idle 7 days">{telemetry === undefined ? <Skeleton className="h-7 w-8" /> : figures.idle}</Figure>
          <Figure label="Calls, 7 days">
            {telemetry === undefined ? (
              <Skeleton className="h-7 w-12" />
            ) : figures.calls7d === null ? (
              <span className="text-sm text-ink-2">None reported</span>
            ) : (
              figures.calls7d.toLocaleString("en-US")
            )}
          </Figure>
          <Figure label="Refused today">{figures.refusedToday.toLocaleString("en-US")}</Figure>
          <Figure label="Waiting on Approvals" href="/approvals">
            {toApprove === undefined ? <Skeleton className="h-7 w-8" /> : toApprove.toLocaleString("en-US")}
          </Figure>
          <Figure label="Open requests">
            {openRequests === undefined ? <Skeleton className="h-7 w-8" /> : openRequests.toLocaleString("en-US")}
          </Figure>
        </ul>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            aria-expanded={adding}
            className={primaryButtonClass}
            onClick={() => setAdding(!adding)}
          >
            Add a bot
          </button>
          {data.suggestedMissing > 0 && data.bots.length > 0 && (
            <button
              type="button"
              className={cn(quietButtonClass, "bg-surface text-ink")}
              onClick={() => void addSuggested({}).catch(fail)}
            >
              Add the {data.suggestedMissing} suggested
            </button>
          )}
          {(data.externalMissing ?? []).map((id) => (
            <button
              key={id}
              type="button"
              className={cn(quietButtonClass, "bg-surface text-ink")}
              onClick={() => void addExternalProfile({ id }).catch(fail)}
            >
              Set up the external {EXTERNAL_LABELS[id]}
            </button>
          ))}
        </div>
        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </Panel>

      {adding && (
        <Panel aria-label="Add a bot" className="min-w-0 space-y-4">
          <h2 className="text-base">Add a bot</h2>
          <BotForm initial={blank()} isNew clients={clients} onSave={save(null)} onCancel={() => setAdding(false)} />
        </Panel>
      )}

      <div
        className={cn(
          "grid min-w-0 gap-6",
          open !== undefined && "xl:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] xl:items-start",
        )}
      >
        <Panel aria-label="Every bot" className="min-w-0 space-y-4">
          {data.bots.length === 0 ? (
            <p className="text-sm text-ink-3">No bots yet. Add one, or the suggested ones are added for you.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <label className="relative block w-full min-w-0 sm:w-64">
                  <span className="sr-only">Find a bot</span>
                  <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
                  <input
                    type="search"
                    value={view.q}
                    placeholder="Find a bot by name or id"
                    onChange={(event) => go({ ...view, q: event.target.value })}
                    className={cn(fieldClass, "h-9 pl-9")}
                  />
                </label>
                <div role="group" aria-label="Show" className="flex flex-wrap gap-1">
                  {BOT_FILTERS.map((filter) => (
                    <button
                      key={filter}
                      type="button"
                      aria-pressed={view.filter === filter}
                      onClick={() => go({ ...view, filter })}
                      className={cn(
                        "h-8 rounded-full px-3 text-xs font-medium outline-none transition focus-visible:ring-3 focus-visible:ring-ring/50",
                        view.filter === filter ? "bg-brand-fill text-on-brand" : "bg-surface text-ink-2 hover:text-ink",
                      )}
                    >
                      {`${BOT_FILTER_LABELS[filter]} (${counts[filter]})`}
                    </button>
                  ))}
                </div>
              </div>
              {shown.length === 0 ? (
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-sm text-ink-2">No bot matches.</p>
                  <button
                    type="button"
                    onClick={() => go({ ...DEFAULT_BOTS_VIEW, bot: view.bot, settings: view.settings, sort: view.sort })}
                    className={cn(quietButtonClass, "h-9")}
                  >
                    Show every bot
                  </button>
                </div>
              ) : (
                <BotsTable
                  rows={shown}
                  selected={open === undefined ? null : open.botId}
                  sort={view.sort}
                  busy={busy}
                  onOpen={openBot}
                  onSort={(sort) => go({ ...view, sort })}
                  onToggle={toggle}
                  buttonRef={(botId, element) => {
                    if (element === null) buttons.current.delete(botId);
                    else buttons.current.set(botId, element);
                  }}
                />
              )}
            </>
          )}
        </Panel>

        {open !== undefined && (
          <Panel
            aria-label={`Bot ${open.name}`}
            className="min-w-0 xl:sticky xl:top-6 xl:max-h-[calc(100dvh-3rem)] xl:overflow-y-auto"
          >
            <BotDetail
              key={open.botId}
              bot={open}
              clients={clients}
              activity={activity === undefined ? undefined : (activity.find((row) => row.id === open.id) ?? null)}
              week={weekOf(open.botId)}
              weekStat={statOf(`bot:${open.botId}`)}
              plays={plays === undefined ? undefined : (plays.find((row) => row.by === open.botId)?.plays ?? [])}
              now={now}
              mcpUrl={mcpUrl}
              focusOnOpen={clicked === open.botId}
              onSave={(id, draft) => save(id)(draft)}
              onClose={close}
            />
          </Panel>
        )}
      </div>

      <Panel aria-labelledby="bots-settings" className="min-w-0 space-y-4">
        <div>
          <h2 id="bots-settings" className="text-base">
            <button
              type="button"
              aria-expanded={view.settings}
              onClick={() => go({ ...view, settings: !view.settings })}
              className="flex w-full items-center justify-between gap-3 rounded-inner text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Settings for every bot
              <ChevronDownIcon
                aria-hidden
                className={cn("size-5 shrink-0 text-ink-2 transition-transform", view.settings && "rotate-180")}
              />
            </button>
          </h2>
          <p className="mt-1 text-xs text-ink-2">
            What every bot is held to, the rules it is given, and how alike a duplicate must be.
          </p>
        </div>
        {view.settings && <BotSettings bots={data.bots.map((b) => ({ botId: b.botId, name: b.name }))} now={now} />}
      </Panel>

      {week !== undefined && (
        <Panel aria-labelledby="own-agents-week" className="min-w-0 space-y-2">
          <h2 id="own-agents-week" className="text-sm font-medium text-ink">
            Your four agents on Approvals
          </h2>
          <ul className="grid gap-x-6 gap-y-1 lg:grid-cols-2">
            {AGENT_IDS.map((agent) => (
              <li key={agent} className="py-1 text-xs text-ink-2">
                <span className="font-medium text-ink">{AGENT_NAMES[agent]}</span> · {weekLine(statOf(agent) ?? undefined)}
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
