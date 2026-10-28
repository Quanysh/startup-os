"use client";

import { MAX_NOTES_LENGTH } from "@convex/lib/limits";
import { useMutation, useQuery } from "convex/react";
import { Loader2Icon, Trash2Icon } from "lucide-react";
import { useId, useState } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import { useViewer } from "@/hooks/use-viewer";
import { messageOf } from "@/lib/errors";
import { duplicateWarning, type NearCard } from "@/lib/tasks/duplicates";
import { TASK_COLUMNS } from "@/lib/task-columns";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  ASSIGNEE_NOT_ON_COMPANY,
  isStranded,
  personLabel,
  selectionOf,
  type Selection,
} from "./assignee";
import { useCompany } from "@/components/company-provider";
import { DuplicateWarning } from "./duplicate-warning";
import { AssigneePicker, CompanyPicker, useAssignable } from "./assignee-picker";
import { MentionField, mentionListOpen } from "./mention-field";
import { mentionedIn, type Picked } from "./mentions";
import { OriginTag, originSentence } from "./origin";
import type { Task } from "./task-card";

/** "Ada", "Ada and Sam", "Ada, Sam and Erik". */
const listOf = (names: readonly string[]) =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * Edit one task. Also the way to move a card without dragging: the column is
 * a field here like any other. So are who the task is for and, for a viewer
 * on both companies, which company it belongs to.
 *
 * With no `task` it makes a new card instead ("New task" on the board), with
 * every field, at the top of its column. It takes the company in view (a
 * viewer on one company: that company) and is unassigned unless `assignToMe`.
 */
