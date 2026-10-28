"use client";

import { useMutation } from "convex/react";
import { PlusIcon } from "lucide-react";
import { useRef, useState } from "react";
import { api } from "@convex/_generated/api";
import { useCompany } from "@/components/company-provider";
import { fieldClass } from "@/components/panel";
import { useViewer } from "@/hooks/use-viewer";
import type { CompanyId } from "@/lib/company";
import { messageOf } from "@/lib/errors";
import { duplicateWarning, type NearCard } from "@/lib/tasks/duplicates";
import { ASSIGNEE_NOT_ON_COMPANY, isStranded, personLabel, type Selection } from "./assignee";
import { AssigneePicker, CompanyPicker, useAssignable } from "./assignee-picker";
import { DuplicateWarning } from "./duplicate-warning";
import type { Task } from "./task-card";

/**
 * The "add a card" control at the foot of a board column: a button that
 * opens `AddTaskForm` in its place. (The task board itself opens the form at
 * the top of a column instead, from the column's "+".)
 */
export function AddTask({
  column,
  columnTitle,
  assignToMe = false,
}: {
  column: Task["column"];
  columnTitle: string;
  /** Start each card assigned to the viewer: the board is showing only theirs. */
  assignToMe?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Set when the form closes, so focus goes back to the button that opened it
  // rather than falling off to the top of the page.
  const returnFocus = useRef(false);

  if (open) {
    return (
      <AddTaskForm
        column={column}
        columnTitle={columnTitle}
        assignToMe={assignToMe}
        onClose={() => {
          returnFocus.current = true;
          setOpen(false);
        }}
      />
    );
  }
  return (
    <button
      type="button"
      ref={(button) => {
        if (button && returnFocus.current) {
          returnFocus.current = false;
          button.focus();
        }
      }}
      onClick={() => setOpen(true)}
      className="flex w-full items-center gap-1.5 rounded-inner px-2 py-1.5 text-xs text-ink-2 outline-none hover:bg-panel hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <PlusIcon aria-hidden className="size-3.5" />
      Add a card
    </button>
  );
}

/**
 * The quick-add form, open from the moment it is drawn. A new card takes the
 * company in view (a viewer on one company: that company, with nothing to
 * pick), and is unassigned unless `assignToMe`. With `atTop` it goes first in
 * its column; otherwise last.
 */
export function AddTaskForm({
  column,
  columnTitle,
  assignToMe = false,
  assignTo,
  atTop = false,
  onClose,
}: {
  column: Task["column"];
  columnTitle: string;
  assignToMe?: boolean;
  /** Whom the card starts assigned to (a person's row): wins over `assignToMe`. */
  assignTo?: Selection;
  atTop?: boolean;
  onClose: () => void;
}) {
  const create = useMutation(api.tasks.create);
  const viewer = useViewer();
  const inView = useCompany();
  // With a company in view the switch has already said whose task this is.
  const hasChoice = viewer.companies.length > 1 && inView === null;
  const [title, setTitle] = useState("");
  const [issue, setIssue] = useState(false);
  // Read when the form opens, not when the column was first drawn: the
  // company in view and the filter may have changed since. The company in
  // view, when the viewer is on it; with none in view the picker starts on
  // both, and someone on one company has only it.
  const [company, setCompany] = useState<CompanyId | null>(() =>
    inView !== null && viewer.companies.includes(inView)
      ? inView
      : hasChoice
        ? null
        : (viewer.companies[0] ?? null),
  );
  const [assignee, setAssignee] = useState<Selection>(() =>
    assignTo !== undefined
      ? assignTo
      : assignToMe && viewer.email !== null
      ? {
          value: viewer.email.toLowerCase(),
          label: personLabel({ email: viewer.email, name: viewer.name }),
        }
      : null,
  );
  const people = useAssignable(company);
  const [error, setError] = useState<string | null>(null);
  // A card the server warned may repeat an open one: what was sent, and the
  // open cards it named, until "Add anyway" or "Don't add".
  type Card = Parameters<typeof create>[0];
  const [near, setNear] = useState<{ card: Card; cards: NearCard[] } | null>(null);
  const stranded = isStranded(assignee, people);

  const close = onClose;

  /** Send a card; a near-duplicate warning holds it for the person to decide. */
  const send = async (card: Card) => {
    try {
      await create(card);
    } catch (failure) {
      const cards = duplicateWarning(failure);
      if (cards !== null) return setNear({ card, cards });
      setError(messageOf(failure, "That could not be added. Try again."));
      // Give the title back, unless something newer has been typed since.
      setTitle((current) => (current === "" ? card.title : current));
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const submitted = title;
    if (submitted.trim() === "") return close();
    // The server would refuse this with the same sentence; say it without
    // the round trip, and keep what was typed.
    if (stranded) return setError(ASSIGNEE_NOT_ON_COMPANY);
    // Clear the field before the save, not after it. Adding several cards in
    // a row is the usual case, and clearing when the save lands would erase
    // whatever was typed for the next card in the meantime (and a second
    // Enter would add the first card twice).
    setTitle("");
    setError(null);
    const kind = issue ? "issue" : "task";
    setIssue(false);
    setNear(null);
    await send({
      title: submitted,
      column,
      kind,
      assignee: assignee?.value ?? null,
      company,
      ...(atTop ? { index: 0 } : null),
      // A near open card is warned of first; the person may add it anyway.
      duplicates: "warn",
    });
  };

  return (
    <form
      onSubmit={submit}
      onKeyDown={(e) => e.key === "Escape" && close()}
      className="space-y-2 rounded-inner bg-panel p-2 shadow-soft-sm"
    >
      <input
        autoFocus
        aria-label={`New card in ${columnTitle}`}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What needs doing?"
        className={`${fieldClass} h-9`}
      />
      {/* Stacked: a column is too narrow on a phone for two pickers abreast. */}
      <AssigneePicker
        aria-label="Assignee"
        selection={assignee}
        onChange={(next) => {
          setAssignee(next);
          setError(null);
        }}
        people={people}
        company={company}
        stranded={stranded}
        className="h-8 px-2 text-xs"
      />
      {hasChoice && (
        <CompanyPicker
          aria-label="Company"
          companies={viewer.companies}
          value={company}
          onChange={setCompany}
          className="h-8 px-2 text-xs"
        />
      )}
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-1.5 text-xs text-ink-2">
          <input
            type="checkbox"
            checked={issue}
            onChange={(e) => setIssue(e.target.checked)}
            className="size-3.5 accent-brand"
          />
          It&apos;s a problem
        </label>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={close}
            className="rounded-full px-2.5 py-1 text-xs text-ink-2 outline-none hover:bg-surface focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Done
          </button>
          <button
            type="submit"
            className="rounded-full bg-brand-fill px-3 py-1 text-xs font-medium text-on-brand outline-none hover:bg-brand-deep focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Add
          </button>
        </div>
      </div>
      {near !== null && (
        <DuplicateWarning
          cards={near.cards}
          onAdd={() => {
            const { card } = near;
            setNear(null);
            void send({ ...card, duplicates: "confirmed" });
          }}
          onCancel={() => {
            const { card } = near;
            setNear(null);
            // Given back to change, unless something newer has been typed since.
            setTitle((current) => (current === "" ? card.title : current));
          }}
        />
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
