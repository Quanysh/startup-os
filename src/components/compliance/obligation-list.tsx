"use client";

import { useMutation } from "convex/react";
import { ExternalLinkIcon, PencilIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import {
  OBLIGATION_CATEGORIES,
  RECURRENCE_LABELS,
  type ObligationCategory,
  type ObligationRow,
} from "@convex/lib/obligationShape";
import { nextOccurrence } from "@convex/lib/recurrence";
import { quietButtonClass } from "@/components/panel";
import {
  ActionsHeader,
  Blank,
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
} from "@/components/ui/data-table";
import { complianceSummary, dueState, dueText } from "@/lib/compliance/due";
import { messageOf } from "@/lib/errors";
import { dayLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { DueBadge, ProgressChip } from "./due-badge";
import { ObligationEditor } from "./obligation-editor";

const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/** Whether an item has a date that counts: a finished or skipped one needs none. */
function lacksConfirmedDate(o: ObligationRow, today: string): boolean {
  const { state } = dueState(o, today);
  return state === "no_date" || state === "unconfirmed";
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded-inner text-ink underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {children}
      <ExternalLinkIcon aria-hidden className="size-3.5 text-ink-2" />
    </a>
  );
}

const smallButton = cn(quietButtonClass, "h-8 bg-surface px-3 text-xs text-ink");
// The same button in a row: on white with a hairline, so it stands clear of
// the stripe, the row in hand and an overdue row's tint alike.
const rowButton = cn(smallButton, "border border-line bg-panel hover:bg-panel");

function Item({
  obligation: o,
  today,
  now,
  onEdit,
}: {
  obligation: ObligationRow;
  today: string;
  now: number;
  onEdit: () => void;
}) {
  const complete = useMutation(api.obligations.complete);
  const update = useMutation(api.obligations.update);
  const [error, setError] = useState<string | null>(null);
  // Finishing a repeating item replaces its date and files its evidence, and
  // there is no undo: it asks first, as deleting does.
  const [confirmDone, setConfirmDone] = useState(false);

  const { state } = dueState(o, today);
  const open = o.status === "open" || o.status === "in_progress";

  // The date this item was showing travels with the click, so a second click
  // on a repeating item cannot roll it on twice.
  const finish = () => complete({ id: o.id, today, expectedDue: o.due });

  const act = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(messageOf(failure));
    }
  };

  return (
    // Overdue is the one state here that asks for something today.
    <DataRow tone={state === "overdue" ? "danger" : undefined}>
      <DataRowHeader pinned className="sm:min-w-[14rem]">
        {o.title}
        {/* On a phone the note is left to the editor: the pinned column is narrow. */}
        {o.note !== null && (
          <p className="mt-1 hidden max-w-md text-sm font-normal text-ink-2 sm:block">{o.note}</p>
        )}
      </DataRowHeader>
      <DataCell className="min-w-[11rem] space-y-1">
        <DueBadge state={state} text={dueText(o, today, now)} />
        {o.sourceUrl !== null && (
          <p className="text-xs text-ink-2">
            <ExternalLink href={o.sourceUrl}>
              {o.due === null ? "Where the rule is stated" : "Where this date is stated"}
            </ExternalLink>
          </p>
        )}
      </DataCell>
      <DataCell hideBelow="md" className="whitespace-nowrap text-ink-2">
        {RECURRENCE_LABELS[o.recurrence]}
      </DataCell>
      <DataCell className="min-w-[8rem] space-y-1">
        <p className="whitespace-nowrap">
          <ProgressChip status={o.status} />
        </p>
        {o.lastDoneAt !== null && (
          <p className="text-xs text-ink-2">
            Last finished {dayLabel(new Date(o.lastDoneAt).toISOString().slice(0, 10), now)}
            {o.lastDoneFor !== null && ` (for ${dayLabel(o.lastDoneFor, now)})`}
          </p>
        )}
      </DataCell>
      <DataCell className="space-y-1 text-xs whitespace-nowrap text-ink-2">
        {o.evidenceUrl !== null ? (
          <p>
            <ExternalLink href={o.evidenceUrl}>Evidence</ExternalLink>
          </p>
        ) : open ? (
          <p>No evidence linked</p>
        ) : (
          o.lastEvidenceUrl === null && <Blank />
        )}
        {o.lastEvidenceUrl !== null && (
          <p>
            <ExternalLink href={o.lastEvidenceUrl}>Previous evidence</ExternalLink>
          </p>
        )}
      </DataCell>
      <DataCell actions className="py-2.5 whitespace-normal">
        <div className="flex flex-wrap items-center justify-end gap-2">
          {open && state === "unconfirmed" && (
            <button
              type="button"
              aria-label={`Confirm the date of ${o.title}`}
              onClick={() => act(() => update({ id: o.id, dueConfirmed: true }))}
              className={rowButton}
            >
              Confirm date
            </button>
          )}
          {open && confirmDone && o.recurrence !== "none" && (
            <span className="flex flex-wrap items-center justify-end gap-1 text-xs text-ink-2">
              {`Mark done and schedule ${dayLabel(nextOccurrence({ due: o.due, recurrence: o.recurrence, anchorDay: o.anchorDay }, today).due, now)}?`}
              <button
                type="button"
                onClick={() => {
                  setConfirmDone(false);
                  void act(finish);
                }}
                className="rounded-full px-3 py-1.5 font-medium text-ink outline-none hover:bg-panel focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                Done
              </button>
              <button
                type="button"
                onClick={() => setConfirmDone(false)}
                className="rounded-full px-3 py-1.5 outline-none hover:bg-panel focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                Keep
              </button>
            </span>
          )}
          {open && !confirmDone && (
            <button
              type="button"
              aria-label={`Mark ${o.title} done`}
              onClick={() => (o.recurrence === "none" ? act(finish) : setConfirmDone(true))}
              className={cn(rowButton, "whitespace-nowrap")}
            >
              Mark done
            </button>
          )}
          <button type="button" aria-label={`Edit ${o.title}`} onClick={onEdit} className={rowButton}>
            <PencilIcon aria-hidden className="size-3.5" />
            Edit
          </button>
        </div>
        {error && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        )}
      </DataCell>
    </DataRow>
  );
}

