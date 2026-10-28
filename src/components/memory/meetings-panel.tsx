"use client";

import { useConvex, useQuery } from "convex/react";
import { PlusIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { MEETING_KIND_LABELS } from "@convex/lib/memory";
import { Panel, fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import { KindTag } from "@/components/ui/status-chip";
import { useViewer } from "@/hooks/use-viewer";
import { COMPANIES, type CompanyId } from "@/lib/company";
import { dayLabel } from "@/lib/format";
import { messageOf } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { MeetingDetail } from "./meeting-detail";
import { MeetingEditor, emptyMeeting, type MeetingDraft } from "./meeting-editor";

export type MeetingRow = {
  id: Id<"meetingNotes">;
  company: CompanyId;
  kind: keyof typeof MEETING_KIND_LABELS;
  heldOn: string;
  title: string;
  attendeeCount: number;
  actionItems: number;
  onBoard: number;
};

/**
 * The owner's own Fireflies meetings, offered as a start for new notes: a
 * title and a date to pick, then the summary and action items in a draft.
 * Mounted for the owner alone (`personal`): the queries are `ownerQuery`, and
 * a teammate with Memory is never offered them.
 */
function FirefliesImport({
  company,
  onDraft,
  importId,
}: {
  company: CompanyId;
  onDraft: (draft: MeetingDraft) => void;
  /** A meeting asked for by the address (Today's "Add notes in Memory"): drafted once, on arrival. */
  importId: string | null;
}) {
  const offered = useQuery(api.workTools.importableMeetings, {});
  const convex = useConvex();
  const [picked, setPicked] = useState("");
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const asked = useRef(false);

  const draftFrom = async (meetingId: string) => {
    setError(null);
    try {
      const found = await convex.query(api.workTools.meetingToImport, { meetingId });
      onDraft({
        ...emptyMeeting(company, found.heldOn),
        title: found.title,
        notes: found.notes,
        actionItems: found.actionItems.join("\n"),
        firefliesId: meetingId,
      });
    } catch (failure) {
      setError(messageOf(failure, "That meeting could not be read. Try again."));
    }
  };

  useEffect(() => {
    if (importId === null || asked.current) return;
    asked.current = true;
    void draftFrom(importId);
    // Once, for the address it arrived with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importId]);

  if (offered === undefined || offered.length === 0) {
    return error === null ? null : (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  }
  const take = async () => {
    if (picked === "") return;
    await draftFrom(picked);
  };
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1 sm:max-w-sm">
        <label htmlFor={id} className="text-xs font-medium text-ink-2">
          Start from one of your Fireflies meetings
        </label>
        <select id={id} value={picked} onChange={(e) => setPicked(e.target.value)} className={cn(fieldClass, "mt-1 h-9")}>
          <option value="">Choose a meeting</option>
          {offered.map((meeting) => (
            <option key={meeting.meetingId} value={meeting.meetingId}>
              {new Date(meeting.heldAt).toISOString().slice(0, 10)}: {meeting.title}
            </option>
          ))}
        </select>
      </div>
      <button type="button" onClick={take} aria-disabled={picked === ""} className={cn(quietButtonClass, "h-9 bg-surface text-ink aria-disabled:opacity-60")}>
        Add notes from this meeting
      </button>
      {error !== null && (
        <p role="alert" className="w-full text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Meetings by date, newest first; one opened to read or edit; a new one, typed or from Fireflies. */
export function MeetingsPanel({
  rows,
  now,
  today,
  company,
  companies,
  opened,
  setOpened,
  importId = null,
}: {
  rows: readonly MeetingRow[];
  now: number;
  today: string;
  company: CompanyId;
  companies: readonly CompanyId[];
  opened: Id<"meetingNotes"> | null;
  setOpened: (id: Id<"meetingNotes"> | null) => void;
  importId?: string | null;
}) {
  const { isOwner, can } = useViewer();
  const [draft, setDraft] = useState<MeetingDraft | null>(null);
  // The address's import is drafted once: closing that draft does not start it again.
  const [pendingImport, setPendingImport] = useState(importId);

  return (
    <div className="space-y-4">
      {draft !== null && (
        <Panel aria-label="New meeting notes">
          <h2 className="mb-4 text-lg">New meeting notes</h2>
          <MeetingEditor
            id={null}
            initial={draft}
            companies={companies}
            onDone={(saved) => {
              setDraft(null);
              if (saved !== null) setOpened(saved);
            }}
          />
        </Panel>
      )}
      {opened !== null && draft === null && (
        <Panel>
          <MeetingDetail key={opened} id={opened} now={now} companies={companies} onClose={() => setOpened(null)} />
        </Panel>
      )}
      <Panel className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg">Meetings</h2>
          <button type="button" onClick={() => setDraft(emptyMeeting(company, today))} className={primaryButtonClass}>
            <PlusIcon aria-hidden className="size-4" />
            New meeting notes
          </button>
        </div>
        {isOwner && can("personal") && draft === null && (
          <FirefliesImport
            company={company}
            importId={pendingImport}
            onDraft={(next) => {
              setPendingImport(null);
              setDraft(next);
            }}
          />
        )}
        {rows.length === 0 ? (
          <p className="text-sm text-ink-2">No meeting notes yet. Add the next board, investor or leadership meeting here.</p>
        ) : (
          <ol className="divide-y divide-line">
            {rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(null);
                    setOpened(row.id);
                  }}
                  aria-current={opened === row.id ? "true" : undefined}
                  className="grid w-full grid-cols-[5.5rem_1fr] gap-3 rounded-inner px-2 py-3 text-left outline-none hover:bg-surface focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=true]:bg-surface"
                >
                  <span className="text-sm whitespace-nowrap text-ink-2">{dayLabel(row.heldOn, now)}</span>
                  <span className="min-w-0">
                    <span className="block font-medium text-ink [overflow-wrap:anywhere]">{row.title}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-2">
                      <KindTag tone="violet">{MEETING_KIND_LABELS[row.kind]}</KindTag>
                      {companies.length > 1 && <KindTag tone="slate">{COMPANIES[row.company].name}</KindTag>}
                      {row.actionItems > 0 && (
                        <span>
                          {row.onBoard} of {row.actionItems} action {row.actionItems === 1 ? "item" : "items"} on the board
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </div>
  );
}
