"use client";

import { CalendarClockIcon, PlusIcon } from "lucide-react";
import { useId, useState } from "react";
import { DECISION_STATUSES, DECISION_STATUS_LABELS, type DecisionStatus } from "@convex/lib/memory";
import { Panel, fieldClass, primaryButtonClass } from "@/components/panel";
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
  rowActionClass,
} from "@/components/ui/data-table";
import { KindTag, StatusChip, type StatusTone } from "@/components/ui/status-chip";
import { COMPANIES, type CompanyId } from "@/lib/company";
import { dayLabel } from "@/lib/format";
import { dueForRevisit, filterDecisions, type DecisionRow, type View } from "@/lib/memory/view";
import { cn } from "@/lib/utils";
import { DecisionEditor } from "./decision-editor";

/** A decision's state, as a chip: its tone is the meaning, with words and an icon. */
export const STATUS_TONE: Record<DecisionStatus, StatusTone> = {
  proposed: "info",
  decided: "success",
  revisit: "warning",
  reversed: "neutral",
};

/** Who owns a decision, as the viewer may be told. */
const ownerName = (owner: DecisionRow["owner"]) =>
  owner === null ? null : (owner.name ?? owner.email ?? "A teammate");

function Filters({ rows, view, setView }: { rows: readonly DecisionRow[]; view: View; setView: (next: View) => void }) {
  const ids = { q: useId(), status: useId(), owner: useId(), tag: useId(), from: useId() };
  const owners = new Map<string, string>();
  for (const row of rows) if (row.owner?.email) owners.set(row.owner.email, ownerName(row.owner)!);
  const tags = [...new Set(rows.flatMap((row) => row.tags))].sort();
  const control = cn(fieldClass, "h-9");
  const label = "text-xs font-medium text-ink-2";
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <div className="sm:col-span-2 lg:col-span-1">
        <label htmlFor={ids.q} className={label}>Search</label>
        <input id={ids.q} type="search" value={view.q} onChange={(e) => setView({ ...view, q: e.target.value })} className={cn(control, "mt-1")} />
      </div>
      <div>
        <label htmlFor={ids.status} className={label}>Status</label>
        <select id={ids.status} value={view.status ?? ""} onChange={(e) => setView({ ...view, status: (e.target.value || null) as DecisionStatus | null })} className={cn(control, "mt-1")}>
          <option value="">Any</option>
          {DECISION_STATUSES.map((status) => (
            <option key={status} value={status}>{DECISION_STATUS_LABELS[status]}</option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={ids.owner} className={label}>Owner</label>
        <select id={ids.owner} value={view.owner ?? ""} onChange={(e) => setView({ ...view, owner: e.target.value || null })} className={cn(control, "mt-1")}>
          <option value="">Anyone</option>
          {[...owners].map(([email, name]) => (
            <option key={email} value={email}>{name}</option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={ids.tag} className={label}>Tag</label>
        <select id={ids.tag} value={view.tag ?? ""} onChange={(e) => setView({ ...view, tag: e.target.value || null })} className={cn(control, "mt-1")}>
          <option value="">Any</option>
          {tags.map((tag) => (
            <option key={tag} value={tag}>{tag}</option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={ids.from} className={label}>Decided since</label>
        <input id={ids.from} type="date" value={view.from ?? ""} onChange={(e) => setView({ ...view, from: e.target.value || null })} className={cn(control, "mt-1")} />
      </div>
    </div>
  );
}

/** The decisions of the companies in view: a banner for what is due, filters, and the table. */
export function DecisionsPanel({
  rows,
  view,
  setView,
  today,
  now,
  company,
  companies,
  meetings,
  opened,
  setOpened,
}: {
  rows: readonly DecisionRow[];
  view: View;
  setView: (next: View) => void;
  today: string;
  now: number;
  company: CompanyId;
  companies: readonly CompanyId[];
  meetings: readonly { id: string; title: string; heldOn: string; company: CompanyId }[];
  /** The decision open in the editor, "new" for a new one, or null. */
  opened: string | null;
  setOpened: (id: string | null) => void;
}) {
  const [showDue, setShowDue] = useState(false);
  const due = dueForRevisit(rows, today);
  const dueIds = new Set(due.map((row) => row.id));
  const shown = showDue ? due : filterDecisions(rows, view);
  const editing = opened === null ? undefined : opened === "new" ? null : rows.find((row) => row.id === opened);

  return (
    <div className="space-y-4">
      {due.length > 0 && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-card bg-warning-soft px-5 py-3 text-sm text-warning-ink">
          <span className="flex items-center gap-2">
            <CalendarClockIcon aria-hidden className="size-4 shrink-0" />
            {due.length === 1 ? "1 decision is due for a revisit." : `${due.length} decisions are due for a revisit.`}
          </span>
          <button type="button" onClick={() => setShowDue(!showDue)} className="rounded-sm font-medium underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            {showDue ? "Show all decisions" : "Show them"}
          </button>
        </div>
      )}

      {editing !== undefined && (
        <Panel aria-label={editing === null ? "Record a decision" : "Edit the decision"}>
          <h2 className="mb-4 text-lg">{editing === null ? "Record a decision" : editing.title}</h2>
          <DecisionEditor
            key={opened ?? "none"}
            row={editing}
            company={company}
            companies={companies}
            today={today}
            meetings={meetings}
            onDone={() => setOpened(null)}
          />
        </Panel>
      )}

      <Panel className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg">Decisions</h2>
          <button type="button" onClick={() => setOpened("new")} className={primaryButtonClass}>
            <PlusIcon aria-hidden className="size-4" />
            Record a decision
          </button>
        </div>
        {!showDue && <Filters rows={rows} view={view} setView={setView} />}
        {rows.length === 0 ? (
          <p className="text-sm text-ink-2">No decision is recorded yet. Record the next one when it is made, with why and who owns it.</p>
        ) : shown.length === 0 ? (
          <p className="text-sm text-ink-2">No decision matches these filters.</p>
        ) : (
          <DataTable caption="Decisions, newest first" className="min-w-[44rem]">
            <DataHead>
              <DataHeader pinned>Decision</DataHeader>
              <DataHeader>Status</DataHeader>
              <DataHeader hideBelow="md">Owner</DataHeader>
              <DataHeader>Decided</DataHeader>
              <DataHeader hideBelow="sm">Revisit</DataHeader>
              <ActionsHeader />
            </DataHead>
            <DataBody>
              {shown.map((row) => (
                <DataRow key={row.id} tone={dueIds.has(row.id) ? "warning" : undefined}>
                  <DataRowHeader pinned className="max-w-[28rem]">
                    <span className="block [overflow-wrap:anywhere]">{row.title}</span>
                    <span className="mt-0.5 line-clamp-2 block text-xs font-normal whitespace-pre-line text-ink-2 [overflow-wrap:anywhere]">
                      {row.decision}
                    </span>
                    {(row.tags.length > 0 || companies.length > 1) && (
                      <span className="mt-1 flex flex-wrap gap-1">
                        {companies.length > 1 && <KindTag tone="slate">{COMPANIES[row.company].name}</KindTag>}
                        {row.tags.map((tag) => (
                          <KindTag key={tag} tone="teal">{tag}</KindTag>
                        ))}
                      </span>
                    )}
                  </DataRowHeader>
                  <DataCell>
                    <StatusChip tone={STATUS_TONE[row.status]}>{DECISION_STATUS_LABELS[row.status]}</StatusChip>
                  </DataCell>
                  <DataCell hideBelow="md">{ownerName(row.owner) ?? <Blank>Nobody</Blank>}</DataCell>
                  <DataCell className="whitespace-nowrap">{dayLabel(row.decidedOn, now)}</DataCell>
                  <DataCell hideBelow="sm" className="whitespace-nowrap">
                    {row.revisitOn === null ? (
                      <Blank />
                    ) : dueIds.has(row.id) ? (
                      <StatusChip tone="warning" icon={CalendarClockIcon}>Due {dayLabel(row.revisitOn, now)}</StatusChip>
                    ) : (
                      dayLabel(row.revisitOn, now)
                    )}
                  </DataCell>
                  <DataCell actions>
                    <button type="button" onClick={() => setOpened(row.id)} className={rowActionClass} aria-label={`Open ${row.title}`}>
                      Open
                    </button>
                  </DataCell>
                </DataRow>
              ))}
            </DataBody>
          </DataTable>
        )}
      </Panel>
    </div>
  );
}
