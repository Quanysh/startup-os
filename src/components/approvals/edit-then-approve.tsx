"use client";

import { useMutation, useQuery } from "convex/react";
import { useId, useState, type ReactNode } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { MAX_NAME_LENGTH, MAX_NEXT_STEP_LENGTH, MAX_NOTES_LENGTH, MAX_TITLE_LENGTH } from "@convex/lib/limits";
import { MAX_COMMENT_BODY } from "@convex/lib/comments";
import { MAX_DECISION_CONTEXT, MAX_DECISION_TEXT, MAX_NOTE_BODY } from "@convex/lib/memory";
import { fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import type { InboxRow } from "@/lib/approvals/inbox";
import { MAX_DRAFT_BODY_LENGTH, MAX_DRAFT_TITLE_LENGTH } from "@/lib/assistant/agents";
import { fieldsOf } from "@/lib/assistant/words";
import { messageOf } from "@/lib/errors";
import { TASK_COLUMNS } from "@/lib/task-columns";
import { cn } from "@/lib/utils";

// "Edit then approve" on /approvals, and under a chat answer (the same row):
// the fields of every kind the owner may change before approving. It sends
// the whole payload of the proposal's own kind to `assistant.approve`; the
// server checks it as it checks a proposal (`edited` and `checkLive` in
// convex/lib/proposals.ts), keeps what changed as the proposal's `edits` and
// starts the proposer's streak again (convex/lib/trust.ts). What an edit
// cannot change stays as proposed: the task, deal or goal it names, the
// meeting a decision was seen in, what a draft is about, a goal's quarter and
// rating, and a deal's stage, contact and the rest. A bot's permission is
// approved or rejected as asked.

/** A proposal's fields the owner may change, as the form holds them. */
export type Draft = {
  title: string;
  notes: string;
  body: string;
  nextStep: string;
  /** An address, "" for nobody. */
  assignee: string;
  /** "YYYY-MM-DD", "" for none. */
  due: string;
  column: string;
  /** decision_record: what was decided, and why. */
  decision: string;
  context: string;
  /** handoff_reassign: who it goes to. The note sits in `body`. */
  to: string;
};

type Editable = Pick<InboxRow, "kind" | "payload" | "about">;
type Person = { email: string; name: string | null };

/** Whether this row has anything the owner may change before approving. */
export function isEditable(row: Pick<InboxRow, "source" | "kind" | "payload">): boolean {
  if (row.source !== "proposal" || row.kind === "bot_permission" || row.kind === "tool_call" || row.kind === "task_archive") {
    return false;
  }
  // A change to a goal that only re-rates it has nothing to type.
  if (row.kind === "goal_update") return "title" in (row.payload as Record<string, unknown>);
  return true;
}

export function draftOf(row: Editable): Draft {
  const fields = fieldsOf(row as never);
  return {
    title: fields.title ?? "",
    notes: fields.notes ?? "",
    body: fields.body ?? "",
    nextStep: fields.nextStep ?? "",
    assignee: fields.assignee ?? "",
    due: fields.due ?? "",
    column: fields.column ?? "backlog",
    decision: fields.decision ?? "",
    context: fields.context ?? "",
    to: fields.to ?? "",
    // A decision's owner and revisit date sit in the assignee and due fields.
    ...(row.kind === "decision_record" ? { assignee: fields.ownerEmail ?? "", due: fields.revisitOn ?? "" } : null),
    // A new deal's name sits in the title field.
    ...(row.kind === "deal_create" ? { title: fields.name ?? "" } : null),
    ...(row.kind === "handoff_reassign" ? { body: fields.note ?? "" } : null),
  };
}

/**
 * The payload an edit sends: the whole of it, of the proposal's own kind.
 * For a change to a task, only what the proposal set out to change is sent:
 * an emptied field clears, as the proposal's own null would.
 */
export function editedPayload(row: Editable, draft: Draft): Record<string, unknown> {
  const was = row.payload as Record<string, unknown>;
  switch (row.kind) {
    case "task_create":
      return {
        title: draft.title,
        ...(draft.notes.trim() === "" ? null : { notes: draft.notes }),
        ...(draft.assignee === "" ? null : { assignee: draft.assignee }),
        ...(draft.due === "" ? null : { due: draft.due }),
        column: draft.column,
      };
    case "task_change":
      return {
        taskId: was.taskId,
        ...("assignee" in was ? { assignee: draft.assignee === "" ? null : draft.assignee } : null),
        ...("due" in was ? { due: draft.due === "" ? null : draft.due } : null),
        ...("column" in was ? { column: draft.column } : null),
      };
    case "deal_next_step":
      return { dealId: was.dealId, nextStep: draft.nextStep };
    case "draft":
      // What a draft is about is not on the form: the server keeps it.
      return { title: draft.title, body: draft.body };
    case "decision_record":
      // The meeting it was seen in stays the one proposed.
      return {
        title: draft.title,
        decision: draft.decision,
        ...(draft.context.trim() === "" ? null : { context: draft.context }),
        ...(draft.assignee === "" ? null : { ownerEmail: draft.assignee }),
        ...(draft.due === "" ? null : { revisitOn: draft.due }),
        ...(was.meetingId === undefined ? null : { meetingId: was.meetingId }),
      };
    case "goal_create":
      // The quarter and everything but the title stay as proposed.
      return { ...was, title: draft.title };
    case "goal_update":
      return { ...was, ...("title" in was ? { title: draft.title } : null) };
    case "memory_note":
      return { title: draft.title, body: draft.body };
    case "comment":
      return { subjectKind: was.subjectKind, subjectId: was.subjectId, body: draft.body };
    case "task_archive":
      return { taskId: was.taskId };
    case "handoff_reassign":
      return {
        handoffId: was.handoffId,
        to: draft.to,
        ...(draft.body.trim() === "" ? null : { note: draft.body }),
      };
    case "deal_create": {
      // The name and the next step are the owner's to edit; the rest stays as proposed.
      const { nextStep: _nextStep, ...rest } = was;
      return { ...rest, name: draft.title, ...(draft.nextStep.trim() === "" ? null : { nextStep: draft.nextStep }) };
    }
    default:
      // A bot's permission, and anything else: as proposed.
      return was;
  }
}

const labelClass = "block text-xs font-medium text-ink-2";

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <div className="mt-1">{children(id)}</div>
    </div>
  );
}

