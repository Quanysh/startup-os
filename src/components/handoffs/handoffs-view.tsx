"use client";

import { useMutation, useQuery } from "convex/react";
import { ClockAlertIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useId, useState } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import {
  FINISHED_STATUSES,
  HANDOFF_STATUSES,
  HANDOFF_STATUS_LABELS,
  MAX_BOT_NAME,
  MAX_HANDOFF_NOTE,
  isUnaccepted,
  type HandoffStatus,
} from "@convex/lib/handoffs";
import { AREA_NAMES, FIGURE_AREAS } from "@convex/lib/roles";
import { useCompany } from "@/components/company-provider";
import { PageHeader } from "@/components/page-header";
import { Panel, fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ActionsHeader,
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
  rowActionClass,
} from "@/components/ui/data-table";
import { KindTag, StatusChip, type StatusTone } from "@/components/ui/status-chip";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { COMPANIES } from "@/lib/company";
import { messageOf } from "@/lib/errors";
import { botsOf, filterHandoffs, readView, since, unacceptedOf, writeView, type HandoffRow, type View } from "@/lib/handoffs/view";
import { cn } from "@/lib/utils";

const TONE: Record<HandoffStatus, StatusTone> = {
  open: "info",
  accepted: "success",
  done: "neutral",
  declined: "danger",
  closed: "neutral",
};

const stamp = (at: number) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(at);

/**
 * /handoffs: what one bot has asked another to take over, and where each
 * stands. The status and the bot are in the address. The bots write these
 * themselves (the `handoff_*` tools); here the owner reads the history,
 * hands one to somebody else, or closes it.
 */
export function HandoffsView() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const now = useNow();
  const company = useCompany();
  const { companies } = useViewer();
  const rows = useQuery(api.handoffs.list, { company: company ?? undefined });
  const view = readView(new URLSearchParams(params.toString()));
  const [opened, setOpened] = useState<string | null>(null);

  const setView = (next: View) => {
    const query = writeView(next);
    router.replace(query === "" ? pathname : `${pathname}?${query}`, { scroll: false });
  };

  if (rows === undefined || now === null) {
    return (
      <div className="space-y-6">
        <PageHeader title="Handoffs" purpose="Work the bots hand to each other and to people, and where each handoff stands." />
        <Skeleton data-testid="handoffs-loading" className="h-48 w-full rounded-card" />
      </div>
    );
  }

  const stale = unacceptedOf(rows, now);
  const shown = filterHandoffs(rows, view);
  const detail = opened === null ? undefined : rows.find((row) => row.id === opened);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Handoffs"
        purpose="Work the bots hand to each other and to people: who asked whom, what for, and where it stands. Answer one handed to you, hand one to somebody else, or close it."
      />
      {stale.length > 0 && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-card bg-warning-soft px-5 py-3 text-sm text-warning-ink">
          <span className="flex items-center gap-2">
            <ClockAlertIcon aria-hidden className="size-4 shrink-0" />
            {stale.length === 1
              ? "1 handoff has been open for more than a day with no taker."
              : `${stale.length} handoffs have been open for more than a day with no taker.`}
          </span>
          <button
            type="button"
            onClick={() => setView({ ...view, status: "open" })}
            className="rounded-sm font-medium underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Show open
          </button>
        </div>
      )}

      {detail !== undefined && (
        <Detail key={detail.id} row={detail} now={now} onDone={() => setOpened(null)} />
      )}

      <Panel className="space-y-4">
        <h2 className="text-lg">All handoffs</h2>
        <Filters rows={rows} view={view} setView={setView} />
        {rows.length === 0 ? (
          <p className="text-sm text-ink-2">
            No bot has handed anything over yet. A bot does it with the <code>handoff_create</code> tool.
          </p>
        ) : shown.length === 0 ? (
          <p className="text-sm text-ink-2">No handoff matches these filters.</p>
        ) : (
          <DataTable caption="Handoffs, open first" className="min-w-[40rem]">
            <DataHead>
              <DataHeader pinned>Handoff</DataHeader>
              <DataHeader>From</DataHeader>
              <DataHeader>To</DataHeader>
              <DataHeader>Status</DataHeader>
              <DataHeader hideBelow="sm">Waiting</DataHeader>
              <ActionsHeader />
            </DataHead>
            <DataBody>
              {shown.map((row) => (
                <DataRow key={row.id} tone={isUnaccepted(row, now) ? "warning" : undefined}>
                  <DataRowHeader pinned className="max-w-[24rem]">
                    <span className="block [overflow-wrap:anywhere]">{row.title}</span>
                    {companies.length > 1 && (
                      <span className="mt-1 flex">
                        <KindTag tone="slate">{COMPANIES[row.company].name}</KindTag>
                      </span>
                    )}
                  </DataRowHeader>
                  <DataCell className="[overflow-wrap:anywhere]">{row.from}</DataCell>
                  <DataCell className="[overflow-wrap:anywhere]">{row.mine ? "You" : row.to}</DataCell>
                  <DataCell>
                    <StatusChip tone={TONE[row.status]}>{HANDOFF_STATUS_LABELS[row.status]}</StatusChip>
                  </DataCell>
                  <DataCell hideBelow="sm" className="whitespace-nowrap">
                    {FINISHED_STATUSES.includes(row.status) ? "" : since(row.openSince, now)}
                  </DataCell>
                  <DataCell actions>
                    <button type="button" onClick={() => setOpened(row.id)} className={rowActionClass} aria-label={`Open ${row.title}`}>
                      Open
                    </button>
                  </DataCell>
                </DataRow>
              ))}
            </DataBody>
          </DataTable>
        )}
      </Panel>
    </div>
  );
}

