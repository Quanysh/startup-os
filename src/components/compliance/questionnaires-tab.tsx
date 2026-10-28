"use client";

import { useMutation, useQuery } from "convex/react";
import { PencilIcon } from "lucide-react";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { MAX_NAME_LENGTH, MAX_NOTES_LENGTH } from "@convex/lib/limits";
import {
  QUESTIONNAIRE_STATUSES,
  QUESTIONNAIRE_STATUS_LABELS,
  questionnaireOpen,
  type QuestionnaireRow,
  type QuestionnaireStatus,
} from "@convex/lib/evidence";
import { useCompany } from "@/components/company-provider";
import { TypedFreshness } from "@/components/freshness/freshness-indicator";
import { Skeleton } from "@/components/ui/skeleton";
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
import { StatusChip, type StatusTone } from "@/components/ui/status-chip";
import { useViewer } from "@/hooks/use-viewer";
import { daysBetween } from "@convex/lib/attention/dates";
import { dayLabel } from "@/lib/format";
import { lastChange } from "@/lib/source-freshness";
import {
  AddButton,
  ChangedBy,
  DateField,
  ExternalLink,
  RecordEditor,
  SelectField,
  TextAreaField,
  TextField,
  companyName,
  linkProblem,
  rowButton,
} from "./record-ui";

const STATUS_TONE: Record<QuestionnaireStatus, StatusTone> = {
  todo: "neutral",
  in_progress: "info",
  sent: "info",
  accepted: "neutral",
};

/** A due day on an open questionnaire: overdue and this week are the two that ask for something. */
function dueTone(q: QuestionnaireRow, today: string, now: number): { tone: StatusTone; text: string } | null {
  if (q.dueOn === null) return null;
  if (!questionnaireOpen(q)) return { tone: "neutral", text: `Due ${dayLabel(q.dueOn, now)}` };
  const days = daysBetween(today, q.dueOn);
  if (days < 0) return { tone: "danger", text: `Overdue by ${-days} ${days === -1 ? "day" : "days"}` };
  if (days <= 7) return { tone: "warning", text: days === 0 ? "Due today" : days === 1 ? "Due tomorrow" : `Due in ${days} days` };
  return { tone: "neutral", text: `Due ${dayLabel(q.dueOn, now)}` };
}

function Editor({ row, onClose }: { row: QuestionnaireRow | null; onClose: () => void }) {
  const upsert = useMutation(api.evidence.questionnaireUpsert);
  const remove = useMutation(api.evidence.questionnaireRemove);
  const { companies } = useViewer();
  const company0 = useCompany();
  const [requester, setRequester] = useState(row?.requester ?? "");
  const [company, setCompany] = useState(row?.company ?? company0 ?? companies[0] ?? "us");
  const [receivedOn, setReceivedOn] = useState(row?.receivedOn ?? "");
  const [dueOn, setDueOn] = useState(row?.dueOn ?? "");
  const [status, setStatus] = useState<QuestionnaireStatus>(row?.status ?? "todo");
  const [owner, setOwner] = useState(row?.owner ?? "");
  const [link, setLink] = useState(row?.link ?? "");
  const [notes, setNotes] = useState(row?.notes ?? "");

  return (
    <RecordEditor
      title={row === null ? "Add a questionnaire" : "Edit questionnaire"}
      description="Who asked, when it is due, who is answering, and where the document is."
      problem={() =>
        requester.trim() === ""
          ? "A questionnaire needs a requester."
          : notes.trim().length > MAX_NOTES_LENGTH
            ? `That note is too long (${MAX_NOTES_LENGTH} characters at most).`
            : linkProblem(link)
      }
      save={() =>
        upsert({
          ...(row === null ? null : { id: row.id }),
          requester,
          company,
          status,
          receivedOn: receivedOn === "" ? null : receivedOn,
          dueOn: dueOn === "" ? null : dueOn,
          owner: owner.trim() === "" ? null : owner,
          link: link.trim() === "" ? null : link,
          notes: notes.trim() === "" ? null : notes,
        })
      }
      remove={row === null ? undefined : () => remove({ id: row.id })}
      onClose={onClose}
    >
      <TextField label="Requester" value={requester} onChange={setRequester} hint="The company that sent it." />
      <div className="grid gap-4 sm:grid-cols-2">
        {companies.length > 1 && (
          <SelectField
            label="Company"
            value={company}
            onChange={setCompany}
            options={companies.map((c) => ({ value: c, label: companyName(c) }))}
          />
        )}
        <SelectField
          label="Status"
          value={status}
          onChange={setStatus}
          options={QUESTIONNAIRE_STATUSES.map((s) => ({ value: s, label: QUESTIONNAIRE_STATUS_LABELS[s] }))}
        />
        <DateField label="Received" value={receivedOn} onChange={setReceivedOn} />
        <DateField label="Due" value={dueOn} onChange={setDueOn} />
      </div>
      <TextField label="Owner" value={owner} onChange={setOwner} hint={`A name, at most ${MAX_NAME_LENGTH} characters.`} />
      <TextField label="Document link" type="url" placeholder="https://" value={link} onChange={setLink} hint="A link only: the document itself is not stored here." />
      <TextAreaField label="Notes" value={notes} onChange={setNotes} />
    </RecordEditor>
  );
}

