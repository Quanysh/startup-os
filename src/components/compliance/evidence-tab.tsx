"use client";

import { useMutation, useQuery } from "convex/react";
import { CheckIcon, CircleAlertIcon, CircleDashedIcon, PencilIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import {
  EVIDENCE_FRAMEWORKS,
  EVIDENCE_STATUSES,
  EVIDENCE_STATUS_LABELS,
  FRAMEWORK_LABELS,
  coverageByFramework,
  evidenceStatus,
  hasValidEvidence,
  type ControlRow,
  type EvidenceFramework,
  type EvidenceItemRow,
  type EvidenceStatus,
} from "@convex/lib/evidence";
import { MAX_CONTROL_ID_LENGTH } from "@convex/lib/evidence";
import { useCompany } from "@/components/company-provider";
import { TypedFreshness } from "@/components/freshness/freshness-indicator";
import { Masonry } from "@/components/masonry";
import {
  ActionsHeader,
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
} from "@/components/ui/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusChip, type StatusTone } from "@/components/ui/status-chip";
import { useViewer } from "@/hooks/use-viewer";
import { COMPANIES, categoryServes, categoryServesAny } from "@/lib/company";
import { dayLabel } from "@/lib/format";
import { lastChange } from "@/lib/source-freshness";
import {
  AddButton,
  ChangedBy,
  DateField,
  ExternalLink,
  RecordEditor,
  SelectField,
  TextField,
  linkProblem,
  rowButton,
} from "./record-ui";

// Valid evidence is never drawn in the good colour: a tally of records is not
// a verdict on the company.
const TONE: Record<EvidenceStatus, { tone: StatusTone; icon: typeof CheckIcon }> = {
  missing: { tone: "warning", icon: CircleDashedIcon },
  collected: { tone: "info", icon: CheckIcon },
  accepted: { tone: "neutral", icon: CheckIcon },
  expired: { tone: "danger", icon: CircleAlertIcon },
};

function ControlEditor({
  control,
  framework: start,
  frameworks,
  onClose,
}: {
  control: ControlRow | null;
  framework: EvidenceFramework;
  frameworks: readonly EvidenceFramework[];
  onClose: () => void;
}) {
  const upsert = useMutation(api.evidence.controlUpsert);
  const remove = useMutation(api.evidence.controlRemove);
  const [framework, setFramework] = useState<EvidenceFramework>(control?.framework ?? start);
  const [controlId, setControlId] = useState(control?.controlId ?? "");
  const [title, setTitle] = useState(control?.title ?? "");
  return (
    <RecordEditor
      title={control === null ? "Add a control" : "Edit control"}
      description="A control from a framework, and what it asks for."
      problem={() =>
        controlId.trim() === ""
          ? "A control needs an id, such as CC6.1."
          : controlId.trim().length > MAX_CONTROL_ID_LENGTH
            ? `A control id is at most ${MAX_CONTROL_ID_LENGTH} characters.`
            : title.trim() === ""
              ? "A control needs a title."
              : null
      }
      save={() => upsert({ ...(control === null ? null : { id: control.id }), framework, controlId, title })}
      remove={control === null ? undefined : () => remove({ id: control.id })}
      onClose={onClose}
    >
      {frameworks.length > 1 && (
        <SelectField label="Framework" value={framework} onChange={setFramework} options={frameworks.map((f) => ({ value: f, label: FRAMEWORK_LABELS[f] }))} />
      )}
      <TextField label="Control id" value={controlId} onChange={setControlId} placeholder="CC6.1" />
      <TextField label="Title" value={title} onChange={setTitle} />
      {control !== null && <p className="text-xs text-ink-3">Deleting a control deletes the evidence listed under it.</p>}
    </RecordEditor>
  );
}

function ItemEditor({
  control,
  item,
  onClose,
}: {
  control: ControlRow;
  item: EvidenceItemRow | null;
  onClose: () => void;
}) {
  const upsert = useMutation(api.evidence.evidenceItemUpsert);
  const remove = useMutation(api.evidence.evidenceItemRemove);
  const [title, setTitle] = useState(item?.title ?? "");
  const [link, setLink] = useState(item?.link ?? "");
  const [owner, setOwner] = useState(item?.owner ?? "");
  const [collectedOn, setCollectedOn] = useState(item?.collectedOn ?? "");
  const [validUntil, setValidUntil] = useState(item?.validUntil ?? "");
  const [status, setStatus] = useState<EvidenceStatus>(item?.status ?? "collected");
  return (
    <RecordEditor
      title={item === null ? `Add evidence for ${control.controlId}` : "Edit evidence"}
      description="What the evidence is, where it is, who keeps it, and how long it stays valid."
      problem={() =>
        title.trim() === ""
          ? "Evidence needs a title."
          : collectedOn !== "" && validUntil !== "" && validUntil < collectedOn
            ? "Evidence cannot be valid until before it was collected."
            : linkProblem(link)
      }
      save={() =>
        upsert({
          ...(item === null ? { controlId: control.id } : { id: item.id }),
          title,
          status,
          link: link.trim() === "" ? null : link,
          owner: owner.trim() === "" ? null : owner,
          collectedOn: collectedOn === "" ? null : collectedOn,
          validUntil: validUntil === "" ? null : validUntil,
        })
      }
      remove={item === null ? undefined : () => remove({ id: item.id })}
      onClose={onClose}
    >
      <TextField label="Title" value={title} onChange={setTitle} />
      <TextField label="Link" type="url" placeholder="https://" value={link} onChange={setLink} hint="A link only: no document, screenshot or secret is stored here." />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="Status" value={status} onChange={setStatus} options={EVIDENCE_STATUSES.map((s) => ({ value: s, label: EVIDENCE_STATUS_LABELS[s] }))} />
        <TextField label="Owner" value={owner} onChange={setOwner} />
        <DateField label="Collected" value={collectedOn} onChange={setCollectedOn} />
        <DateField label="Valid until" value={validUntil} onChange={setValidUntil} hint="After this day it reads as expired." />
      </div>
    </RecordEditor>
  );
}

type Editing =
  | { kind: "control"; id: Id<"complianceControls"> | null; framework: EvidenceFramework }
  | { kind: "item"; controlId: Id<"complianceControls">; id: Id<"evidenceItems"> | null };

export function EvidenceTab({ today, now }: { today: string; now: number }) {
  const all = useQuery(api.evidence.controls);
  const company = useCompany();
  const { companies } = useViewer();
  const [editing, setEditing] = useState<Editing | null>(null);
  if (all === undefined) return <Skeleton aria-busy className="h-64 w-full rounded-card" />;
  // HIPAA and SOC 2 are Startup's, ISO 27001 is Globex's: the server sends
  // each only to someone on its company.
  const frameworks = EVIDENCE_FRAMEWORKS.filter((f) => categoryServes(company, f) && categoryServesAny(companies, f));
  if (frameworks.length === 0) {
    return (
      <p className="text-sm text-ink-2">
        HIPAA and SOC 2 evidence is kept for {COMPANIES.us.name}, ISO 27001 evidence for {COMPANIES.kz.name}. Switch company to see it.
      </p>
    );
  }
  const coverage = coverageByFramework(all, today, frameworks);
  const control = editing === null ? null : (all.find((c) => c.id === (editing.kind === "control" ? editing.id : editing.controlId)) ?? null);

  return (
    <div className="space-y-6">
      <section aria-label="Evidence summary" className="rounded-card bg-panel p-5 shadow-soft sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base">Controls with valid evidence</h2>
          <TypedFreshness label="Evidence" at={lastChange(all)} />
        </div>
        <dl className="mt-3 grid gap-4 sm:grid-cols-2">
          {coverage.map((c) => (
            <div key={c.framework}>
              <dt className="text-xs text-ink-2">{FRAMEWORK_LABELS[c.framework]}</dt>
              <dd className="mt-1 text-2xl text-ink">
                {c.total === 0 ? "No controls listed" : `${c.withEvidence} of ${c.total}`}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 max-w-3xl text-sm text-ink-2">
          A control counts once it has evidence that is collected or accepted and not past its valid-until day. This
          tallies records on file. It does not say a control is met.
        </p>
      </section>

      {/* Two frameworks side by side (Startup's HIPAA and SOC 2); one alone (Globex's ISO 27001) takes the width. */}
      <Masonry minColumnWidth={520} maxColumns={frameworks.length > 1 ? 2 : 1}>
        {frameworks.map((framework) => {
          const controls = all.filter((c) => c.framework === framework);
          return (
            <section key={framework} aria-labelledby={`fw-${framework}`} className="rounded-card bg-panel p-5 shadow-soft sm:p-6">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <h2 id={`fw-${framework}`} className="text-base">
                    {FRAMEWORK_LABELS[framework]}
                  </h2>
                  <p className="mt-0.5 text-xs text-ink-2">
                    {controls.length === 0
                      ? "Nothing listed."
                      : `${controls.filter((c) => hasValidEvidence(c, today)).length} of ${controls.length} with valid evidence`}
                  </p>
                </div>
                <AddButton label="Add a control" onClick={() => setEditing({ kind: "control", id: null, framework })} />
              </div>
              {controls.length > 0 && (
                <DataTable caption={`${FRAMEWORK_LABELS[framework]}: controls and evidence`} className="min-w-[34rem]" boxClassName="mt-3">
                  <DataHead>
                    <DataHeader pinned>Control</DataHeader>
                    <DataHeader>Evidence</DataHeader>
                    <ActionsHeader />
                  </DataHead>
                  <DataBody>
                    {controls.map((c) => (
                      <DataRow key={c.id} tone={c.items.length > 0 && !hasValidEvidence(c, today) ? "warning" : undefined}>
                        <DataRowHeader pinned className="sm:min-w-[11rem]">
                          {c.controlId}
                          <p className="mt-0.5 text-sm font-normal text-ink-2">{c.title}</p>
                        </DataRowHeader>
                        <DataCell className="min-w-[16rem] space-y-2">
                          {c.items.length === 0 && (
                            <StatusChip tone="warning" icon={CircleDashedIcon}>
                              No evidence yet
                            </StatusChip>
                          )}
                          {c.items.map((i) => {
                            const status = evidenceStatus(i, today);
                            const mark = TONE[status];
                            return (
                              <div key={i.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <StatusChip tone={mark.tone} icon={mark.icon}>
                                  {EVIDENCE_STATUS_LABELS[status]}
                                </StatusChip>
                                <span className="text-sm">{i.link === null ? i.title : <ExternalLink href={i.link}>{i.title}</ExternalLink>}</span>
                                <span className="text-xs text-ink-2">
                                  {i.validUntil !== null && `valid until ${dayLabel(i.validUntil, now)}`}
                                  {i.owner !== null && ` · ${i.owner}`}
                                </span>
                                <button
                                  type="button"
                                  aria-label={`Edit evidence ${i.title}`}
                                  onClick={() => setEditing({ kind: "item", controlId: c.id, id: i.id })}
                                  className="rounded-full p-1 text-ink-2 outline-none hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50"
                                >
                                  <PencilIcon aria-hidden className="size-3.5" />
                                </button>
                                <ChangedBy by={i.changedBy} />
                              </div>
                            );
                          })}
                        </DataCell>
                        <DataCell actions className="py-2.5 whitespace-normal">
                          <div className="flex flex-wrap justify-end gap-2">
                            <button
                              type="button"
                              aria-label={`Add evidence to ${c.controlId}`}
                              onClick={() => setEditing({ kind: "item", controlId: c.id, id: null })}
                              className={rowButton}
                            >
                              <PlusIcon aria-hidden className="size-3.5" />
                              Evidence
                            </button>
                            <button
                              type="button"
                              aria-label={`Edit control ${c.controlId}`}
                              onClick={() => setEditing({ kind: "control", id: c.id, framework })}
                              className={rowButton}
                            >
                              <PencilIcon aria-hidden className="size-3.5" />
                              Edit
                            </button>
                          </div>
                        </DataCell>
                      </DataRow>
                    ))}
                  </DataBody>
                </DataTable>
              )}
            </section>
          );
        })}
      </Masonry>

      {editing?.kind === "control" && (
        <ControlEditor control={control} framework={editing.framework} frameworks={frameworks} onClose={() => setEditing(null)} />
      )}
      {editing?.kind === "item" && control !== null && (
        <ItemEditor control={control} item={editing.id === null ? null : (control.items.find((i) => i.id === editing.id) ?? null)} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}
