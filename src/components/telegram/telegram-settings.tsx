"use client";

import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Loader2Icon, SearchIcon, SendIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { api } from "@convex/_generated/api";
import { PRODUCT } from "@convex/lib/identity";
import { GatedLink } from "@/components/gated-link";
import { Panel, fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import { TelegramLink } from "@/components/team/telegram-link";
import {
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
} from "@/components/ui/data-table";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { KindTag, StatusChip } from "@/components/ui/status-chip";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { COMPANIES, companyIds, hashtagOf, manyCompanies, type CompanyId } from "@/lib/company";
import { localIsoDate } from "@/lib/dates";
import { messageOf } from "@/lib/errors";
import { ageLabel } from "@/lib/freshness";
import { cn } from "@/lib/utils";

type Settings = FunctionReturnType<typeof api.telegram.settings>;

/** What someone without the page reads in its place. */
export const TELEGRAM_NOT_YOURS =
  "Only the owner, and people the owner gives the Sources and Telegram pages, set up Telegram.";

/**
 * The rule for a teammate who has the page on one company (convex/telegram.ts,
 * "Who may see and change what"), said to them in full. The server enforces
 * it; the page only leaves out, or blocks, what would be refused.
 */
export const ONE_COMPANY_NOTE = (company: string) =>
`You are on ${company} only. You see ${company}'s group and can send it a test message. The owner picks the groups. Whether messages are sent at all, where an untagged task goes and whether commands are on are shared by both companies: only the owner, or someone who is on both, changes them. The other company's group is not shown to you.`;

/** Said to a holder of the page who is not the owner, where the owner has the pickers. */
export const GROUPS_OWNERS = "The owner picks the groups.";

/** Said beside the buttons that turn commands on and off, to someone who may not. */
export const COMMANDS_SHARED =
  "Commands are shared by both companies: only the owner, or someone who is on both, turns them on or off.";

/** The companies whose group this viewer picks and tests: their own. */
function useMyCompanies(): CompanyId[] {
  const { companies } = useViewer();
  return companyIds().filter((id) => companies.includes(id));
}

const linkClass = "font-medium text-brand underline-offset-4 hover:underline";
const KIND_LABEL = { group: "Group", supergroup: "Supergroup" } as const;
const codeClass = "rounded bg-surface px-1 py-0.5 font-mono text-[0.8125rem] break-words text-ink";

/** The command that makes the bot see a group, with the bot's own name once it is known. */
const startCommand = (settings: Settings) =>
  settings.botUsername === null
    ? "/start@ followed by the bot's username"
    : `/start@${settings.botUsername}`;

const UNTAGGED_CHOICES = [
  ["kz", COMPANIES.kz.name],
  ["us", COMPANIES.us.name],
  ["both", "Both boards"],
] as const;
type Untagged = (typeof UNTAGGED_CHOICES)[number][0];

/** A button that stays focusable while its request runs, and ignores a second press. */
function BusyButton({
  busy,
  blocked = false,
  onPress,
  className,
  icon,
  children,
}: {
  busy: boolean;
  /** Not available at all (and says so beside it), as opposed to busy for a moment. */
  blocked?: boolean;
  onPress: () => void;
  className: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    // aria-disabled, not disabled: a natively disabled button drops focus mid-request.
    <button
      type="button"
      aria-disabled={busy || blocked}
      onClick={() => {
        if (!busy && !blocked) onPress();
      }}
      className={cn(className, "aria-disabled:opacity-60")}
    >
      {busy ? <Loader2Icon aria-hidden className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

function Failure({ children }: { children: string | null }) {
  if (children === null) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  );
}

/** The steps, in the order they are done. Nothing here takes the token. */
function Steps({ settings }: { settings: Settings }) {
  return (
    <Panel aria-labelledby="telegram-steps">
      <h2 id="telegram-steps" className="text-base">
        Set it up
      </h2>
      <ol className="mt-3 max-w-2xl list-decimal space-y-2 pl-5 text-sm text-ink-2">
        <li>
          In Telegram, open a chat with <span className="font-medium text-ink">@BotFather</span>,
          send <span className="font-medium text-ink">/newbot</span> and follow it. It gives the
          bot a name and you a token.
        </li>
        <li>
          In the Convex dashboard, set the variable{" "}
          <span className="font-medium break-all text-ink">TELEGRAM_BOT_TOKEN</span> to that
          token. Never paste the token here, in a task or in a chat: the OS reads it from that
          variable and shows it nowhere.{" "}
          {settings.tokenSet ? (
            <StatusChip tone="success">Token set</StatusChip>
          ) : (
            <StatusChip tone="neutral">Token not set</StatusChip>
          )}
        </li>
        <li>
          Give each teammate their Telegram username on the{" "}
          <GatedLink href="/settings/team" className={linkClass}>
            Team
          </GatedLink>{" "}
          page and set your own at the foot of this page, so the bot can tag them and knows whose
          groups to list.
        </li>
        <li>Add the bot to the group of each company, as you would add a person.</li>
        <li>
          In the group, send {startCommand(settings)} (a command addressed to the bot; any
          message that mentions the bot does too), so the bot sees the group.
        </li>
        <li>
          Below, click <span className="font-medium text-ink">Find my groups</span>, pick the group
          for each company and save.
        </li>
        <li>
          Click <span className="font-medium text-ink">Send a test message</span> and look for it
          in the group.
        </li>
        <li>
          Once the groups are connected, open <span className="font-medium text-ink">@BotFather</span>
          , choose the bot under <span className="font-medium text-ink">/mybots</span>, then{" "}
          <span className="font-medium text-ink">Bot Settings</span>, and turn off{" "}
          <span className="font-medium text-ink">Allow Groups</span>, so that nobody can add the
          bot to a group of their own.
        </li>
      </ol>
      <p className="mt-4 max-w-2xl text-sm text-ink-2">
        A group is listed only when someone whose username is on record here adds the bot to it or
        writes to the bot in it. Anyone can add a bot to a group of their own and give it your
        group&apos;s name, so a group nobody on record is in is never offered.
      </p>
      <p className="mt-2 max-w-2xl text-sm text-ink-2">
        A message says who the task is for, its title, its company, its due date, who assigned it
        and a link to the board. It holds never the task&apos;s notes or anyone&apos;s email
        address. Nobody is told when they give a task to themselves.
      </p>
      {!settings.siteSet && (
        <p className="mt-2 max-w-2xl text-sm text-ink-2">
          <span className="font-medium text-ink">SITE_URL</span> is not set on the Convex
          deployment to this site&apos;s address, so messages carry no link to the board.
        </p>
      )}
    </Panel>
  );
}

type Offered = { id: string; title: string; members?: number };

/** "12 members", "1 member", or nothing when Telegram has not said. */
const membersOf = (chat: Offered) =>
  chat.members === undefined
    ? undefined
    : `${chat.members} ${chat.members === 1 ? "member" : "members"}`;

/**
 * A group as the picker names it: its title, its id and how many are in it.
 * Two groups can have one title, and anyone can make a group with yours.
 */
const offerOf = (chat: Offered) =>
  [chat.title, `id ${chat.id}`, membersOf(chat)].filter((part) => part !== undefined).join(" · ");

/** How one company's last test went, if the last test was its own. */
function TestOutcome({ test, company }: { test: Settings["test"]; company: CompanyId }) {
  if (test === null || test.company !== company) return null;
  const group = `${COMPANIES[company].name}'s group`;
  if (test.outcome === "sending") return <StatusChip tone="info">Sending to {group}…</StatusChip>;
  if (test.outcome === "sent") return <StatusChip tone="success">Sent to {group}</StatusChip>;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <StatusChip tone="danger">Not sent to {group}</StatusChip>
      {test.error !== null && <span className="text-sm text-ink-2">{test.error}</span>}
    </span>
  );
}

/**
 * Which group each company's messages go to, and whether they are sent at
 * all. What the owner has chosen and not yet saved is a draft that a live
 * update never replaces; an untouched field follows the server.
 */
function Groups({ settings }: { settings: Settings }) {
  const mine = useMyCompanies();
  // What both companies share is changed only by someone on both.
  const shared = settings.canChangeShared;
  // Which group is a company's, and the list it is picked from, are the owner's alone.
  const picks = settings.canPickGroups;
  const save = useMutation(api.telegram.save);
  const findChats = useMutation(api.telegram.findChats);
  const sendTest = useMutation(api.telegram.sendTest);
  const [draft, setDraft] = useState<{
    enabled?: boolean;
    us?: string;
    kz?: string;
    untagged?: Untagged;
  }>({});
  const untaggedId = useId();
  const untaggedHintId = useId();
  const [busy, setBusy] = useState<"save" | "find" | CompanyId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const switchId = useId();
  const pickerId = useId();

  const enabled = draft.enabled ?? settings.enabled;
  const chosen = (company: CompanyId) => draft[company] ?? settings.chats[company]?.id ?? "";

  // Everything a company can be given: what is already picked, then what else was found.
  // A group listed with how many are in it is named with that, wherever it is listed.
  const known = new Map<string, Offered>();
  for (const chat of [settings.chats.us, settings.chats.kz, ...(settings.found ?? [])]) {
    if (chat === null) continue;
    const listed = known.get(chat.id);
    if (listed === undefined || (listed.members === undefined && chat.members !== undefined)) {
      known.set(chat.id, { ...listed, ...chat });
    }
  }

  const run = async (what: "save" | "find" | CompanyId, work: () => Promise<unknown>) => {
    if (busy !== null) return;
    setBusy(what);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(messageOf(failure, "That could not be done. Try again."));
    } finally {
      setBusy(null);
    }
  };

  const onSave = () =>
    run("save", async () => {
      // Naming a setting is asking to change it: only what is this viewer's
      // to change is sent, or the whole save would be refused.
      await save({
        ...(shared ? { enabled } : null),
        ...(picks ? { chatUs: chosen("us") || null, chatKz: chosen("kz") || null } : null),
        // Sent only when it was changed.
        ...(shared && draft.untagged !== undefined ? { untagged: draft.untagged } : null),
      });
      // Saved: the fields follow the server again.
      setDraft({});
    });

  const finding = settings.finding || busy === "find";
  const untestable = mine.filter((id) => settings.chats[id] === null);

  return (
    <Panel aria-labelledby="telegram-groups">
      <h2 id="telegram-groups" className="text-base">
        Groups
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-2">
        {manyCompanies() ? (
          <>
            A task of one company goes to that company&apos;s group. A task shared by both goes to{" "}
            {COMPANIES.us.name}&apos;s group if one is picked, otherwise to {COMPANIES.kz.name}&apos;s.
          </>
        ) : (
          "Every task goes to the company's group."
        )}
      </p>
      {!shared && (
        <p className="mt-2 max-w-2xl rounded-inner bg-surface p-3 text-sm text-ink-2">
          {ONE_COMPANY_NOTE(mine.map((id) => COMPANIES[id].name).join(" and "))}
        </p>
      )}

      {picks ? (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
            <BusyButton
              busy={finding}
              onPress={() => run("find", () => findChats({}))}
              className={quietButtonClass}
              icon={<SearchIcon aria-hidden className="size-4" />}
            >
              {finding ? "Looking…" : "Find my groups"}
            </BusyButton>
            {settings.findError !== null && (
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <StatusChip tone="danger">Could not look</StatusChip>
                <span className="text-sm text-ink-2">{settings.findError}</span>
              </span>
            )}
          </div>

          {settings.commands.state === "on" && settings.commands.wanted && (
            <p className="mt-2 max-w-2xl text-xs text-ink-2">
              Commands are on, so groups appear here as the bot sees them: send{" "}
              {startCommand(settings)} in a group and it is listed.
            </p>
          )}

          {settings.found === null ? (
            <p className="mt-3 max-w-2xl text-sm text-ink-3">
              No groups found yet. Follow the steps above, then look for them here.
            </p>
          ) : settings.found.length === 0 ? (
            <div className="mt-3 max-w-2xl space-y-1 text-sm text-ink-2">
              <p>
                The bot has not seen a group yet. In the group, send {startCommand(settings)}, then
                click Find my groups again.
              </p>
              <p className="text-xs">
                A bot only sees commands and messages that mention it, so people talking in the group
                is not enough. And a group is listed only when whoever sends that, or added the bot,
                has their Telegram username on record here.
              </p>
            </div>
          ) : (
            <DataTable caption="Groups the bot has seen" className="min-w-[24rem]" boxClassName="mt-3">
              <DataHead>
                <DataHeader pinned>Group</DataHeader>
                <DataHeader>Kind</DataHeader>
                <DataHeader>Members</DataHeader>
                <DataHeader>Id</DataHeader>
              </DataHead>
              <DataBody>
                {settings.found.map((chat) => (
                  <DataRow key={chat.id}>
                    <DataRowHeader pinned className="font-normal break-words">
                      {chat.title}
                    </DataRowHeader>
                    <DataCell>
                      <KindTag tone={chat.type === "supergroup" ? "violet" : "teal"}>
                        {KIND_LABEL[chat.type]}
                      </KindTag>
                    </DataCell>
                    <DataCell className="font-num whitespace-nowrap text-ink-2">
                      {chat.members ?? <span className="text-ink-3">Not counted</span>}
                    </DataCell>
                    <DataCell className="font-num whitespace-nowrap text-ink-2">{chat.id}</DataCell>
                  </DataRow>
                ))}
              </DataBody>
            </DataTable>
          )}
          <div className="mt-5 flex flex-wrap gap-x-6 gap-y-4">
            {mine.map((company) => (
              <div key={company} className="w-full space-y-1.5 sm:w-64">
                <Label htmlFor={`${pickerId}-${company}`}>{COMPANIES[company].name}&apos;s group</Label>
                <select
                  id={`${pickerId}-${company}`}
                  value={chosen(company)}
                  onChange={(e) => setDraft((d) => ({ ...d, [company]: e.target.value }))}
                  className={`${fieldClass} h-10`}
                >
                  <option value="">None</option>
                  {[...known.values()].map((chat) => (
                    <option key={chat.id} value={chat.id}>
                      {offerOf(chat)}
                    </option>
                  ))}
                </select>
                {settings.chats[company]?.left === true && (
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
                    <StatusChip tone="warning">Left the group</StatusChip>
                    <span>
                      The bot is no longer in this group. Add it again in Telegram, or pick another
                      group.
                    </span>
                  </p>
                )}
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="mt-4 max-w-2xl space-y-3">
          <p className="text-sm text-ink-2">{GROUPS_OWNERS}</p>
          {mine.map((company) => {
            const chat = settings.chats[company];
            return (
              <div key={company} className="space-y-1">
                <p className="text-sm font-medium text-ink">{COMPANIES[company].name}&apos;s group</p>
                <p className="text-sm text-ink-2">
                  {chat === null ? "None yet: the owner has not picked one." : offerOf(chat)}
                </p>
                {chat?.left === true && (
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
                    <StatusChip tone="warning">Left the group</StatusChip>
                    <span>
                      The bot is no longer in this group. The owner adds it again or picks another.
                    </span>
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* With one company every task is its own: there is nothing to pick. */}
      {manyCompanies() && (
        <>
          <div className="mt-4 w-full space-y-1.5 sm:w-64">
            <Label htmlFor={untaggedId}>{`A task with no ${hashtagOf("us")} or ${hashtagOf("kz")} goes to:`}</Label>
            <select
              id={untaggedId}
              value={draft.untagged ?? settings.untagged}
              aria-describedby={untaggedHintId}
              disabled={!shared}
              onChange={(e) => setDraft((d) => ({ ...d, untagged: e.target.value as Untagged }))}
              className={`${fieldClass} h-10`}
            >
              {UNTAGGED_CHOICES.map(([value, name]) => (
                <option key={value} value={value}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <p id={untaggedHintId} className="mt-1.5 max-w-2xl text-xs text-ink-2">
            For a task added from Telegram. Used when one group is picked for both companies. A
            group picked for one company sends an untagged task to that company.
          </p>
        </>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-labelledby={switchId}
          aria-disabled={!shared}
          onClick={() => {
            if (shared) setDraft((d) => ({ ...d, enabled: !enabled }));
          }}
          className={cn(
            "relative h-6 w-11 shrink-0 rounded-full outline-none transition focus-visible:ring-3 focus-visible:ring-ring/50 aria-disabled:opacity-60",
            enabled ? "bg-brand" : "bg-input",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "absolute top-0.5 left-0.5 size-5 rounded-full bg-panel shadow-soft transition",
              enabled && "translate-x-5",
            )}
          />
        </button>
        <span id={switchId} className="text-sm text-ink">
          Send a message when a task is assigned
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {/* With nothing of theirs to change there is nothing to save. */}
        {(picks || shared) && (
          <BusyButton busy={busy === "save"} onPress={onSave} className={primaryButtonClass}>
            Save
          </BusyButton>
        )}
        {mine.map((company) => (
          <BusyButton
            key={company}
            busy={busy === company}
            blocked={settings.chats[company] === null}
            onPress={() => run(company, () => sendTest({ company }))}
            className={quietButtonClass}
            icon={<SendIcon aria-hidden className="size-4" />}
          >
            Send a test message to {COMPANIES[company].name}&apos;s group
          </BusyButton>
        ))}
      </div>
      {picks && untestable.length > 0 && (
        <p className="mt-2 text-xs text-ink-2">
          Save a group for {untestable.map((id) => COMPANIES[id].name).join(" and ")} to test it.
        </p>
      )}
      <div className="mt-3 flex flex-col gap-2">
        {mine.map((company) => (
          <TestOutcome key={company} test={settings.test} company={company} />
        ))}
        <Failure>{error}</Failure>
      </div>
    </Panel>
  );
}

const COMMANDS_STATE = {
  unknown: ["neutral", "Not checked yet"],
  off: ["neutral", "Off"],
  on: ["success", "On"],
  elsewhere: ["warning", "The bot's updates go to another address"],
} as const;

/**
 * Adding tasks from the group: what people can type, who may, and whether
 * Telegram sends the bot's updates here. Turning it on or off and checking
 * run in the background; how each went arrives with the settings.
 */
function Commands({ settings }: { settings: Settings }) {
  const turnOn = useMutation(api.telegramInbound.commandsOn);
  const turnOff = useMutation(api.telegramInbound.commandsOff);
  const check = useMutation(api.telegramInbound.checkCommands);
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { commands } = settings;
  const shared = settings.canChangeShared;
  const bot = settings.botUsername ?? "your_bot";
  const working = busy || commands.working;
  const [tone, words] = COMMANDS_STATE[commands.state];

  const run = async (work: () => Promise<unknown>) => {
    if (working) return;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(messageOf(failure, "That could not be done. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel aria-labelledby="telegram-commands">
      <h2 id="telegram-commands" className="text-base">
        Commands
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-2">
        With commands on, a task can be added to the board from a picked group. The bot answers
        once in the group, tagging whoever the task is for.
      </p>
      <ul className="mt-3 max-w-2xl list-disc space-y-2 pl-5 text-sm text-ink-2">
        <li>
          Mention the bot: <code className={codeClass}>@{bot} @username Title of the task</code>.
          The bot can be named anywhere in the message, and the person left out for a task that
          is nobody&apos;s yet.
        </li>
        <li>
          Or the command: <code className={codeClass}>/task @username Title of the task</code>.
        </li>
        <li>
          The board: <code className={codeClass}>{hashtagOf("us")}</code>,{" "}
          <code className={codeClass}>{hashtagOf("kz")}</code> or <code className={codeClass}>#both</code>,
          as in <code className={codeClass}>{`@${bot} @username ${hashtagOf("kz")} Title of the task`}</code>.
          Without one, the task goes to the group&apos;s company.
        </li>
        <li>
          A due date at the end, written <code className={codeClass}>by 2026-10-20</code>. No
          other way of writing a date is read.
        </li>
        <li>
          <code className={codeClass}>/help</code> shows this in the group.
        </li>
      </ul>
      <div className="mt-3 max-w-2xl space-y-1.5 text-sm text-ink-2">
        <p>
          Only the owner and teammates with the Board page, by the Telegram username on record,
          can add tasks, and only to a company they are on. Anyone else is told &ldquo;Only
          teammates in {PRODUCT.name} can add tasks here.&rdquo; The first task someone adds links
          their username to the Telegram account that wrote it, the bot says so in the group,
          and from then on only that account is taken for them.
        </p>
        <p>
          The bot only sees commands and messages that mention it (Telegram&apos;s privacy mode),
          nothing else said in the group. It never reads a message somebody replied to.
        </p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <StatusChip tone={tone}>{words}</StatusChip>
        {working && <span className="text-sm text-ink-2">Working…</span>}
        {commands.pending !== null && commands.pending > 0 && (
          <span className="text-sm text-ink-2">
            {commands.pending} {commands.pending === 1 ? "update" : "updates"} waiting
          </span>
        )}
      </div>
      {commands.deliveryError !== null && (
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-2">
          <StatusChip tone="warning">Delivery failed</StatusChip>
          <span>{commands.deliveryError}</span>
          {now !== null && commands.deliveryErrorAt !== null && (
            <span className="text-ink-3">{ageLabel(now, commands.deliveryErrorAt)}</span>
          )}
        </p>
      )}
      {commands.error !== null && (
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-2">
          <StatusChip tone="danger">Could not change</StatusChip>
          <span>{commands.error}</span>
        </p>
      )}
      {commands.failure !== null && (
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-2">
          <StatusChip tone="danger">Last command failed</StatusChip>
          <span>{commands.failure}</span>
          {now !== null && commands.failureAt !== null && (
            <span className="text-ink-3">{ageLabel(now, commands.failureAt)}</span>
          )}
        </p>
      )}
      {/* The owner's switch is what the OS goes by; Telegram's state can lag or differ. */}
      {!commands.wanted && commands.state === "on" && (
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-2">
          <StatusChip tone="warning">Off in the OS</StatusChip>
          <span>
            Commands are off: the OS acts on nothing said in the group. Telegram still sends the
            bot&apos;s updates to this address; turn off again to stop that.
          </span>
        </p>
      )}
      {commands.wanted && (commands.state === "off" || commands.state === "elsewhere") && (
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-2">
          <StatusChip tone="warning">Not arriving</StatusChip>
          <span>
            Commands are turned on, but Telegram is not sending the bot&apos;s updates here. Turn
            on again.
          </span>
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {(!commands.wanted || commands.state === "off" || commands.state === "elsewhere") && (
          <BusyButton
            busy={working}
            blocked={!shared}
            onPress={() => run(() => turnOn({}))}
            className={primaryButtonClass}
          >
            Turn on commands
          </BusyButton>
        )}
        {(commands.wanted || commands.state === "on") && (
          <BusyButton
            busy={working}
            blocked={!shared}
            onPress={() => run(() => turnOff({}))}
            className={quietButtonClass}
          >
            Turn off commands
          </BusyButton>
        )}
        <BusyButton busy={working} onPress={() => run(() => check({}))} className={quietButtonClass}>
          Check
        </BusyButton>
      </div>
      {!shared && <p className="mt-2 max-w-2xl text-xs text-ink-2">{COMMANDS_SHARED}</p>}
      <div className="mt-2">
        <Failure>{error}</Failure>
      </div>
    </Panel>
  );
}

/** Whether task messages are getting through: the last one sent and the last failure. */
function Outcome({ settings }: { settings: Settings }) {
  const now = useNow();
  const ago = (at: number | null) => (now === null || at === null ? null : ageLabel(now, at));
  const sentAgo = ago(settings.lastSentAt);
  const failedAgo = ago(settings.lastErrorAt);
  return (
    <Panel aria-labelledby="telegram-outcome">
      <h2 id="telegram-outcome" className="text-base">
        How it is going
      </h2>
      <div className="mt-2 space-y-2 text-sm text-ink-2">
        {!settings.tokenSet ? (
          <StatusChip tone="neutral">Off: the token is not set</StatusChip>
        ) : !settings.enabled ? (
          <StatusChip tone="neutral">Switched off</StatusChip>
        ) : settings.lastError !== null ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <StatusChip tone="danger">Last message not sent</StatusChip>
            <span>{settings.lastError}</span>
            {failedAgo !== null && <span className="text-ink-3">{failedAgo}</span>}
          </p>
        ) : settings.lastSentAt !== null ? (
          <StatusChip tone="success">Working</StatusChip>
        ) : (
          <p>No task message has been sent yet.</p>
        )}
        {settings.lastSentAt !== null && (
          <p>Last message sent{sentAgo === null ? "" : ` ${sentAgo}`}.</p>
        )}
        <p className="max-w-2xl text-xs">
          A group is sent at most 30 messages an hour; any more are dropped, and that is said
          here.
        </p>
      </div>
    </Panel>
  );
}

/**
 * What a line of the log says. Fixed words round whoever it was, by the name
 * they signed in with: this page is sent no teammate's username.
 */
function linkWords(entry: Settings["log"][number]) {
  // At the start of a sentence, and inside one.
  const [first, within] =
    entry.name !== null
      ? [entry.name, entry.name]
      : entry.gone
        ? ["Someone no longer on the team", "someone no longer on the team"]
        : ["A teammate", "a teammate"];
  return entry.event === "linked"
    ? `${first} was linked to the Telegram account that added a task.`
    : `The link of ${within} was reset.`;
}

/**
 * Who can be tagged, read only: how many teammates have a username, and
 * which usernames are tied to a Telegram account. Every username, the
 * owner's own included, is set and reset in its row on the Team page (the
 * owner's alone, as before): this page has no field and no button for one.
 */
function Usernames({ settings }: { settings: Settings }) {
  const logId = useId();
  const { teammates, withoutUsername } = settings;
  const have = teammates - withoutUsername;

  const teamLink = (
    <GatedLink href="/settings/team" className={linkClass}>
      Edit on Team
    </GatedLink>
  );

  return (
    <Panel aria-labelledby="telegram-people">
      <h2 id="telegram-people" className="text-base">
        Who gets tagged
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-2">
        {teammates === 0 ? (
          <>No teammates yet · {teamLink}</>
        ) : (
          <>
            {`${have} of ${teammates} ${teammates === 1 ? "teammate" : "teammates"} ${teammates === 1 ? "has" : "have"} a Telegram username`}{" "}
            · {teamLink}
          </>
        )}
      </p>
      <p className="mt-1 max-w-2xl text-sm text-ink-2">
        Someone with no username is named without a tag, so Telegram does not notify them.
      </p>

      <p className="mt-5 max-w-2xl text-sm text-ink-2">
        The first task someone adds from the group links their username to the Telegram account
        that wrote it, and the bot says so in the group. From then on only that account is taken
        for them. If the wrong account was linked (a username typed wrongly, or one the person no
        longer holds), correct the username or reset the link in their row on the Team page; the
        next task links afresh.
      </p>
      {settings.people.length > 0 && (
        <DataTable
          caption="Teammates and their Telegram accounts"
          className="min-w-[24rem]"
          boxClassName="mt-3"
        >
          <DataHead>
            <DataHeader pinned>Teammate</DataHeader>
            <DataHeader>Telegram account</DataHeader>
          </DataHead>
          <DataBody>
            {settings.people.map((person) => (
              <DataRow key={person.id}>
                <DataRowHeader pinned className="font-normal">
                  <span className="text-sm text-ink">
                    {person.name ?? "A teammate who has not signed in yet"}
                  </span>
                </DataRowHeader>
                <DataCell>
                  <TelegramLink
                    linked={person.linked}
                    linkedAt={person.linkedAt}
                    whose={person.name ?? "a teammate who has not signed in yet"}
                  />
                </DataCell>
              </DataRow>
            ))}
          </DataBody>
        </DataTable>
      )}
      {settings.log.length > 0 && (
        <>
          <h3 id={logId} className="mt-5 text-sm font-medium text-ink">
            Recent links
          </h3>
          <ul aria-labelledby={logId} className="mt-1.5 max-w-2xl space-y-1 text-sm text-ink-2">
            {settings.log.map((entry, index) => (
              <li key={`${entry.at}-${index}`}>
                {linkWords(entry)} <span className="text-ink-3">{localIsoDate(entry.at)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

/**
 * The page for the Telegram bot: the owner's, and that of a teammate the
 * owner gave "Sources and Telegram" (the `settings` area). Anyone else gets a
 * line and no query: `telegram.settings` refuses them, and a refused query
 * breaks the page. That is presentation; the refusal itself is the server's.
 */
export function TelegramSettings() {
  const viewer = useViewer();
  const holds = viewer.can("settings");
  const settings = useQuery(api.telegram.settings, holds ? {} : "skip");

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl sm:text-3xl">Telegram</h1>
        {holds && (
          <p className="mt-1 max-w-2xl text-sm text-ink-2">
            A bot posts in a company&apos;s Telegram group when a task on the board is given to
            someone, and tags them.
          </p>
        )}
      </header>
      {!holds ? (
        <Panel>
          <p className="text-sm text-ink-2">{TELEGRAM_NOT_YOURS}</p>
        </Panel>
      ) : settings === undefined ? (
        <Skeleton className="h-40 rounded-card" />
      ) : (
        <>
          <Steps settings={settings} />
          <Groups settings={settings} />
          <Commands settings={settings} />
          <Outcome settings={settings} />
          <Usernames settings={settings} />
        </>
      )}
    </div>
  );
}