export function TaskEditor({
  task,
  quarter,
  onClose,
  assignToMe = false,
}: {
  task: Task | null;
  /** The current quarter, whose goals a task can be linked to. */
  quarter: string | null;
  onClose: () => void;
  /** A new card starts assigned to the viewer (the board is showing only theirs). */
  assignToMe?: boolean;
}) {
  const create = useMutation(api.tasks.create);
  const update = useMutation(api.tasks.update);
  const remove = useMutation(api.tasks.remove);
  const goals = useQuery(api.goals.list, quarter ? { quarter } : "skip");
  const viewer = useViewer();
  // With a company in view the switch has already said whose task this is.
  const inView = useCompany();
  const hasChoice = viewer.companies.length > 1 && inView === null;

  const [title, setTitle] = useState(task?.title ?? "");
  const [notes, setNotes] = useState(task?.notes ?? "");
  const [kind, setKind] = useState<Task["kind"]>(task?.kind ?? "task");
  const [column, setColumn] = useState<Task["column"]>(task?.column ?? "backlog");
  const [goalId, setGoalId] = useState<string>(task?.goalId ?? "");
  const [due, setDue] = useState(task?.due ?? "");
  const [company, setCompany] = useState<Task["company"]>(() =>
    task !== null
      ? task.company
      : inView !== null && viewer.companies.includes(inView)
        ? inView
        : hasChoice
          ? null
          : (viewer.companies[0] ?? null),
  );
  const [original] = useState(() => (task === null ? null : selectionOf(task.assignee)));
  const [assignee, setAssignee] = useState<Selection>(() =>
    task === null && assignToMe && viewer.email !== null
      ? {
          value: viewer.email.toLowerCase(),
          label: personLabel({ email: viewer.email, name: viewer.name }),
        }
      : original,
  );
  const people = useAssignable(company);
  // Whoever holds the task must be on the company it is given to. The server
  // lets an assignee it was not asked about stay while the company stays, so
  // only a change of either can strand them.
  const stranded =
    isStranded(assignee, people) &&
    (task === null || assignee?.value !== original?.value || company !== task.company);
  // Who was picked from the list after an `@`, in the title or the
  // description. Only those whose `@name` is still in the text are sent.
  const [picked, setPicked] = useState<Picked[]>([]);
  const mention = (person: Picked) => setPicked((had) => [...had, person]);
  const mentions = mentionedIn(picked, [title, notes]);
  const toTell = [...new Set(picked.filter((p) => mentions.includes(p.email)).map((p) => p.label))];
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The open cards a new one may repeat, as the server named them, until the person decides.
  const [near, setNear] = useState<NearCard[] | null>(null);

  const ids = {
    title: useId(),
    notes: useId(),
    kind: useId(),
    column: useId(),
    goal: useId(),
    due: useId(),
    assignee: useId(),
    company: useId(),
  };

  /**
   * Add the new card: first asking to be warned of a near open one, then,
   * after "Add anyway", as confirmed. A person is never refused for it.
   */
  const add = async (duplicates: "warn" | "confirmed") => {
    setNear(null);
    try {
      const id = await create({
        title,
        ...(notes.trim() === "" ? null : { notes }),
        column,
        kind,
        ...(goalId === "" ? null : { goalId: goalId as Id<"goals"> }),
        assignee: assignee?.value ?? null,
        company,
        ...(due === "" ? null : { due }),
        index: 0,
        duplicates,
      });
      // Who the text mentions is told once the card exists.
      if (mentions.length > 0) await update({ id, mentions });
      onClose();
    } catch (failure) {
      const cards = duplicateWarning(failure);
      if (cards !== null) setNear(cards);
      else setError(messageOf(failure));
      setBusy(false);
    }
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (title.trim() === "") return setError("A task needs a title.");
    // The server would refuse this with the same sentence.
    if (stranded) return setError(ASSIGNEE_NOT_ON_COMPANY);
    setBusy(true);
    setError(null);
    if (task === null) return add("warn");
    try {
      // One mutation for everything, column included, so a failure cannot
      // leave the fields saved and the card unmoved.
      await update({
        id: task.id,
        title,
        kind,
        column,
        notes: notes.trim() === "" ? null : notes,
        goalId: goalId === "" ? null : (goalId as Id<"goals">),
        due: due === "" ? null : due,
        // Left out, the server keeps them: an assignee who was not changed
        // (one who cannot be named has no address to send), and the company
        // for a viewer with nothing to choose between.
        ...(assignee?.value !== original?.value ? { assignee: assignee?.value ?? null } : null),
        ...(hasChoice ? { company } : null),
        // Who the text mentions is this list, never the text itself.
        ...(mentions.length > 0 ? { mentions } : null),
      });
      onClose();
    } catch (failure) {
      setError(messageOf(failure));
      setBusy(false);
    }
  };

  // A goal from an earlier quarter stays selectable so saving does not drop it.
  const goalOptions = [
    ...(task?.goalId && !goals?.some((g) => g.id === task.goalId)
      ? [{ id: task.goalId as string, title: task.goalTitle ?? "Earlier goal" }]
      : []),
    ...(goals ?? []).map((g) => ({ id: g.id as string, title: g.title })),
  ];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[92dvh] overflow-y-auto rounded-card p-6 sm:max-w-2xl"
        // Escape puts an open list of people away first; the editor stays.
        onEscapeKeyDown={(event) => {
          if (mentionListOpen()) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-lg">{task === null ? "New card" : "Edit card"}</DialogTitle>
          <DialogDescription className="sr-only">
            {task === null
              ? "A new card's title, notes, assignee, column, goal and due date. It goes to the top of its column."
              : "Change this card's title, notes, assignee, column, goal and due date."}
          </DialogDescription>
        </DialogHeader>

        {/* Said, never edited: where a card came from is not a field. */}
        {task?.origin && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
            <OriginTag origin={task.origin} />
            <span>
              {originSentence(task.origin)}.
              {task.origin.source === "standup" &&
                " Nobody typed it in: change what is wrong, or delete it."}
              {task.origin.source === "suggestion" &&
                " Sent with “Suggest a change”: turn it into a task, or delete it."}
            </span>
          </p>
        )}

        <form onSubmit={save} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={ids.title}>Title</Label>
            {/* A long title wraps and is read whole, not cut at the field's edge.
                It stays one line of text: Enter saves, as in a text field. */}
            <MentionField
              id={ids.title}
              value={title}
              rows={1}
              singleLine
              onChange={setTitle}
              people={people}
              onMention={mention}
              className={`${fieldClass} min-h-10 resize-none py-2 leading-snug [field-sizing:content]`}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor={ids.notes}>Description</Label>
              {/* Said only once it matters: most descriptions are nowhere near it. */}
              {notes.length > MAX_NOTES_LENGTH * 0.8 && (
                <span
                  className={`font-num text-xs ${notes.length > MAX_NOTES_LENGTH ? "text-destructive" : "text-ink-3"}`}
                >
                  {notes.length.toLocaleString("en-US")} / {MAX_NOTES_LENGTH.toLocaleString("en-US")}
                </span>
              )}
            </div>
            {/* Room to write: it opens tall, grows with what is typed up to half
                the screen, then scrolls; the corner still drags it taller. */}
            <MentionField
              id={ids.notes}
              value={notes}
              onChange={setNotes}
              people={people}
              onMention={mention}
              rows={8}
              placeholder="What needs doing, links, context. Type @ to mention someone."
              className={`${fieldClass} min-h-44 max-h-[50dvh] resize-y py-2 leading-relaxed [field-sizing:content]`}
            />
            {/* Said before the save, so nobody is told by surprise. */}
            {toTell.length > 0 && (
              <p aria-live="polite" className="text-xs text-ink-2">
                {listOf(toTell)} will be told when you save.
              </p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className={hasChoice ? "space-y-1.5" : "space-y-1.5 sm:col-span-2"}>
              <Label htmlFor={ids.assignee}>Assignee</Label>
              <AssigneePicker
                id={ids.assignee}
                selection={assignee}
                onChange={setAssignee}
                people={people}
                company={company}
                stranded={stranded}
                className="h-10"
              />
            </div>
            {hasChoice && (
              <div className="space-y-1.5">
                <Label htmlFor={ids.company}>Company</Label>
                <CompanyPicker
                  id={ids.company}
                  companies={viewer.companies}
                  value={company}
                  onChange={setCompany}
                  className="h-10"
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor={ids.column}>Column</Label>
              <select
                id={ids.column}
                value={column}
                onChange={(e) => setColumn(e.target.value as Task["column"])}
                className={`${fieldClass} h-10`}
              >
                {TASK_COLUMNS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.kind}>Type</Label>
              <select
                id={ids.kind}
                value={kind}
                onChange={(e) => setKind(e.target.value as Task["kind"])}
                className={`${fieldClass} h-10`}
              >
                <option value="task">Task: something to do</option>
                <option value="issue">Problem: something to solve</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.goal}>Goal</Label>
              <select
                id={ids.goal}
                value={goalId}
                onChange={(e) => setGoalId(e.target.value)}
                className={`${fieldClass} h-10`}
              >
                <option value="">None</option>
                {goalOptions.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.due}>Due</Label>
              <input
                id={ids.due}
                type="date"
                value={due}
                onChange={(e) => setDue(e.target.value)}
                className={`${fieldClass} h-10`}
              />
            </div>
          </div>

          {near !== null && (
            <DuplicateWarning
              cards={near}
              busy={busy}
              className="space-y-1.5 text-sm text-ink-2"
              onAdd={() => {
                setBusy(true);
                void add("confirmed");
              }}
              onCancel={() => setNear(null)}
            />
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            {task === null ? (
              <span />
            ) : confirmDelete ? (
              <span className="flex items-center gap-1 text-sm text-ink-2">
                Delete this card?
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await remove({ id: task.id });
                      onClose();
                    } catch (failure) {
                      setError(messageOf(failure, "That card could not be deleted. Try again."));
                      setConfirmDelete(false);
                    }
                  }}
                  className="rounded-full px-3 py-1.5 font-medium text-destructive outline-none hover:bg-destructive/10 focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-full px-3 py-1.5 outline-none hover:bg-surface focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  Keep
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className={`${quietButtonClass} -ml-3 hover:text-destructive`}
              >
                <Trash2Icon aria-hidden className="size-4" />
                Delete
              </button>
            )}
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className={quietButtonClass}>
                Cancel
              </button>
              {/* aria-disabled, not disabled: a natively disabled button drops focus mid-request. */}
              <button
                type="submit"
                aria-disabled={busy}
                className={`${primaryButtonClass} aria-disabled:opacity-60`}
              >
                {busy && <Loader2Icon aria-hidden className="size-4 animate-spin" />}
                Save
              </button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
