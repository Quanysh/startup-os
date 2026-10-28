"use client";

// One bot, opened from the table on Agents › Bots: a panel beside the table on
// a wide screen and under it on a narrow one, in six tabs. Overview: what it
// may do, its limits and today, its own connector address, the line to give
// it and its own token. Activity: its last calls and today's refusals, with
// Grant on a repeated "not permitted". Permissions: the form. Autonomy: what
// it may do without asking. Plays and Week: its outcomes and its last seven
// days. Requests: what it asked Startup OS's developers for (`dev_request`).
// Escape or Close closes it.

import { useMutation, useQuery } from "convex/react";
import { XIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import {
  REFUSAL_LABELS,
  instructionLine,
  isBotArea,
  permissionSummary,
  type BotRefusalCode,
} from "@convex/lib/botRules";
import { PRODUCT } from "@convex/lib/identity";
import type { PlayTally } from "@convex/lib/outcomes";
import { BotGrants } from "@/components/approvals/autonomy";
import { CopyButton, codeClass } from "@/components/assistant/copy-button";
import { outlineButtonClass, quietButtonClass } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { agoText } from "@/lib/agents/bots-view";
import { weekLine, type WeekStat } from "@/lib/approvals/week";
import { messageOf } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { randomNonce } from "@/lib/work/pkce";
import { AREA_NAMES, BotForm, clientSummary, type Client, type Draft } from "./bot-form";
import { BotPlays } from "./bot-plays";
import { BotRequests } from "./bot-requests";
import { BotWeekFigures, type BotWeekRow } from "./bot-week";
import { Toggle } from "./parts";

/** Said beside a bot's token: a shared client's bots name themselves, so one could claim another's name. */
/** Said beside "Make a token for this bot": a bot has one live token of its own. */
export const NEW_TOKEN_NOTE = "Making a new token stops this bot's previous one from working.";
/** Said with a new token when an older one was stopped. */
export const REVOKED_NOTE = "Its previous token no longer works.";

export const SHARED_CLIENT_NOTE =
  `Bots that share one client can claim each other's names: ${PRODUCT.name} knows a bot only by the name it sends. For real separation, give each bot that takes a static token its own (Make a token for this bot): that token is for that bot alone, and becomes its only client.`;

/** A bot's own connector address: the endpoint's, with `/bot/<id>`. Null when the app's address is not known. */
export const connectorAddressOf = (mcpUrl: string | null, botId: string): string | null =>
  mcpUrl === null ? null : `${mcpUrl}/bot/${botId}`;

/** What the owner does in Grok with a bot's address. Adding a connector inside the bot's own chat keeps that chat. */
export const GROK_STEPS = [
  "Open this bot's own chat in Grok, then its connectors, and add a custom connector with this address.",
  `Sign in to ${PRODUCT.name} as yourself and approve. The sign-in is for this bot alone.`,
  "Turn the connector on in this bot's chat only. The chat keeps its instructions and memory.",
  "Ask the bot to call whoami: it should answer with its own id.",
] as const;

export type ListBot = NonNullable<ReturnType<typeof useQuery<typeof api.bots.list>>>["bots"][number];
export type Activity = NonNullable<ReturnType<typeof useQuery<typeof api.bots.activity>>>[number];

const TABS = ["overview", "activity", "permissions", "autonomy", "plays", "requests", "week"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  overview: "Overview",
  activity: "Activity",
  permissions: "Permissions",
  autonomy: "Autonomy",
  plays: "Plays",
  requests: "Requests",
  week: "Week",
};

const OUTCOME_WORDS: Record<string, string> = { ok: "Done", refused: "Refused", invalid: "Not valid", error: "Failed" };

/** A section of a tab: a small heading over what it says. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-2">
      <h4 className="text-xs font-medium text-ink-2">{title}</h4>
      {children}
    </div>
  );
}

function CopyLine({ botId }: { botId: string }) {
  const line = instructionLine(botId);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <code className="min-w-0 break-all rounded-inner bg-surface px-2 py-1 text-xs text-ink-2">{line}</code>
      <CopyButton text={line} label="Copy" />
    </div>
  );
}

function ConnectorAddress({ address }: { address: string }) {
  return (
    <Section title="Connector address">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <code className="min-w-0 break-all rounded-inner bg-surface px-2 py-1 text-xs text-ink-2">{address}</code>
        <CopyButton text={address} label="Copy address" />
      </div>
      <details className="text-xs text-ink-2">
        <summary className="cursor-pointer text-ink outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          Add it in Grok
        </summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          {GROK_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </details>
    </Section>
  );
}

/** A refusal group in words: "6× Not permitted on Sales (write)". */
function refusalWords(group: Activity["refusals"][number]): string {
  const label = REFUSAL_LABELS[group.code as BotRefusalCode] ?? group.code;
  const on = group.area === null ? "" : ` on ${AREA_NAMES[group.area] ?? group.area}`;
  const need = group.need === null ? "" : ` (${group.need})`;
  return `${group.count}× ${label}${on}${need}`;
}

/** A not-permitted refusal seen more than once today, on an area the owner may give: Grant offers it in one click. */
const grantable = (group: Activity["refusals"][number]) =>
  group.code === "not_permitted" && group.count >= 2 && group.area !== null && group.need !== null && isBotArea(group.area);

/**
 * A bot's last calls (tool, outcome, when) and what was refused today, by
 * code; a repeated "not permitted" has Grant beside it, which gives that
 * level on that area at once (`bots.grant`).
 */
function BotActivity({
  name,
  activity,
  now,
  onGrant,
}: {
  name: string;
  activity: Activity;
  now: number;
  onGrant: (area: string, level: "read" | "write") => void;
}) {
  return (
    <div className="grid min-w-0 gap-4">
      <div className="min-w-0" data-testid={`refusals-${activity.id}`}>
        <h4 className="text-xs font-medium text-ink-2">Refused today</h4>
        {activity.refusals.length === 0 ? (
          <p className="mt-1 text-sm text-ink-3">Nothing.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {activity.refusals.map((group) => (
              <li key={`${group.code}:${group.area ?? ""}:${group.need ?? ""}`} className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
                <span>{refusalWords(group)}</span>
                {grantable(group) && (
                  <button
                    type="button"
                    aria-label={`Grant ${group.need} on ${AREA_NAMES[group.area!] ?? group.area} to ${name}`}
                    onClick={() => onGrant(group.area!, group.need as "read" | "write")}
                    className={outlineButtonClass}
                  >
                    Grant {group.need}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="min-w-0">
        <h4 className="text-xs font-medium text-ink-2">Last calls</h4>
        {activity.recent.length === 0 ? (
          <p className="mt-1 text-sm text-ink-3">None yet.</p>
        ) : (
          <ul aria-label={`Last calls of ${name}`} className="mt-1 divide-y divide-line">
            {activity.recent.map((row) => (
              <li key={row.id} className="flex min-w-0 flex-wrap gap-x-2 py-1 text-xs text-ink-2">
                <code className="break-all text-ink">{row.tool}</code>
                <span className={row.outcome === "ok" ? "text-ink-2" : "text-danger-ink"}>
                  {row.code === null ? OUTCOME_WORDS[row.outcome] ?? row.outcome : REFUSAL_LABELS[row.code as BotRefusalCode] ?? row.code}
                </span>
                <span className="text-ink-3">{agoText(row.at, now)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** What is approved for this bot without asking, or that nothing is. */
function Autonomy({ botId }: { botId: string }) {
  const grants = useQuery(api.trust.grants, {});
  if (grants === undefined) return <Skeleton className="h-10 rounded-inner" />;
  if (!grants.some((g) => g.proposer === botId)) {
    return <p className="text-sm text-ink-3">Nothing is approved for this bot without asking. Grants are earned on Approvals.</p>;
  }
  return <BotGrants botId={botId} />;
}

const isField = (target: EventTarget) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

export function BotDetail({
  bot,
  clients,
  activity,
  week,
  weekStat,
  plays,
  now,
  mcpUrl,
  focusOnOpen,
  onSave,
  onClose,
}: {
  bot: ListBot;
  clients: readonly Client[];
  /** Its calls and refusals; undefined while they load. */
  activity: Activity | undefined | null;
  /** Its seven days; undefined while they load, null when there is no row. */
  week: BotWeekRow | null | undefined;
  /** Its week on Approvals; undefined while it loads. */
  weekStat: WeekStat | undefined | null;
  /** Its plays; undefined while they load. */
  plays: readonly PlayTally[] | undefined;
  now: number;
  mcpUrl: string | null;
  /** Opened by a click: its heading takes the focus (and comes into view). */
  focusOnOpen: boolean;
  onSave: (id: Id<"bots">, draft: Draft) => Promise<void>;
  onClose: () => void;
}) {
  const update = useMutation(api.bots.update);
  const grant = useMutation(api.bots.grant);
  const makeToken = useMutation(api.bots.makeToken);
  const [tab, setTab] = useState<Tab>("overview");
  // A token just made, shown once. In this component's memory only.
  const [fresh, setFresh] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (focusOnOpen) heading.current?.focus();
  }, [focusOnOpen]);

  const fail = (failure: unknown) => setError(messageOf(failure));
  const address = connectorAddressOf(mcpUrl, bot.botId);
  const refusedToday = activity?.refusals.reduce((sum, group) => sum + group.count, 0) ?? bot.refusalsToday;

  const onKeyDown = (event: KeyboardEvent) => {
    // Escape closes the bot, but not from a field: there it belongs to the field.
    if (event.key === "Escape" && !isField(event.target)) {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div className="space-y-4" onKeyDown={onKeyDown}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 ref={heading} tabIndex={-1} className="text-base break-words outline-none">
            {bot.name}
          </h3>
          <p className="mt-0.5 text-xs text-ink-2">
            <code>{bot.botId}</code>
            {bot.role !== "" && ` · ${bot.role}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Toggle
            on={bot.enabled}
            label={`${bot.name} on`}
            disabled={busy}
            onChange={(enabled) => {
              setBusy(true);
              void update({ id: bot.id, enabled })
                .catch(fail)
                .finally(() => setBusy(false));
            }}
          />
          <button type="button" onClick={onClose} className={cn(quietButtonClass, "h-9 px-3")}>
            <XIcon aria-hidden className="size-4" />
            Close
          </button>
        </div>
      </div>

      <div role="tablist" aria-label="This bot" className="flex max-w-full flex-wrap gap-0.5 rounded-inner bg-surface p-1">
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
            className={cn(
              "h-8 rounded-full px-2.5 text-xs font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              tab === name ? "bg-brand-fill text-on-brand" : "text-ink-2 hover:text-ink",
            )}
          >
            {TAB_LABELS[name]}
            {name === "activity" && refusedToday > 0 && ` · ${refusedToday} refused`}
          </button>
        ))}
      </div>

      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div role="tabpanel" aria-label={TAB_LABELS[tab]} className="min-w-0 space-y-5">
        {tab === "overview" && (
          <>
            <Section title="What it may do">
              <p className="text-sm text-ink">
                {clientSummary(bot.clients, clients)} · {permissionSummary(bot.permissions, AREA_NAMES)}
              </p>
              <button type="button" onClick={() => setTab("permissions")} className={outlineButtonClass}>
                Change permissions
              </button>
            </Section>
            <Section title="Limits and today">
              <p className="text-sm text-ink-2">
                {bot.limits.callsPer10Min.toLocaleString("en-US")} calls and {bot.limits.changesPer10Min} changes per 10 min,{" "}
                {bot.limits.proposalsPerDay} proposals a day · last call {agoText(bot.lastCallAt, now)} · today{" "}
                {bot.callsToday} calls, {bot.refusalsToday} refused
              </p>
            </Section>
            {address !== null && <ConnectorAddress address={address} />}
            <Section title="The line to give it">
              <CopyLine botId={bot.botId} />
            </Section>
            <Section title="Its own token">
              <p className="text-xs text-ink-2">{SHARED_CLIENT_NOTE}</p>
              <p className="text-xs text-ink-2">{NEW_TOKEN_NOTE}</p>
              {fresh === null ? (
                <button
                  type="button"
                  className={outlineButtonClass}
                  onClick={() =>
                    void makeToken({ id: bot.id, entropy: randomNonce() }).then((made) => {
                      setRevoked(made.revoked);
                      setFresh(made.token);
                    }, fail)
                  }
                >
                  Make a token for this bot
                </button>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-ink">
                    This is {bot.name}&apos;s own token. You will not see it again. It is now this bot&apos;s only client.
                  </p>
                  {revoked > 0 && <p className="text-sm text-ink-2">{REVOKED_NOTE}</p>}
                  <code data-testid="bot-token" className={codeClass}>
                    {fresh}
                  </code>
                  <CopyButton text={fresh} label="Copy token" />
                </div>
              )}
            </Section>
          </>
        )}

        {tab === "activity" &&
          (activity === undefined ? (
            <Skeleton className="h-24 rounded-inner" />
          ) : activity === null ? (
            <p className="text-sm text-ink-3">No calls yet.</p>
          ) : (
            <BotActivity
              name={bot.name}
              activity={activity}
              now={now}
              onGrant={(area, level) => void grant({ id: bot.id, area, level }).catch(fail)}
            />
          ))}

        {tab === "permissions" && (
          <BotForm
            initial={{
              botId: bot.botId,
              name: bot.name,
              role: bot.role,
              clients: bot.clients,
              permissions: bot.permissions,
              limits: bot.limits,
              company: bot.company ?? null,
              budget: bot.monthlyBudgetUsd == null ? "" : String(bot.monthlyBudgetUsd),
            }}
            isNew={false}
            clients={clients}
            onSave={(draft) => onSave(bot.id, draft).then(() => setTab("overview"))}
            onCancel={() => setTab("overview")}
          />
        )}

        {tab === "autonomy" && <Autonomy botId={bot.botId} />}

        {tab === "plays" &&
          (plays === undefined ? (
            <Skeleton className="h-24 rounded-inner" />
          ) : plays.length === 0 ? (
            <p className="text-sm text-ink-3">No play logged an outcome in the last 30 days.</p>
          ) : (
            <BotPlays name={bot.name} plays={plays} />
          ))}

        {tab === "requests" && <BotRequests botId={bot.botId} name={bot.name} />}

        {tab === "week" && (
          <>
            <Section title="On Approvals">
              {weekStat === undefined ? (
                <Skeleton className="h-5 rounded-inner" />
              ) : (
                <p className="text-sm text-ink-2" data-testid="bot-week">
                  {weekLine(weekStat ?? undefined)}
                </p>
              )}
            </Section>
            <Section title="Last 7 days">
              {week === undefined ? (
                <Skeleton className="h-24 rounded-inner" />
              ) : week === null ? (
                <p className="text-sm text-ink-3">Nothing reported.</p>
              ) : (
                <BotWeekFigures row={week} />
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