function Filters({ rows, view, setView }: { rows: readonly HandoffRow[]; view: View; setView: (next: View) => void }) {
  const ids = { status: useId(), bot: useId() };
  const control = cn(fieldClass, "mt-1 h-9");
  const label = "text-xs font-medium text-ink-2";
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <label htmlFor={ids.status} className={label}>Status</label>
        <select
          id={ids.status}
          value={view.status ?? ""}
          onChange={(e) => setView({ ...view, status: (e.target.value || null) as HandoffStatus | null })}
          className={control}
        >
          <option value="">Any</option>
          {HANDOFF_STATUSES.map((status) => (
            <option key={status} value={status}>{HANDOFF_STATUS_LABELS[status]}</option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={ids.bot} className={label}>Bot</label>
        <select id={ids.bot} value={view.bot ?? ""} onChange={(e) => setView({ ...view, bot: e.target.value || null })} className={control}>
          <option value="">Any</option>
          {botsOf(rows).map((bot) => (
            <option key={bot.key} value={bot.key}>{bot.name}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

/**
 * A bot handed this to the viewer: accept it, mark it done (a note is
 * optional, and goes back to the bot) or decline it (a reason is required).
 */
function Answer({
  row,
  busy,
  run,
}: {
  row: HandoffRow;
  busy: boolean;
  run: (act: () => Promise<unknown>) => Promise<void>;
}) {
  const id = useId();
  const answer = useMutation(api.handoffs.answer);
  const [note, setNote] = useState("");
  const handoffId = row.id as Id<"handoffs">;
  const said = note.trim() === "" ? null : { note };
  return (
    <div className="space-y-3 rounded-inner bg-surface p-4">
      <h3 className="text-sm font-medium">Handed to you</h3>
      <div>
        <label htmlFor={id} className="text-xs font-medium text-ink-2">Your note</label>
        <input
          id={id}
          maxLength={MAX_HANDOFF_NOTE}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What was done, or why not"
          className={cn(fieldClass, "mt-1 h-9")}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {row.status === "open" && (
          <button type="button" disabled={busy} onClick={() => void run(() => answer({ id: handoffId, action: "accept" }))} className={primaryButtonClass}>
            Accept
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => answer({ id: handoffId, action: "done", ...said }))}
          className={row.status === "open" ? quietButtonClass : primaryButtonClass}
        >
          Mark done
        </button>
        <button
          type="button"
          disabled={busy || said === null}
          onClick={() => void run(() => answer({ id: handoffId, action: "decline", ...said }))}
          className={quietButtonClass}
        >
          Decline
        </button>
      </div>
      <p className="text-xs text-ink-3">Declining needs a reason in the note. Your note goes back to the bot.</p>
    </div>
  );
}

/** The picker's value for a bot typed by hand. */
const OTHER_BOT = "__other_bot__";

/** One handoff in full: what it asks, what it links to, every change, and the owner's two actions. */
function Detail({ row, now, onDone }: { row: HandoffRow; now: number; onDone: () => void }) {
  const ids = { to: useId(), other: useId(), note: useId() };
  const reassign = useMutation(api.handoffs.reassign);
  const close = useMutation(api.handoffs.close);
  const { isOwner } = useViewer();
  // Who can take it: that company's people with the board, and the bots.
  const recipients = useQuery(api.handoffs.recipients, { company: row.company }) as
    | { people: { email: string; name: string | null }[]; bots: { id: string; name: string }[] }
    | undefined;
  const [picked, setPicked] = useState("");
  const [other, setOther] = useState("");
  const to = picked === OTHER_BOT ? other.trim() : picked;
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const finished = FINISHED_STATUSES.includes(row.status);

  const run = async (act: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await act();
      onDone();
    } catch (caught) {
      setError(messageOf(caught));
      setBusy(false);
    }
  };
  const id = row.id as Id<"handoffs">;

  return (
    <Panel aria-label={row.title} className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg [overflow-wrap:anywhere]">{row.title}</h2>
          <p className="mt-1 text-sm text-ink-2">
            {row.from} to {row.to}, {since(row.createdAt, now)} ago
          </p>
        </div>
        <StatusChip tone={TONE[row.status]}>{HANDOFF_STATUS_LABELS[row.status]}</StatusChip>
      </div>
      {row.withheld && (
        <p className="text-sm text-ink-2">
          Its words are kept for whoever holds every page of figures the bot reads (
          {FIGURE_AREAS.map((area) => AREA_NAMES[area]).join(", ")}), for the person it is to, and for the owner.
        </p>
      )}
      {row.summary !== "" && <p className="text-sm whitespace-pre-line [overflow-wrap:anywhere]">{row.summary}</p>}
      {row.reason !== null && <p className="text-sm text-ink-2 [overflow-wrap:anywhere]">Reason: {row.reason}</p>}
      {row.links.length > 0 && (
        <p className="text-sm text-ink-2">
          Linked: {row.links.map((link) => `${link.kind} ${link.id}`).join(", ")}
        </p>
      )}
      <div>
        <h3 className="text-sm font-medium">History</h3>
        <ol className="mt-2 space-y-1 text-sm text-ink-2">
          {row.history.map((entry, index) => (
            <li key={index} className="[overflow-wrap:anywhere]">
              <span className="text-ink-3">{stamp(entry.at)}</span> {entry.by}: {entry.action}
              {entry.note !== undefined && ` (${entry.note})`}
            </li>
          ))}
        </ol>
      </div>
      {!finished && row.mine && <Answer row={row} busy={busy} run={run} />}
      {!finished && (
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => reassign({ id, to, ...(note.trim() === "" ? null : { note }) }));
          }}
        >
          <div>
            <label htmlFor={ids.to} className="text-xs font-medium text-ink-2">Hand it to</label>
            <select id={ids.to} required value={picked} onChange={(e) => setPicked(e.target.value)} className={cn(fieldClass, "mt-1 h-9")}>
              <option value="" disabled>{recipients === undefined ? "Loading…" : "Pick a person or a bot"}</option>
              {recipients !== undefined && recipients.people.length > 0 && (
                <optgroup label="People">
                  {recipients.people.map((person) => (
                    <option key={person.email} value={person.email}>{person.name ?? person.email}</option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Bots">
                {recipients?.bots.map((bot) => (
                  <option key={bot.id} value={bot.id}>{bot.name}</option>
                ))}
                <option value={OTHER_BOT}>Another bot…</option>
              </optgroup>
            </select>
            {picked === OTHER_BOT && (
              <>
                <label htmlFor={ids.other} className="sr-only">Bot&apos;s id</label>
                <input
                  id={ids.other}
                  required
                  maxLength={MAX_BOT_NAME}
                  placeholder="Bot's id"
                  value={other}
                  onChange={(e) => setOther(e.target.value)}
                  className={cn(fieldClass, "mt-2 h-9")}
                />
              </>
            )}
          </div>
          <div>
            <label htmlFor={ids.note} className="text-xs font-medium text-ink-2">Note</label>
            <input id={ids.note} maxLength={MAX_HANDOFF_NOTE} value={note} onChange={(e) => setNote(e.target.value)} className={cn(fieldClass, "mt-1 h-9")} />
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <button type="submit" disabled={busy || to.trim() === ""} className={primaryButtonClass}>Reassign</button>
            {/* Closing is the owner's alone (`handoffs.close`); reassigning is the board's. */}
            {isOwner && (
              <button type="button" disabled={busy} onClick={() => void run(() => close({ id, ...(note.trim() === "" ? null : { note }) }))} className={quietButtonClass}>
                Close it
              </button>
            )}
            <button type="button" disabled={busy} onClick={onDone} className={quietButtonClass}>Back</button>
          </div>
        </form>
      )}
      {finished && (
        <button type="button" onClick={onDone} className={quietButtonClass}>Back</button>
      )}
      {error !== null && (
        <p role="alert" className="text-sm text-danger-ink">{error}</p>
      )}
    </Panel>
  );
}
