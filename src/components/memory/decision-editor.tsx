"use client";

import { useMutation, useQuery } from "convex/react";
import { useId, useState, type ReactNode } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { MAX_TITLE_LENGTH } from "@convex/lib/limits";
import {
  DECISION_STATUSES,
  DECISION_STATUS_LABELS,
  MAX_DECISION_CONTEXT,
  MAX_DECISION_TEXT,
  type DecisionStatus,
} from "@convex/lib/memory";
import { quarterOf } from "@convex/lib/quarter";
import { fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import { COMPANIES, type CompanyId } from "@/lib/company";
import { messageOf } from "@/lib/errors";
import type { DecisionRow } from "@/lib/memory/view";
import { cn } from "@/lib/utils";

/** What the form holds while it is typed in: its own, never re-keyed on server data. */
type Draft = {
  company: CompanyId;
  title: string;
  decision: string;
  context: string;
  owner: string;
  decidedOn: string;
  status: DecisionStatus;
  revisitOn: string;
  tags: string;
  meetingId: string;
  taskIds: string[];
  dealIds: string[];
  goalIds: string[];
};

export function draftOfDecision(row: DecisionRow | null, company: CompanyId, today: string): Draft {
  return {
    company: row?.company ?? company,
    title: row?.title ?? "",
    decision: row?.decision ?? "",
    context: row?.context ?? "",
    owner: row?.owner?.email ?? "",
    decidedOn: row?.decidedOn ?? today,
    status: row?.status ?? "decided",
    revisitOn: row?.revisitOn ?? "",
    tags: row?.tags.join(", ") ?? "",
    meetingId: row?.meetingId ?? "",
    taskIds: row?.taskIds ?? [],
    dealIds: row?.dealIds ?? [],
    goalIds: row?.goalIds ?? [],
  };
}

function Field({ label, children, wide }: { label: string; children: (id: string) => ReactNode; wide?: boolean }) {
  const id = useId();
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <label htmlFor={id} className="text-xs font-medium text-ink-2">
        {label}
      </label>
      <div className="mt-1">{children(id)}</div>
    </div>
  );
}

