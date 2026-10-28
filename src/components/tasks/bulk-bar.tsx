"use client";

import { useMutation } from "convex/react";
import { Loader2Icon, Trash2Icon, XIcon } from "lucide-react";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { TASK_COLUMNS, taskColumnTitle, type TaskColumnId } from "@/lib/task-columns";
import { bulkReport, runBulk, type Outcome } from "@/lib/tasks/bulk";
import type { PersonOption } from "@/lib/tasks/view";
import { cn } from "@/lib/utils";
import type { Task } from "./task-card";

const control =
  "h-8 rounded-full border border-line bg-panel px-3 text-xs text-ink outline-none transition hover:border-ink-3 focus-visible:ring-3 focus-visible:ring-ring/50 aria-disabled:opacity-60";
const quiet =
  "inline-flex h-8 items-center gap-1 rounded-full px-3 text-xs font-medium text-ink-2 outline-none transition hover:bg-surface hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50 aria-disabled:opacity-60";

/** A large index: the end of the column, wherever that is. */
const END = Number.MAX_SAFE_INTEGER;

/**
 * What to do with the cards ticked on the board or in the list: move them,
 * give them to someone, set or clear their due date, or delete them. Each
 * card goes through the same mutation a single change does, one after
 * another, and the outcome is said in a status line (`role="status"`), with
 * the server's sentence for whatever it refused. The refused cards stay
 * selected; the rest are let go.
 */
export function BulkBar({
  selected,
  people,
  me,
  onKeep,
  onClear,
}: {
  /** The cards ticked, as they are on screen. */
  selected: readonly Task[];
  people: readonly PersonOption[];
  me: { email: string; label: string } | null;
  onKeep: (ids: readonly string[]) => void;
  onClear: () => void;
}) {
  const move = useMutation(api.tasks.move);
  const update = useMutation(api.tasks.update);
  const remove = useMutation(api.tasks.remove);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState("");
  const [confirming, setConfirming] = useState(false);
  const count = selected.length;

  const run = async (
    cards: readonly Task[],
    act: (id: Id<"tasks">) => Promise<unknown>,
    done: (count: number) => string,
  ) => {
    if (busy) return;
    setBusy(true);
    setConfirming(false);
    const outcomes: Outcome[] = await runBulk(
      cards.map((card) => card.id),
      (id) => act(id as Id<"tasks">),
    );
    setReport(bulkReport(outcomes, done));
    const refused = outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.id);
    if (refused.length === 0) onClear();
    else onKeep(refused);
    setBusy(false);
  };

  const moveTo = (column: TaskColumnId) => {
    const title = taskColumnTitle(column);
    const cards = selected.filter((card) => card.column !== column);
    if (cards.length === 0) return setReport(`Already in ${title}.`);
    void run(
      cards,
      (id) => move({ id, column, index: END }),
      (n) => `${n} moved to ${title}`,
    );
  };
  const assignTo = (value: string) => {
    const person =
      value === "" ? null : value === me?.email ? me : people.find((p) => p.email === value);
    if (person === undefined) return;
    void run(
      selected,
      (id) => update({ id, assignee: person?.email ?? null }),
      (n) => (person === null ? `${n} unassigned` : `${n} assigned to ${person.label}`),
    );
  };
  const setDue = (due: string | null) =>
    run(
      selected,
      (id) => update({ id, due }),
      (n) => (due === null ? `Due date cleared on ${n}` : `Due date set on ${n}`),
    );

  return (
    <>
      {count > 0 && (
        <div
          role="region"
          aria-label="Selected cards"
          aria-busy={busy}
          className="sticky bottom-4 z-20 mx-auto flex w-fit max-w-full flex-wrap items-center gap-1.5 rounded-card bg-panel p-1.5 pl-4 shadow-soft"
        >
          <span className="mr-1 font-num text-xs font-medium text-ink">{count} selected</span>
          <select
            aria-label="Move to"
            aria-disabled={busy}
            value=""
            onChange={(event) => event.target.value && moveTo(event.target.value as TaskColumnId)}
            className={control}
          >
            <option value="">Move to…</option>
            {TASK_COLUMNS.map((column) => (
              <option key={column.id} value={column.id}>
                {column.title}
              </option>
            ))}
          </select>
          <select
            aria-label="Assign to"
            aria-disabled={busy}
            value="pick"
            onChange={(event) => event.target.value !== "pick" && assignTo(event.target.value)}
            className={control}
          >
            <option value="pick">Assign to…</option>
            <option value="">Unassigned</option>
            {me && <option value={me.email}>{me.label} (you)</option>}
            {people.map((person) => (
              <option key={person.email} value={person.email}>
                {person.label}
              </option>
            ))}
          </select>
          <label className="inline-flex items-center">
            <span className="sr-only">Set due date</span>
            <input
              type="date"
              aria-disabled={busy}
              value=""
              onChange={(event) => event.target.value && void setDue(event.target.value)}
              className={cn(control, "w-36 text-ink-2")}
            />
          </label>
          <button type="button" aria-disabled={busy} onClick={() => void setDue(null)} className={quiet}>
            Clear due
          </button>
          {confirming ? (
            <span className="inline-flex items-center gap-1 pl-1 text-xs text-ink-2">
              Delete {count} {count === 1 ? "card" : "cards"}?
              <button
                type="button"
                aria-disabled={busy}
                onClick={() =>
                  void run(
                    selected,
                    (id) => remove({ id }),
                    (n) => `${n} deleted`,
                  )
                }
                className={cn(quiet, "text-destructive hover:bg-destructive/10 hover:text-destructive")}
              >
                Delete
              </button>
              <button type="button" onClick={() => setConfirming(false)} className={quiet}>
                Keep
              </button>
            </span>
          ) : (
            <button
              type="button"
              aria-disabled={busy}
              onClick={() => setConfirming(true)}
              className={cn(quiet, "hover:text-destructive")}
            >
              <Trash2Icon aria-hidden className="size-3.5" />
              Delete
            </button>
          )}
          <button type="button" onClick={onClear} className={quiet} aria-label="Cancel selection">
            {busy ? (
              <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
            ) : (
              <XIcon aria-hidden className="size-3.5" />
            )}
            Cancel
          </button>
        </div>
      )}
      {/* Always on the page, so a result is read out even once the bar has gone. */}
      <p role="status" className="text-center text-xs text-ink-2 empty:hidden">
        {report}
      </p>
    </>
  );
}