function Summary({ rows, today }: { rows: readonly ObligationRow[]; today: string }) {
  const summary = complianceSummary(rows, today);
  const unsettled = summary.unconfirmed.length + summary.noDate;
  const tiles: [string, string][] = [
    ["Overdue", String(summary.overdue.length)],
    ["Due in the next 30 days", String(summary.dueSoon.length)],
    ["Dates to confirm", String(summary.unconfirmed.length)],
    ["No date yet", String(summary.noDate)],
    ["Done", `${summary.done} of ${summary.total}`],
  ];
  return (
    <section aria-label="Summary" className="rounded-card bg-panel p-5 shadow-soft sm:p-6">
      <dl className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-ink-2">{label}</dt>
            <dd className="mt-1 text-2xl text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      {unsettled > 0 && (
        <p className="mt-4 max-w-3xl text-sm text-ink-2">
          {count(unsettled, "item has", "items have")} no confirmed date. Until its date is
          confirmed an item is never counted as due or overdue, so a zero above does not mean
          nothing is late.
        </p>
      )}
    </section>
  );
}

type Editing = { kind: "edit"; id: Id<"obligations"> } | { kind: "add"; category: ObligationCategory };

/**
 * Every obligation, by category, with what is due, what is unconfirmed and
 * where the evidence is.
 *
 * This component reports dates and evidence. It has no state, sentence or
 * colour that says a category, or the company, meets a standard.
 */
export function ObligationList({
  rows,
  today,
  now,
  categories = OBLIGATION_CATEGORIES,
}: {
  rows: readonly ObligationRow[];
  /** The categories to list: all of them, or the ones the company in view has. */
  categories?: readonly (typeof OBLIGATION_CATEGORIES)[number][];
  /** The owner's calendar date. */
  today: string;
  now: number;
}) {
  // The item being edited is held by id, so its editor outlives a live update.
  const [editing, setEditing] = useState<Editing | null>(null);
  const edited = editing?.kind === "edit" ? rows.find((o) => o.id === editing.id) : undefined;

  return (
    <div className="space-y-6">
      <Summary rows={rows} today={today} />

      {categories.map((category) => {
        const items = rows.filter((o) => o.category === category.id);
        const done = items.filter((o) => o.status === "done").length;
        const undated = items.filter((o) => lacksConfirmedDate(o, today)).length;
        const headingId = `category-${category.id}`;
        return (
          <section
            key={category.id}
            aria-labelledby={headingId}
            className="rounded-card bg-panel p-5 shadow-soft sm:p-6"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h2 id={headingId} className="text-base">
                  {category.label}
                </h2>
                <p className="mt-0.5 text-xs text-ink-2">
                  {items.length === 0
                    ? "Nothing listed."
                    : `${done} of ${items.length} done${
                        undated > 0 ? ` · ${undated} without a confirmed date` : ""
                      }`}
                </p>
              </div>
              <button
                type="button"
                aria-label={`Add an item to ${category.label}`}
                onClick={() => setEditing({ kind: "add", category: category.id })}
                className={smallButton}
              >
                <PlusIcon aria-hidden className="size-3.5" />
                Add an item
              </button>
            </div>
            {items.length > 0 && (
              <DataTable
                caption={`${category.label}: items`}
                className="min-w-[46rem] md:min-w-[58rem]"
                boxClassName="mt-3"
              >
                <DataHead>
                  <DataHeader pinned>Item</DataHeader>
                  <DataHeader>Due</DataHeader>
                  <DataHeader hideBelow="md">Repeats</DataHeader>
                  <DataHeader>Status</DataHeader>
                  <DataHeader>Evidence</DataHeader>
                  <ActionsHeader />
                </DataHead>
                <DataBody>
                  {items.map((o) => (
                    <Item
                      key={o.id}
                      obligation={o}
                      today={today}
                      now={now}
                      onEdit={() => setEditing({ kind: "edit", id: o.id })}
                    />
                  ))}
                </DataBody>
              </DataTable>
            )}
          </section>
        );
      })}

      {editing?.kind === "add" && (
        <ObligationEditor
          key={`add:${editing.category}`}
          obligation={null}
          category={editing.category}
          onClose={() => setEditing(null)}
        />
      )}
      {edited && (
        <ObligationEditor
          // Keyed by the item's id, never by its data: a live update must not remount the form.
          key={edited.id}
          obligation={edited}
          category={edited.category}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
