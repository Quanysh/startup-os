"use client";

import { useMutation, useQuery } from "convex/react";
import { useId, useState, type ReactNode } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { MAX_TITLE_LENGTH } from "@convex/lib/limits";
import { MAX_MEETING_NOTES, MEETING_KINDS, MEETING_KIND_LABELS, type MeetingKind } from "@convex/lib/memory";
import { fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import { COMPANIES, type CompanyId } from "@/lib/company";
import { messageOf } from "@/lib/errors";
import { cn } from "@/lib/utils";

/** A meeting's notes as a form holds them: one line per outside person and per action item. */
export type MeetingDraft = {
  company: CompanyId;
  kind: MeetingKind;
  heldOn: string;
  title: string;
  notes: string;
  attendees: string[];
  outsideAttendees: string;
  actionItems: string;
  /** The owner's Fireflies meeting a new draft was started from: remembered when it is saved. */
  firefliesId?: string;
};

export const emptyMeeting = (company: CompanyId, today: string): MeetingDraft => ({
  company,
  kind: "leadership",
  heldOn: today,
  title: "",
  notes: "",
  attendees: [],
  outsideAttendees: "",
  actionItems: "",
});

const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter((line) => line !== "");

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

/**
 * New meeting notes, or a change to some. Outside people are names only: the
 * server refuses an address there. A draft from Fireflies arrives as
 * `initial` and is only kept when this form is saved.
 */
export function MeetingEditor({
  id,
  initial,
  companies,
  onDone,
}: {
  id: Id<"meetingNotes"> | null;
  initial: MeetingDraft;
  companies: readonly CompanyId[];
  onDone: (saved: Id<"meetingNotes"> | null) => void;
}) {
  const [draft, setDraft] = useState<MeetingDraft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = useMutation(api.meetingNotes.create);
  const update = useMutation(api.meetingNotes.update);
  const people = useQuery(api.decisions.people, { company: draft.company });
  const set = (patch: Partial<MeetingDraft>) => setDraft((was) => ({ ...was, ...patch }));
  const input = cn(fieldClass, "h-9");

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const fields = {
      company: draft.company,
      kind: draft.kind,
      heldOn: draft.heldOn,
      title: draft.title,
      notes: draft.notes,
      attendees: draft.attendees,
      outsideAttendees: lines(draft.outsideAttendees),
      actionItems: lines(draft.actionItems),
    };
    try {
      if (id === null) {
        onDone(
          await create(draft.firefliesId === undefined ? fields : { ...fields, firefliesId: draft.firefliesId }),
        );
      }
      else {
        await update({ id, ...fields });
        onDone(id);
      }
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      aria-label={id === null ? "New meeting notes" : "Edit the meeting notes"}
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {companies.length > 1 && id === null && (
        <Field label="Company">
          {(fieldId) => (
            <select id={fieldId} value={draft.company} onChange={(e) => set({ company: e.target.value as CompanyId, attendees: [] })} className={input}>
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
        {(fieldId) => <input id={fieldId} required value={draft.title} maxLength={MAX_TITLE_LENGTH} onChange={(e) => set({ title: e.target.value })} className={input} />}
      </Field>
      <Field label="Kind">
        {(fieldId) => (
          <select id={fieldId} value={draft.kind} onChange={(e) => set({ kind: e.target.value as MeetingKind })} className={input}>
            {MEETING_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {MEETING_KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Held on">
        {(fieldId) => <input id={fieldId} type="date" required value={draft.heldOn} onChange={(e) => set({ heldOn: e.target.value })} className={input} />}
      </Field>
      <fieldset className="min-w-0 sm:col-span-2">
        <legend className="text-xs font-medium text-ink-2">Teammates there</legend>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {(people ?? []).map((person) => (
            <label key={person.email} className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={draft.attendees.includes(person.email)}
                onChange={(e) =>
                  set({
                    attendees: e.target.checked
                      ? [...draft.attendees, person.email]
                      : draft.attendees.filter((email) => email !== person.email),
                  })
                }
              />
              {person.name ?? person.email}
            </label>
          ))}
        </div>
      </fieldset>
      <Field label="People from outside, one name a line (no email addresses)">
        {(fieldId) => <textarea id={fieldId} rows={3} value={draft.outsideAttendees} onChange={(e) => set({ outsideAttendees: e.target.value })} className={cn(fieldClass, "py-2")} />}
      </Field>
      <Field label="Action items, one a line">
        {(fieldId) => <textarea id={fieldId} rows={3} value={draft.actionItems} onChange={(e) => set({ actionItems: e.target.value })} className={cn(fieldClass, "py-2")} />}
      </Field>
      <Field label="Notes" wide>
        {(fieldId) => <textarea id={fieldId} rows={10} value={draft.notes} maxLength={MAX_MEETING_NOTES} onChange={(e) => set({ notes: e.target.value })} className={cn(fieldClass, "py-2")} />}
      </Field>
      {error !== null && (
        <p role="alert" className="text-sm text-destructive sm:col-span-2">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <button type="submit" aria-disabled={busy} className={cn(primaryButtonClass, "aria-disabled:opacity-60")}>
          {id === null ? "Save the notes" : "Save changes"}
        </button>
        <button type="button" onClick={() => onDone(null)} className={quietButtonClass}>
          Cancel
        </button>
      </div>
    </form>
  );
}