/** The fields of this proposal's kind. Unsaved text is the form's own. */
function EditFields({
  row,
  draft,
  set,
  people,
}: {
  row: Editable;
  draft: Draft;
  set: (patch: Partial<Draft>) => void;
  people: readonly Person[];
}) {
  const was = row.payload as Record<string, unknown>;
  const input = cn(fieldClass, "h-9");
  const area = cn(fieldClass, "py-2");
  const text = (key: "title" | "nextStep", label: string, max: number) => (
    <Field label={label}>
      {(id) => (
        <input id={id} value={draft[key]} maxLength={max} onChange={(e) => set({ [key]: e.target.value })} className={input} />
      )}
    </Field>
  );
  // Whoever the proposal names stays offered, even if they can no longer be given it.
  const offered =
    draft.assignee !== "" && !people.some((person) => person.email === draft.assignee)
      ? [...people, { email: draft.assignee, name: row.about?.assignee ?? null }]
      : people;
  const person = (label: string) => (
    <Field label={label}>
      {(id) => (
        <select id={id} value={draft.assignee} onChange={(e) => set({ assignee: e.target.value })} className={input}>
          <option value="">Nobody</option>
          {offered.map((one) => (
            <option key={one.email} value={one.email}>
              {one.name ?? one.email}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
  const day = (label: string) => (
    <Field label={label}>
      {(id) => <input id={id} type="date" value={draft.due} onChange={(e) => set({ due: e.target.value })} className={input} />}
    </Field>
  );

  switch (row.kind) {
    case "goal_create":
    case "goal_update":
      return text("title", "Goal", MAX_TITLE_LENGTH);
    case "deal_create":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          {text("title", "Deal name", MAX_NAME_LENGTH)}
          {text("nextStep", "Next step", MAX_NEXT_STEP_LENGTH)}
        </div>
      );
    case "deal_next_step":
      return text("nextStep", "Next step", MAX_NEXT_STEP_LENGTH);
    case "draft":
      return (
        <div className="space-y-3">
          {text("title", "Title", MAX_DRAFT_TITLE_LENGTH)}
          <Field label="Text">
            {(id) => (
              <textarea
                id={id}
                value={draft.body}
                rows={8}
                maxLength={MAX_DRAFT_BODY_LENGTH}
                onChange={(e) => set({ body: e.target.value })}
                className={area}
              />
            )}
          </Field>
        </div>
      );
    case "memory_note":
      return (
        <div className="space-y-3">
          {text("title", "Title", MAX_TITLE_LENGTH)}
          <Field label="Note">
            {(id) => (
              <textarea
                id={id}
                value={draft.body}
                rows={6}
                maxLength={MAX_NOTE_BODY}
                onChange={(e) => set({ body: e.target.value })}
                className={area}
              />
            )}
          </Field>
        </div>
      );
    case "comment":
      return (
        <Field label="Comment">
          {(id) => (
            <textarea
              id={id}
              value={draft.body}
              rows={4}
              maxLength={MAX_COMMENT_BODY}
              onChange={(e) => set({ body: e.target.value })}
              className={area}
            />
          )}
        </Field>
      );
    case "handoff_reassign":
      return (
        <div className="space-y-3">
          <Field label="Hand to">
            {(id) => (
              <input id={id} value={draft.to} maxLength={254} onChange={(e) => set({ to: e.target.value })} className={input} />
            )}
          </Field>
          <Field label="Note">
            {(id) => (
              <textarea
                id={id}
                value={draft.body}
                rows={3}
                maxLength={500}
                onChange={(e) => set({ body: e.target.value })}
                className={area}
              />
            )}
          </Field>
        </div>
      );
    case "task_archive":
      return null;
    case "decision_record":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-3 sm:col-span-2">
            {text("title", "Title", MAX_TITLE_LENGTH)}
            <Field label="Decision">
              {(id) => (
                <textarea
                  id={id}
                  value={draft.decision}
                  rows={3}
                  maxLength={MAX_DECISION_TEXT}
                  onChange={(e) => set({ decision: e.target.value })}
                  className={area}
                />
              )}
            </Field>
            <Field label="Context">
              {(id) => (
                <textarea
                  id={id}
                  value={draft.context}
                  rows={3}
                  maxLength={MAX_DECISION_CONTEXT}
                  onChange={(e) => set({ context: e.target.value })}
                  className={area}
                />
              )}
            </Field>
          </div>
          {person("Owner")}
          {day("Revisit on")}
        </div>
      );
    default: {
      // A new task, or a change to one: only what the change set out to change.
      const creating = row.kind === "task_create";
      const has = (field: string) => creating || field in was;
      return (
        <div className="grid gap-3 sm:grid-cols-3">
          {creating && (
            <div className="space-y-3 sm:col-span-3">
              {text("title", "Title", MAX_TITLE_LENGTH)}
              <Field label="Notes">
                {(id) => (
                  <textarea
                    id={id}
                    value={draft.notes}
                    rows={3}
                    maxLength={MAX_NOTES_LENGTH}
                    onChange={(e) => set({ notes: e.target.value })}
                    className={area}
                  />
                )}
              </Field>
            </div>
          )}
          {has("assignee") && person("Assignee")}
          {has("due") && day("Due")}
          {has("column") && (
            <Field label="Column">
              {(id) => (
                <select id={id} value={draft.column} onChange={(e) => set({ column: e.target.value })} className={input}>
                  {TASK_COLUMNS.map((column) => (
                    <option key={column.id} value={column.id}>
                      {column.title}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
        </div>
      );
    }
  }
}

const small = "h-9 px-3";

/** "Edit then approve": a button, and the form it opens. Nothing is sent before "Approve with changes". */
export function EditThenApprove({ row, buttonClassName }: { row: InboxRow; buttonClassName?: string }) {
  const approve = useMutation(api.assistant.approve);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Who a task or a decision can be given to on the proposal's company, asked only while the form is open.
  const needsPeople = draft !== null && (row.kind === "task_create" || row.kind === "task_change" || row.kind === "decision_record");
  const people = useQuery(api.team.assignable, needsPeople && row.company !== null ? { company: row.company } : "skip");
  if (!isEditable(row)) return null;
  const keep = row.kind === "draft";

  if (draft === null) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(draftOf(row));
          setError(null);
        }}
        className={buttonClassName ?? cn(quietButtonClass, small, "mt-2")}
      >
        Edit then approve
      </button>
    );
  }

  return (
    <form
      className="mt-2 w-full basis-full space-y-3 text-left"
      aria-label="Edit then approve"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setError(null);
        approve({ id: row.id as Id<"proposals">, edit: editedPayload(row, draft) as never })
          .then(() => setDraft(null))
          .catch((failure: unknown) => setError(messageOf(failure, "That could not be done. Try again.")))
          .finally(() => setBusy(false));
      }}
    >
      <EditFields row={row} draft={draft} set={(patch) => setDraft({ ...draft, ...patch })} people={people ?? []} />
      <p className="text-xs text-ink-3">An edit is kept, and this proposer&apos;s run of clean approvals starts again.</p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={cn(primaryButtonClass, small)}>
          {keep ? "Keep with changes" : "Approve with changes"}
        </button>
        <button type="button" onClick={() => setDraft(null)} className={cn(quietButtonClass, small, "bg-panel text-ink")}>
          Cancel
        </button>
      </div>
      {error !== null && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
