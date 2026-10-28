"use client";

// "Settings for every bot" on Agents › Bots, folded away until opened: what
// every bot is held to, in full; the rules every bot is given by `whoami` and
// `bot_rules`, published as numbered versions; and the near-duplicate
// threshold. Owner only: the page mounts the tab for the owner.

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import { MAX_BOT_NOTE, MAX_RULES_TEXT } from "@convex/lib/botRules";
import { PRODUCT } from "@convex/lib/identity";
import { fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { agoText } from "@/lib/agents/bots-view";
import { messageOf } from "@/lib/errors";
import { cn } from "@/lib/utils";

type RulesBot = { botId: string; name: string };

/** The rules every bot follows and each bot's note, published as the next version. */
function BotRules({ bots, now }: { bots: readonly RulesBot[]; now: number }) {
  const published = useQuery(api.bots.rules, {});
  const publish = useMutation(api.bots.publishRules);
  const [draft, setDraft] = useState<{ version: number; rules: string; notes: Record<string, string> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);

  if (published === undefined) return <Skeleton className="h-32 rounded-inner" />;
  // The draft starts from the published version, and again once a newer one is published.
  const current =
    draft !== null && draft.version === published.version
      ? draft
      : {
          version: published.version,
          rules: published.rules,
          notes: Object.fromEntries(published.notes.map((n) => [n.bot, n.text])),
        };
  const next = published.version + 1;
  return (
    <section aria-label="Rules for every bot" className="space-y-3 rounded-inner border border-line p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-ink">Rules for every bot</h3>
        <p className="text-xs text-ink-3">
          {published.version === 0 || published.publishedAt === null
            ? "Not published yet"
            : `Version ${published.version} · published ${agoText(published.publishedAt, now)}`}
        </p>
      </div>
      <p className="max-w-3xl text-xs text-ink-2">
        Every bot is given these by whoami and bot_rules on its next call. Publishing makes the next version: nobody
        confirms it in a chat.
      </p>
      <label className="block text-sm text-ink">
        Rules every bot follows
        <textarea
          className={cn(fieldClass, "mt-1 min-h-32 py-2")}
          maxLength={MAX_RULES_TEXT}
          value={current.rules}
          onChange={(e) => setDraft({ ...current, rules: e.target.value })}
        />
      </label>
      {bots.length > 0 && (
        <details className="text-sm text-ink">
          <summary className="cursor-pointer outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            A note for each bot
          </summary>
          <div className="mt-2 space-y-3">
            {bots.map((bot) => (
              <label key={bot.botId} className="block text-sm text-ink">
                {bot.name}
                <textarea
                  aria-label={`Note for ${bot.name}`}
                  className={cn(fieldClass, "mt-1 min-h-16 py-2")}
                  maxLength={MAX_BOT_NOTE}
                  value={current.notes[bot.botId] ?? ""}
                  onChange={(e) => setDraft({ ...current, notes: { ...current.notes, [bot.botId]: e.target.value } })}
                />
              </label>
            ))}
          </div>
        </details>
      )}
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={primaryButtonClass}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            const notes = bots
              .map((bot) => ({ bot: bot.botId, text: current.notes[bot.botId] ?? "" }))
              .filter((note) => note.text.trim() !== "");
            publish({ rules: current.rules, notes })
              .then((made) => {
                setDone(made.version);
                setDraft(null);
              })
              .catch((failure: unknown) => setError(messageOf(failure)))
              .finally(() => setBusy(false));
          }}
        >
          Publish as version {next}
        </button>
        <span role="status" className="text-xs text-ink-2">
          {done !== null && `Published version ${done}.`}
        </span>
      </div>
    </section>
  );
}

/**
 * The near-duplicate check's threshold (convex/lib/duplicates.ts): how alike a
 * new card's title must be to something open (plus 0.15 for a shared deal,
 * task, goal or customer) before a bot is asked whether it is the same.
 */
function DuplicateThreshold() {
  const settings = useQuery(api.duplicates.settings, {});
  const set = useMutation(api.duplicates.setThreshold);
  const [draft, setDraft] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  if (settings === undefined) return <Skeleton className="h-16 rounded-inner" />;
  const value = draft ?? settings.threshold.toFixed(2);
  return (
    <form
      aria-label="Duplicate threshold"
      className="flex flex-wrap items-end gap-2 rounded-inner border border-line p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void set({ threshold: Number(value) }).then(
          () => {
            setDraft(null);
            setSaid(null);
          },
          (failure: unknown) => setSaid(messageOf(failure)),
        );
      }}
    >
      <label className="block text-xs font-medium text-ink-2">
        Duplicate threshold
        <input
          inputMode="decimal"
          value={value}
          onChange={(event) => setDraft(event.target.value)}
          className={cn(fieldClass, "mt-1 h-9 w-24")}
        />
      </label>
      <button type="submit" disabled={draft === null} className={cn(quietButtonClass, "h-9 px-3 text-xs")}>
        Save
      </button>
      <p className="max-w-md text-xs text-ink-3">
        A bot&apos;s new task, proposal, goal or handoff this alike to something open is refused as a possible duplicate
        until it says how it differs. {settings.isDefault ? `The default is ${settings.defaultThreshold}.` : null}
      </p>
      {said !== null && (
        <p role="alert" className="w-full text-xs text-destructive">
          {said}
        </p>
      )}
    </form>
  );
}

/** What every bot is held to, the rules and the duplicate threshold. Mounted only while open. */
export function BotSettings({ bots, now }: { bots: readonly RulesBot[]; now: number }) {
  return (
    <div className="space-y-4">
      <div className="max-w-3xl space-y-2 text-sm text-ink-2">
        <p>
          Each bot that calls {PRODUCT.name} through a connected client names itself with every call. It may use only the
          areas you give it, never payroll, costs, settings, the team, Today or your own pages, and only what its client
          may do: a read-only client never changes anything. Each bot has its own limits; the bots of one client together
          stop at 2,000 calls and 600 changes in 10 minutes. A name {PRODUCT.name} does not know is refused.
        </p>
        <p>
          Better still, give each bot its own connector address: every call made there is that bot&apos;s, whatever the
          client sends, and a sign-in made there is for that bot alone.
        </p>
        <p>
          The chief of staff, engineering and finance agents on your Mac keep their own rules. Named through any other client
          (a Grok bot using the same id), or at their own address, each is an external profile edited here like a
          bot&apos;s: it reads what a bot may read and writes the board and memory, never payroll, costs or settings, and
          is never approved automatically. Switching the Mac agent off leaves its external profile on. Sales stays on the Mac.
        </p>
      </div>
      <BotRules bots={bots} now={now} />
      <DuplicateThreshold />
    </div>
  );
}
