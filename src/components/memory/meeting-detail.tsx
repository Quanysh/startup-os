"use client";

import { useMutation, useQuery } from "convex/react";
import { CheckIcon, SquareKanbanIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { DECISION_STATUS_LABELS, MEETING_KIND_LABELS } from "@convex/lib/memory";
import { primaryButtonClass, quietButtonClass } from "@/components/panel";
import { KindTag, StatusChip } from "@/components/ui/status-chip";
import { Skeleton } from "@/components/ui/skeleton";
import { useViewer } from "@/hooks/use-viewer";
import { dayLabel } from "@/lib/format";
import { DuplicateWarning } from "@/components/tasks/duplicate-warning";
import { messageOf } from "@/lib/errors";
import { duplicateWarning, type NearCard } from "@/lib/tasks/duplicates";
import { cn } from "@/lib/utils";
import { STATUS_TONE } from "./decisions-panel";
import { MeetingEditor, type MeetingDraft } from "./meeting-editor";

function ActionItem({
  meeting,
  index,
  text,
  taskId,
  canBoard,
}: {
  meeting: Id<"meetingNotes">;
  index: number;
  text: string;
  taskId: string | null;
  canBoard: boolean;
}) {
  const add = useMutation(api.meetingNotes.addActionToBoard);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The open cards it may repeat, as the server named them, until the person decides.
  const [near, setNear] = useState<NearCard[] | null>(null);
  const run = async (duplicates: "warn" | "confirmed") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNear(null);
    try {
      await add({ id: meeting, index, duplicates });
    } catch (failure) {
      const cards = duplicateWarning(failure);
      if (cards !== null) setNear(cards);
      else setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-2 last:border-b-0">
      <span className="min-w-0 text-sm text-ink [overflow-wrap:anywhere]">{text}</span>
      {taskId !== null ? (
        canBoard ? (
          <Link href={`/board?task=${taskId}`} className="inline-flex items-center gap-1 text-sm font-medium text-brand underline-offset-2 hover:underline">
            <CheckIcon aria-hidden className="size-4" />
            On the board
          </Link>
        ) : (
          <span className="inline-flex items-center gap-1 text-sm text-ink-2">
            <CheckIcon aria-hidden className="size-4" />
            On the board
          </span>
        )
      ) : (
        canBoard && (
          <button type="button" aria-disabled={busy} onClick={() => void run("warn")} className={cn(quietButtonClass, "h-8 bg-surface text-ink aria-disabled:opacity-60")}>
            <SquareKanbanIcon aria-hidden className="size-4" />
            Add to board
          </button>
        )
      )}
      {near !== null && (
        <DuplicateWarning
          cards={near}
          busy={busy}
          className="w-full space-y-1.5 text-sm text-ink-2"
          onAdd={() => void run("confirmed")}
          onCancel={() => setNear(null)}
        />
      )}
      {error !== null && (
        <p role="alert" className="w-full text-sm text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

/** One meeting, read whole: who was there, the notes as text, its action items and decisions. */
export function MeetingDetail({
  id,
  now,
  companies,
  onClose,
}: {
  id: Id<"meetingNotes">;
  now: number;
  companies: readonly ("us" | "kz")[];
  onClose: () => void;
}) {
  const meeting = useQuery(api.meetingNotes.get, { id });
  const remove = useMutation(api.meetingNotes.remove);
  const { can } = useViewer();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (meeting === undefined) return <Skeleton className="h-40 w-full rounded-card" />;

  if (editing) {
    const initial: MeetingDraft = {
      company: meeting.company,
      kind: meeting.kind,
      heldOn: meeting.heldOn,
      title: meeting.title,
      notes: meeting.notes,
      attendees: meeting.attendees.flatMap((person) => (person.email === null ? [] : [person.email])),
      outsideAttendees: meeting.outsideAttendees.join("\n"),
      actionItems: meeting.actionItems.map((item) => item.text).join("\n"),
    };
    return <MeetingEditor id={id} initial={initial} companies={companies} onDone={() => setEditing(false)} />;
  }

  const discard = async () => {
    if (!window.confirm("Delete these meeting notes? Decisions made in it stay. This cannot be undone.")) return;
    try {
      await remove({ id });
      onClose();
    } catch (failure) {
      setError(messageOf(failure));
    }
  };

  const people = [
    ...meeting.attendees.map((person) => person.name ?? person.email ?? "A teammate"),
    ...meeting.outsideAttendees,
  ];

  return (
    <article className="space-y-5" aria-label={meeting.title}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl [overflow-wrap:anywhere]">{meeting.title}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-2">
            <KindTag tone="violet">{MEETING_KIND_LABELS[meeting.kind]}</KindTag>
            {dayLabel(meeting.heldOn, now)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setEditing(true)} className={primaryButtonClass}>
            Edit
          </button>
          <button type="button" onClick={onClose} className={quietButtonClass}>
            Close
          </button>
          <button type="button" onClick={discard} className={cn(quietButtonClass, "text-destructive")}>
            Delete
          </button>
        </div>
      </header>
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <section>
        <h3 className="text-sm font-medium text-ink">Who was there</h3>
        <p className="mt-1 text-sm text-ink-2 [overflow-wrap:anywhere]">
          {people.length === 0 ? "Nobody was noted." : people.join(", ")}
        </p>
      </section>
      <section>
        <h3 className="text-sm font-medium text-ink">Notes</h3>
        {meeting.notes === "" ? (
          <p className="mt-1 text-sm text-ink-2">No notes yet.</p>
        ) : (
          <p className="mt-1 max-w-prose text-sm leading-relaxed whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">
            {meeting.notes}
          </p>
        )}
      </section>
      <section>
        <h3 className="text-sm font-medium text-ink">Action items</h3>
        {meeting.actionItems.length === 0 ? (
          <p className="mt-1 text-sm text-ink-2">None.</p>
        ) : (
          <ul className="mt-1">
            {meeting.actionItems.map((item, index) => (
              <ActionItem
                key={`${index}-${item.text}`}
                meeting={id}
                index={index}
                text={item.text}
                taskId={item.taskId}
                canBoard={can("board")}
              />
            ))}
          </ul>
        )}
      </section>
      {meeting.decisions.length > 0 && (
        <section>
          <h3 className="text-sm font-medium text-ink">Decisions made</h3>
          <ul className="mt-1 space-y-1">
            {meeting.decisions.map((decision) => (
              <li key={decision.id} className="flex flex-wrap items-center gap-2 text-sm">
                <Link href={`/memory?decision=${decision.id}`} className="text-brand underline-offset-2 hover:underline [overflow-wrap:anywhere]">
                  {decision.title}
                </Link>
                <StatusChip tone={STATUS_TONE[decision.status]}>{DECISION_STATUS_LABELS[decision.status]}</StatusChip>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