function LinkChecks({
  legend,
  options,
  chosen,
  onChange,
}: {
  legend: string;
  options: readonly { id: string; title: string }[];
  chosen: readonly string[];
  onChange: (next: string[]) => void;
}) {
  if (options.length === 0) return null;
  return (
    <fieldset className="min-w-0">
      <legend className="text-xs font-medium text-ink-2">{legend}</legend>
      <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto rounded-inner bg-surface p-2">
        {options.map((option) => (
          <li key={option.id}>
            <label className="flex items-start gap-2 text-sm text-ink">
              <input
                type="checkbox"
                className="mt-1"
                checked={chosen.includes(option.id)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...chosen, option.id]
                      : chosen.filter((id) => id !== option.id),
                  )
                }
              />
              <span className="[overflow-wrap:anywhere]">{option.title}</span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

/**
 * Record or change a decision. The owner is one of the people a task of that
 * company could be given to; the server checks it again. Nothing typed is
 * lost to a live update: the draft is the form's own.
 */
export function DecisionEditor({
  row,
  company,
  companies,
  today,
  meetings,
  onDone,
}: {
  row: DecisionRow | null;
  company: CompanyId;
  companies: readonly CompanyId[];
  today: string;
  meetings: readonly { id: string; title: string; heldOn: string; company: CompanyId }[];
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOfDecision(row, company, today));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = useMutation(api.decisions.create);
  const update = useMutation(api.decisions.update);
  const remove = useMutation(api.decisions.remove);
  const people = useQuery(api.decisions.people, { company: draft.company });
  const linkable = useQuery(api.decisions.linkable, { company: draft.company, quarter: quarterOf(Date.parse(today)) });
  const set = (patch: Partial<Draft>) => setDraft((was) => ({ ...was, ...patch }));
  const input = cn(fieldClass, "h-9");

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const fields = {
      company: draft.company,
      title: draft.title,
      decision: draft.decision,
      context: draft.context,
      owner: draft.owner === "" ? null : draft.owner,
      decidedOn: draft.decidedOn,
      status: draft.status,
      revisitOn: draft.revisitOn === "" ? null : draft.revisitOn,
      tags: draft.tags.split(","),
      meetingId: draft.meetingId === "" ? null : (draft.meetingId as Id<"meetingNotes">),
      taskIds: draft.taskIds as Id<"tasks">[],
      dealIds: draft.dealIds as Id<"deals">[],
      goalIds: draft.goalIds as Id<"goals">[],
    };
    try {
      if (row === null) await create(fields);
      else await update({ id: row.id, ...fields });
      onDone();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (row === null || busy) return;
    if (!window.confirm("Delete this decision? This cannot be undone.")) return;
    try {
      await remove({ id: row.id });
      onDone();
    } catch (failure) {
      setError(messageOf(failure));
    }
  };

  const offered = (people ?? []).some((person) => person.email === draft.owner) || draft.owner === ""
    ? (people ?? [])
    : [...(people ?? []), { email: draft.owner, name: row?.owner?.name ?? null }];

  return (
    <form
      aria-label={row === null ? "Record a decision" : "Edit the decision"}
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {companies.length > 1 && row === null && (
        <Field label="Company">
          {(id) => (
            <select
              id={id}
              value={draft.company}
              onChange={(event) => set({ company: event.target.value as CompanyId, owner: "", meetingId: "" })}
              className={input}
            >
              {companies.map((one) => (
                <option key={one} value={one}>
                  {COMPANIES[one].name}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      <Field label="Title" wide>
        {(id) => (
          <input id={id} required value={draft.title} maxLength={MAX_TITLE_LENGTH} onChange={(e) => set({ title: e.target.value })} className={input} />
        )}
      </Field>
      <Field label="What was decided" wide>
        {(id) => (
          <textarea id={id} required rows={3} value={draft.decision} maxLength={MAX_DECISION_TEXT} onChange={(e) => set({ decision: e.target.value })} className={cn(fieldClass, "py-2")} />
        )}
      </Field>
      <Field label="Why: the context and what else was weighed" wide>
        {(id) => (
          <textarea id={id} rows={4} value={draft.context} maxLength={MAX_DECISION_CONTEXT} onChange={(e) => set({ context: e.target.value })} className={cn(fieldClass, "py-2")} />
        )}
      </Field>
      <Field label="Status">
        {(id) => (
          <select id={id} value={draft.status} onChange={(e) => set({ status: e.target.value as DecisionStatus })} className={input}>
            {DECISION_STATUSES.map((status) => (
              <option key={status} value={status}>
                {DECISION_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Owner">
        {(id) => (
          <select id={id} value={draft.owner} onChange={(e) => set({ owner: e.target.value })} className={input}>
            <option value="">Nobody</option>
            {offered.map((person) => (
              <option key={person.email} value={person.email}>
                {person.name ?? person.email}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Decided on">
        {(id) => <input id={id} type="date" required value={draft.decidedOn} onChange={(e) => set({ decidedOn: e.target.value })} className={input} />}
      </Field>
      <Field label="Revisit on">
        {(id) => <input id={id} type="date" value={draft.revisitOn} onChange={(e) => set({ revisitOn: e.target.value })} className={input} />}
      </Field>
      <Field label="Tags, separated by commas">
        {(id) => <input id={id} value={draft.tags} onChange={(e) => set({ tags: e.target.value })} className={input} />}
      </Field>
      <Field label="Made in the meeting">
        {(id) => (
          <select id={id} value={draft.meetingId} onChange={(e) => set({ meetingId: e.target.value })} className={input}>
            <option value="">None</option>
            {meetings
              .filter((meeting) => meeting.company === draft.company)
              .map((meeting) => (
                <option key={meeting.id} value={meeting.id}>
                  {meeting.heldOn}: {meeting.title}
                </option>
              ))}
          </select>
        )}
      </Field>
      {linkable !== undefined && (
        <div className="grid gap-3 sm:col-span-2 sm:grid-cols-3">
          <LinkChecks legend="Tasks" options={linkable.tasks} chosen={draft.taskIds} onChange={(taskIds) => set({ taskIds })} />
          <LinkChecks legend="Deals" options={linkable.deals} chosen={draft.dealIds} onChange={(dealIds) => set({ dealIds })} />
          <LinkChecks legend="Goals this quarter" options={linkable.goals} chosen={draft.goalIds} onChange={(goalIds) => set({ goalIds })} />
        </div>
      )}
      {error !== null && (
        <p role="alert" className="text-sm text-destructive sm:col-span-2">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <button type="submit" aria-disabled={busy} className={cn(primaryButtonClass, "aria-disabled:opacity-60")}>
          {row === null ? "Record the decision" : "Save changes"}
        </button>
        <button type="button" onClick={onDone} className={quietButtonClass}>
          Cancel
        </button>
        {row !== null && (
          <button type="button" onClick={discard} className={cn(quietButtonClass, "text-destructive")}>
            Delete
          </button>
        )}
      </div>
    </form>
  );
}