export function QuestionnairesTab({ today, now }: { today: string; now: number }) {
  const company = useCompany();
  const all = useQuery(api.evidence.questionnaires);
  const [editing, setEditing] = useState<Id<"securityQuestionnaires"> | "new" | null>(null);
  if (all === undefined) return <Skeleton aria-busy className="h-64 w-full rounded-card" />;
  const rows = all.filter((q) => company === null || q.company === company);
  const edited = editing === "new" || editing === null ? null : (rows.find((q) => q.id === editing) ?? null);
  const open = rows.filter(questionnaireOpen);
  const overdue = open.filter((q) => q.dueOn !== null && q.dueOn < today);
  const tiles: [string, string][] = [
    ["To do", String(rows.filter((q) => q.status === "todo").length)],
    ["In progress", String(rows.filter((q) => q.status === "in_progress").length)],
    ["Overdue", String(overdue.length)],
    ["Sent", String(rows.filter((q) => q.status === "sent").length)],
    ["Accepted", String(rows.filter((q) => q.status === "accepted").length)],
  ];

  return (
    <div className="space-y-6">
      <section aria-label="Questionnaire summary" className="rounded-card bg-panel p-5 shadow-soft sm:p-6">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {tiles.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-ink-2">{label}</dt>
              <dd className="mt-1 text-2xl text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="questionnaires-heading" className="rounded-card bg-panel p-5 shadow-soft sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 id="questionnaires-heading" className="text-base">
              Security questionnaires
            </h2>
            <p className="mt-0.5 text-xs text-ink-2">
              {rows.length === 0 ? "Nothing listed." : `${open.length} to answer, ${rows.length} in all.`}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <TypedFreshness label="Questionnaires" at={lastChange(rows)} />
            <AddButton label="Add a questionnaire" onClick={() => setEditing("new")} />
          </div>
        </div>
        {rows.length > 0 && (
          <DataTable caption="Security questionnaires" className="min-w-[44rem] md:min-w-[56rem]" boxClassName="mt-3">
            <DataHead>
              <DataHeader pinned>Requester</DataHeader>
              <DataHeader>Due</DataHeader>
              <DataHeader>Status</DataHeader>
              <DataHeader hideBelow="md">Owner</DataHeader>
              <DataHeader>Document</DataHeader>
              <ActionsHeader />
            </DataHead>
            <DataBody>
              {rows.map((q) => {
                const due = dueTone(q, today, now);
                return (
                  <DataRow key={q.id} tone={due?.tone === "danger" ? "danger" : undefined}>
                    <DataRowHeader pinned className="sm:min-w-[12rem]">
                      {q.requester}
                      <p className="mt-0.5 text-xs font-normal text-ink-2">
                        {companyName(q.company)}
                        {q.receivedOn !== null && ` · received ${dayLabel(q.receivedOn, now)}`}
                      </p>
                      {q.notes !== null && <p className="mt-1 hidden max-w-md text-sm font-normal text-ink-2 sm:block">{q.notes}</p>}
                    </DataRowHeader>
                    <DataCell className="min-w-[10rem]">
                      {due === null ? <Blank /> : <StatusChip tone={due.tone}>{due.text}</StatusChip>}
                    </DataCell>
                    <DataCell>
                      <StatusChip tone={STATUS_TONE[q.status]} variant="outline">
                        {QUESTIONNAIRE_STATUS_LABELS[q.status]}
                      </StatusChip>
                    </DataCell>
                    <DataCell hideBelow="md" className="text-ink-2">
                      {q.owner ?? <Blank />}
                    </DataCell>
                    <DataCell className="text-xs whitespace-nowrap">
                      {q.link === null ? <span className="text-ink-2">No link</span> : <ExternalLink href={q.link}>Document</ExternalLink>}
                      <ChangedBy by={q.changedBy} />
                    </DataCell>
                    <DataCell actions className="py-2.5 whitespace-normal">
                      <div className="flex justify-end">
                        <button type="button" aria-label={`Edit ${q.requester}`} onClick={() => setEditing(q.id)} className={rowButton}>
                          <PencilIcon aria-hidden className="size-3.5" />
                          Edit
                        </button>
                      </div>
                    </DataCell>
                  </DataRow>
                );
              })}
            </DataBody>
          </DataTable>
        )}
      </section>

      {editing === "new" && <Editor row={null} onClose={() => setEditing(null)} />}
      {edited !== null && <Editor row={edited} onClose={() => setEditing(null)} />}
    </div>
  );
}
