"use client";

import { useQuery } from "convex/react";
import { useSearchParams } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "@convex/_generated/api";
import { MAX_DISMISS_REASON_LENGTH } from "@convex/lib/agents";
import type { RejectCode } from "@convex/lib/agents";
import { Filters, useView } from "@/components/approvals/filters";
import { EditThenApprove } from "@/components/approvals/edit-then-approve";
import { ApprovalBody, WhoTag, approveLabel, useDeciders } from "@/components/approvals/row";
import { Panel, fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import {
  ActionsHeader,
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataTable,
} from "@/components/ui/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { useNarrow } from "@/hooks/use-narrow";
import { useNow } from "@/hooks/use-now";
import {
  REJECT_CHIPS,
  agentsIn,
  decideMany,
  filterInbox,
  goalsIn,
  hasReason,
  kindLabel,
  rowSentence,
  sortInbox,
  splitCash,
  type InboxRow,
  type RejectReason,
} from "@/lib/approvals/inbox";
import { messageOf } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { manyCompanies } from "@convex/lib/company";

export const inboxIntro = () =>
  `Everything your agents and bots wait on you for, ${manyCompanies() ? "both companies, " : ""}in one place: critical first, then what serves a goal at risk, then oldest first. Nothing here has happened until you approve it, and a draft is only ever text for you to copy.`;

export const KEYS_HINT =
  "Keys: j and k move, x selects, a approves, r rejects. A possible duplicate, a new deal, a draft, a goal or a bot's permission is approved only with its own button.";

/**
 * Everything waiting on the owner, both companies: proposals and paused tool
 * calls (`assistant.inbox` with no company). The one read behind every
 * "waiting" figure: this page, its navigation count, Today's "Needs you", the
 * Bots tab and the Assistant's line, so they agree. `enabled` false sends
 * nothing (it is an `ownerQuery`, asked for the owner alone).
 */
export function useInbox(enabled = true) {
  return useQuery(api.assistant.inbox, enabled ? {} : "skip");
}

/** How many items wait for the owner: the inbox's length, or undefined while it is read. */
export function useWaitingCount(enabled = true): number | undefined {
  return useInbox(enabled)?.length;
}

const small = "h-9 px-4";
const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** Where a row is on the page: `/approvals?id=…` (Today's "Needs you") brings it into view. */
export const rowAnchor = (id: string) => `approval-${id}`;

type Rejecting = { ids: string[]; each: boolean; code: RejectCode | null; one: string; per: Record<string, string> };

/**
 * The owner's approvals inbox, the one place proposals and tool calls are
 * decided: one screen of every open proposal and every tool call a Startup OS
 * run paused on, both companies (a tool call belongs to none). Filter in the
 * address; edit any proposal before approving it; select many and approve or
 * reject them, a rejection with one reason for all or a reason for each,
 * which the bots read back through `proposals_feedback`. Approving many (or
 * with the `a` key) leaves a possible duplicate and a kind never done without
 * the owner (`oneClickOnly`) waiting for its own button. Mounted for the owner
 * alone: every call it makes is the owner's.
 */
export function ApprovalsInbox() {
  const rows = useInbox();
  const now = useNow();
  const [view, setView] = useView();
  const focusId = useSearchParams().get("id");
  const deciders = useDeciders();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // Null until a key moves it: then the row `?id=` names, or the first.
  const [cursor, setCursor] = useState<number | null>(null);
  const [rejecting, setRejecting] = useState<Rejecting | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<Record<string, string>>({});
  const ids = useId();
  // Below `sm` each row is a card with its actions under it (the owner approves from his phone).
  const narrow = useNarrow();

  // The default order, then "Cash and runway" pinned above the rest: the cursor walks both in that order.
  const sections = useMemo(
    () => splitCash(rows === undefined ? [] : sortInbox(filterInbox(rows, view))),
    [rows, view],
  );
  const shown = useMemo(() => [...sections.cash, ...sections.rest], [sections]);
  const agents = useMemo(() => (rows === undefined ? [] : agentsIn(rows)), [rows]);
  const goals = useMemo(() => (rows === undefined ? [] : goalsIn(rows)), [rows]);
  // What is selected and still listed: a row decided elsewhere drops out of it.
  const chosen = shown.filter((row) => selected.has(row.id));
  // Arrived with `?id=` (Today's "Needs you"): the cursor starts on that row.
  const focusAt = focusId === null ? -1 : shown.findIndex((row) => row.id === focusId);
  const at = Math.min(cursor ?? Math.max(0, focusAt), Math.max(0, shown.length - 1));

  // And, once it is drawn, that row is brought into view.
  const arrived = useRef(false);
  useEffect(() => {
    if (arrived.current || focusAt === -1 || now === null) return;
    arrived.current = true;
    document.getElementById(rowAnchor(shown[focusAt]!.id))?.scrollIntoView?.({ block: "center" });
  }, [focusAt, now, shown]);

  const toggle = (id: string) =>
    setSelected((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  /** The selected rows, or the one under the cursor where none is selected. */
  const target = () => (chosen.length > 0 ? chosen : shown[at] === undefined ? [] : [shown[at]!]);

  const run = async (
    list: readonly InboxRow[],
    action: "approve" | "reject",
    reasonOf: (id: string) => RejectReason = () => ({ code: null, text: "" }),
    bulk = false,
  ) => {
    if (busy || list.length === 0) return;
    setBusy(true);
    const refused = await decideMany(
      list,
      action,
      deciders,
      reasonOf,
      (error) => messageOf(error, "That could not be done. Try again."),
      { bulk },
    );
    setFailed(refused);
    setSelected(new Set(Object.keys(refused)));
    setRejecting(null);
    setBusy(false);
  };
  const startReject = (list: readonly InboxRow[]) => {
    if (list.length === 0) return;
    setRejecting({ ids: list.map((row) => row.id), each: false, code: null, one: "", per: {} });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target) || rejecting !== null) return;
      if (event.key === "j") setCursor(Math.min(at + 1, Math.max(0, shown.length - 1)));
      else if (event.key === "k") setCursor(Math.max(0, at - 1));
      else if (event.key === "x" && shown[at] !== undefined) toggle(shown[at]!.id);
      // A key is never a row's own click: what needs one stays waiting.
      else if (event.key === "a") void run(target(), "approve", undefined, true);
      else if (event.key === "r") startReject(target());
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (rows === undefined || now === null) {
    return (
      <Panel>
        <Skeleton className="h-40 w-full" />
      </Panel>
    );
  }

  const rejectList = rejecting === null ? [] : shown.filter((row) => rejecting.ids.includes(row.id));
  /** Each row's reason: the quick reason picked, and the words for all or for that row. */
  const reasonOf = (id: string): RejectReason => ({
    code: rejecting?.code ?? null,
    text: rejecting === null ? "" : rejecting.each ? (rejecting.per[id] ?? "") : rejecting.one,
  });
  const ready = rejectList.length > 0 && rejectList.every((row) => hasReason(reasonOf(row.id)));

  /** One section's rows; `offset` is where its first row sits in the cursor's order. */
  const table = (label: string, list: readonly InboxRow[], offset: number) => {
    const allHere = list.length > 0 && list.every((row) => selected.has(row.id));
    const selectAll = (
      <input
        type="checkbox"
        aria-label={`Select every row in ${label}`}
        checked={allHere}
        onChange={() =>
          setSelected((was) => {
            const next = new Set(was);
            for (const row of list) {
              if (allHere) next.delete(row.id);
              else next.add(row.id);
            }
            return next;
          })
        }
      />
    );
    if (narrow) {
      // A phone: each row a card, its actions under it, nothing off to the side.
      return (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-xs text-ink-2">
            {selectAll}
            Select all
          </label>
          <ul aria-label={label} className="space-y-3">
            {list.map((row, place) => {
              const index = offset + place;
              return (
                <li
                  key={row.id}
                  id={rowAnchor(row.id)}
                  data-testid="inbox-row"
                  data-layout="card"
                  aria-current={index === at ? "true" : undefined}
                  className={cn(
                    "min-w-0 scroll-mt-6 rounded-inner border border-line p-3 text-sm",
                    failed[row.id] !== undefined && "border-warning bg-warning-soft/40",
                    index === at && "outline-2 -outline-offset-2 outline-ring/60",
                  )}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      aria-label={`Select: ${rowSentence(row, now)}`}
                      checked={selected.has(row.id)}
                      onChange={() => toggle(row.id)}
                      className="mt-1 size-4 shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <ApprovalBody row={row} now={now} withEdit={false} />
                      {failed[row.id] !== undefined && (
                        <p role="alert" className="mt-1 text-xs text-destructive">
                          {failed[row.id]}
                        </p>
                      )}
                      <div className="mt-2">
                        <WhoTag row={row} />
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2" data-testid="card-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run([row], "approve")}
                      className={cn(primaryButtonClass, "h-10 min-w-0 flex-1 px-3")}
                    >
                      {approveLabel(row)}
                    </button>
                    <EditThenApprove
                      row={row}
                      buttonClassName={cn(quietButtonClass, "h-10 min-w-0 flex-1 bg-surface px-3 text-ink")}
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => startReject([row])}
                      className={cn(quietButtonClass, "h-10 min-w-0 flex-1 bg-surface px-3 text-ink")}
                    >
                      Reject
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      );
    }
    return (
      <DataTable label={label} download={false}>
        <DataHead>
          <DataHeader narrow>{selectAll}</DataHeader>
          <DataHeader>What it would do</DataHeader>
          <DataHeader narrow>Who</DataHeader>
          <DataHeader narrow hideBelow="md">
            Kind
          </DataHeader>
          <ActionsHeader />
        </DataHead>
        <DataBody>
          {list.map((row, place) => {
            const index = offset + place;
            return (
              <DataRow
                key={row.id}
                id={rowAnchor(row.id)}
                data-testid="inbox-row"
                aria-current={index === at ? "true" : undefined}
                tone={failed[row.id] !== undefined ? "warning" : undefined}
                className={cn("scroll-mt-6", index === at && "outline-2 -outline-offset-2 outline-ring/60")}
              >
                <DataCell narrow>
                  <input
                    type="checkbox"
                    aria-label={`Select: ${rowSentence(row, now)}`}
                    checked={selected.has(row.id)}
                    onChange={() => toggle(row.id)}
                  />
                </DataCell>
                <DataCell>
                  <ApprovalBody row={row} now={now} inTable />
                  {failed[row.id] !== undefined && (
                    <p role="alert" className="mt-1 text-xs text-destructive">
                      {failed[row.id]}
                    </p>
                  )}
                </DataCell>
                <DataCell narrow>
                  <WhoTag row={row} />
                </DataCell>
                <DataCell narrow hideBelow="md">
                  {kindLabel(row.kind)}
                </DataCell>
                <DataCell actions>
                  {/* A row's own button: the one click a possible duplicate or a new deal takes. */}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run([row], "approve")}
                    className={cn(quietButtonClass, "h-9 px-3")}
                  >
                    {approveLabel(row)}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => startReject([row])}
                    className={cn(quietButtonClass, "h-9 px-3")}
                  >
                    Reject
                  </button>
                </DataCell>
              </DataRow>
            );
          })}
        </DataBody>
      </DataTable>
    );
  };

  return (
    <Panel className="space-y-4" aria-labelledby={`${ids}-title`}>
      <div className="flex flex-wrap items-end gap-3">
        <h2 id={`${ids}-title`} className="mr-auto text-base font-medium text-ink">
          {rows.length === 0 ? "Nothing waits for you" : `${rows.length} waiting`}
        </h2>
        <Filters view={view} setView={setView} agents={agents} goals={goals} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || chosen.length === 0}
          onClick={() => void run(chosen, "approve", undefined, true)}
          className={cn(primaryButtonClass, small)}
        >
          Approve selected ({chosen.length})
        </button>
        <button
          type="button"
          disabled={busy || chosen.length === 0}
          onClick={() => startReject(chosen)}
          className={cn(quietButtonClass, small, "bg-surface text-ink")}
        >
          Reject selected ({chosen.length})
        </button>
        <p className="text-xs text-ink-3">{KEYS_HINT}</p>
      </div>

      {rejecting !== null && rejectList.length > 0 && (
        <form
          aria-label="Reject"
          className="space-y-3 rounded-inner border border-line bg-surface p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready) return;
            void run(rejectList, "reject", reasonOf);
          }}
        >
          <p className="text-sm text-ink">
            Reject {rejectList.length} {rejectList.length === 1 ? "item" : "items"}. Your reason goes back to the agent
            that proposed it, so it proposes better; a tool call keeps it on its record.
          </p>
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input
              type="checkbox"
              checked={rejecting.each}
              onChange={(event) => setRejecting({ ...rejecting, each: event.target.checked })}
            />
            Words for each
          </label>
          <fieldset>
            <legend className="text-xs font-medium text-ink-2">Quick reason</legend>
            <div className="mt-1 flex flex-wrap gap-2">
              {REJECT_CHIPS.map((chip) => (
                <button
                  key={chip.code}
                  type="button"
                  aria-pressed={rejecting.code === chip.code}
                  onClick={() => setRejecting({ ...rejecting, code: rejecting.code === chip.code ? null : chip.code })}
                  className={cn(
                    "h-8 rounded-full border px-3 text-xs font-medium",
                    rejecting.code === chip.code
                      ? "border-brand bg-brand-fill text-on-brand"
                      : "border-line bg-panel text-ink hover:bg-surface",
                  )}
                >
                  {chip.label}
                </button>
              ))}
            </div>
          </fieldset>
          {rejecting.each ? (
            rejectList.map((row) => (
              <label key={row.id} className="block text-xs font-medium text-ink-2">
                <span className="line-clamp-1">{rowSentence(row, now)}</span>
                <input
                  value={rejecting.per[row.id] ?? ""}
                  maxLength={MAX_DISMISS_REASON_LENGTH}
                  onChange={(event) =>
                    setRejecting({ ...rejecting, per: { ...rejecting.per, [row.id]: event.target.value } })
                  }
                  className={cn(fieldClass, "mt-1 h-9")}
                />
              </label>
            ))
          ) : (
            <label className="block text-xs font-medium text-ink-2">
              Reason in your words
              <input
                value={rejecting.one}
                maxLength={MAX_DISMISS_REASON_LENGTH}
                onChange={(event) => setRejecting({ ...rejecting, one: event.target.value })}
                className={cn(fieldClass, "mt-1 h-9")}
              />
            </label>
          )}
          {!ready && <p className="text-xs text-ink-3">Pick a quick reason or type one: it goes back to the proposer.</p>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy || !ready} className={cn(primaryButtonClass, small)}>
              Reject {rejectList.length}
            </button>
            <button
              type="button"
              onClick={() => setRejecting(null)}
              className={cn(quietButtonClass, small, "bg-panel text-ink")}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {shown.length === 0 ? (
        <p className="text-sm text-ink-2">
          {rows.length === 0 ? "No agent or bot is waiting on you." : "Nothing matches these filters."}
        </p>
      ) : (
        <>
          {sections.cash.length > 0 && (
            <section aria-labelledby={`${ids}-cash`} className="space-y-2">
              <h3 id={`${ids}-cash`} className="text-sm font-medium text-ink">
                Cash and runway
              </h3>
              {table("Cash and runway", sections.cash, 0)}
            </section>
          )}
          {sections.rest.length > 0 && (
            <section aria-labelledby={sections.cash.length > 0 ? `${ids}-rest` : undefined} className="space-y-2">
              {sections.cash.length > 0 && (
                <h3 id={`${ids}-rest`} className="text-sm font-medium text-ink">
                  Everything else
                </h3>
              )}
              {table("Waiting for you", sections.rest, sections.cash.length)}
            </section>
          )}
        </>
      )}
    </Panel>
  );
}
