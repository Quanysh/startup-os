"use client";

import { useMutation, useQuery } from "convex/react";
import { CalendarClockIcon, CircleAlertIcon, PencilIcon } from "lucide-react";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import {
  AGREEMENT_STATUSES,
  AGREEMENT_STATUS_LABELS,
  AGREEMENT_TYPES,
  AGREEMENT_TYPE_LABELS,
  AGREEMENT_WINDOW_DAYS,
  agreementState,
  agreementText,
  type AgreementRow,
  type AgreementStatus,
  type AgreementType,
} from "@convex/lib/evidence";
import { MAX_NOTES_LENGTH } from "@convex/lib/limits";
import { useCompany } from "@/components/company-provider";
import { TypedFreshness } from "@/components/freshness/freshness-indicator";
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
import { Skeleton } from "@/components/ui/skeleton";
import { StatusChip, type StatusTone } from "@/components/ui/status-chip";
import { useViewer } from "@/hooks/use-viewer";
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

function Editor({ row, onClose }: { row: AgreementRow | null; onClose: () => void }) {
  const upsert = useMutation(api.evidence.agreementUpsert);
  const remove = useMutation(api.evidence.agreementRemove);
  const { companies } = useViewer();
  const company0 = useCompany();
  const [vendor, setVendor] = useState(row?.vendor ?? "");
  const [type, setType] = useState<AgreementType>(row?.type ?? "baa");
  const [company, setCompany] = useState(row?.company ?? company0 ?? companies[0] ?? "us");
  const [status, setStatus] = useState<AgreementStatus>(row?.status ?? "draft");
  const [signedOn, setSignedOn] = useState(row?.signedOn ?? "");
  const [expiresOn, setExpiresOn] = useState(row?.expiresOn ?? "");
  const [link, setLink] = useState(row?.link ?? "");
  const [notes, setNotes] = useState(row?.notes ?? "");

  return (
    <RecordEditor
      title={row === null ? "Add an agreement" : "Edit agreement"}
      description="The vendor, the kind of agreement, which company signed it, when it was signed and when it ends."
      problem={() =>
        vendor.trim() === ""
          ? "An agreement needs a vendor."
          : signedOn !== "" && expiresOn !== "" && expiresOn < signedOn
            ? "An agreement cannot expire before it was signed."
            : notes.trim().length > MAX_NOTES_LENGTH
              ? `That note is too long (${MAX_NOTES_LENGTH} characters at most).`
              : linkProblem(link)
      }
      save={() =>
        upsert({
          ...(row === null ? null : { id: row.id }),
          vendor,
          type,
          company,
          status,
          signedOn: signedOn === "" ? null : signedOn,
          expiresOn: expiresOn === "" ? null : expiresOn,
          link: link.trim() === "" ? null : link,
          notes: notes.trim() === "" ? null : notes,
        })
      }
      remove={row === null ? undefined : () => remove({ id: row.id })}
      onClose={onClose}
    >
      <TextField label="Vendor" value={vendor} onChange={setVendor} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="Type" value={type} onChange={setType} options={AGREEMENT_TYPES.map((t) => ({ value: t, label: AGREEMENT_TYPE_LABELS[t] }))} />
        <SelectField
          label="Status"
          value={status}
          onChange={setStatus}
          options={AGREEMENT_STATUSES.map((s) => ({ value: s, label: AGREEMENT_STATUS_LABELS[s] }))}
        />
        {companies.length > 1 && (
          <SelectField label="Company" value={company} onChange={setCompany} options={companies.map((c) => ({ value: c, label: companyName(c) }))} />
        )}
        <DateField label="Signed" value={signedOn} onChange={setSignedOn} />
        <DateField label="Renews or expires" value={expiresOn} onChange={setExpiresOn} hint={`An active agreement ending within ${AGREEMENT_WINDOW_DAYS} days is listed on Today.`} />
      </div>
      <TextField label="Document link" type="url" placeholder="https://" value={link} onChange={setLink} hint="A link only: the agreement itself is not stored here." />
      <TextAreaField label="Notes" value={notes} onChange={setNotes} />
    </RecordEditor>
  );
}

const TONE: Record<string, { tone: StatusTone; icon?: typeof CalendarClockIcon }> = {
  expired: { tone: "danger", icon: CircleAlertIcon },
  expiring: { tone: "warning", icon: CalendarClockIcon },
};

export function AgreementsTab({ today, now }: { today: string; now: number }) {
  const company = useCompany();
  const all = useQuery(api.evidence.agreements);
  const [editing, setEditing] = useState<Id<"vendorAgreements"> | "new" | null>(null);
  if (all === undefined) return <Skeleton aria-busy className="h-64 w-full rounded-card" />;
  const rows = all.filter((a) => company === null || a.company === company);
  const edited = editing === "new" || editing === null ? null : (rows.find((a) => a.id === editing) ?? null);
  const states = rows.map((a) => agreementState(a, today).state);
  const count = (s: string) => states.filter((x) => x === s).length;
  const tiles: [string, string][] = [
    ["Past the expiry date", String(count("expired"))],
    [`Ending in ${AGREEMENT_WINDOW_DAYS} days`, String(count("expiring"))],
    ["Active, no expiry date", String(count("no_date"))],
    ["Active, later", String(count("current"))],
  ];

  return (
    <div className="space-y-6">
      <section aria-label="Agreement summary" className="rounded-card bg-panel p-5 shadow-soft sm:p-6">
        <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {tiles.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-ink-2">{label}</dt>
              <dd className="mt-1 text-2xl text-ink">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 max-w-3xl text-sm text-ink-2">
          Only active agreements are watched. One ending within {AGREEMENT_WINDOW_DAYS} days, or already past its end,
          is listed on Today under Needs you.
        </p>
      </section>

      <section aria-labelledby="agreements-heading" className="rounded-card bg-panel p-5 shadow-soft sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 id="agreements-heading" className="text-base">
              Vendor agreements
            </h2>
            <p className="mt-0.5 text-xs text-ink-2">{rows.length === 0 ? "Nothing listed." : `${rows.length} listed.`}</p>
          </div>
          <div className="flex items-center gap-3">
            <TypedFreshness label="Agreements" at={lastChange(rows)} />
            <AddButton label="Add an agreement" onClick={() => setEditing("new")} />
          </div>
        </div>
        {rows.length > 0 && (
          <DataTable caption="Vendor agreements" className="min-w-[44rem] md:min-w-[56rem]" boxClassName="mt-3">
            <DataHead>
              <DataHeader pinned>Vendor</DataHeader>
              <DataHeader hideBelow="md">Type</DataHeader>
              <DataHeader>Renews or expires</DataHeader>
              <DataHeader>Status</DataHeader>
              <DataHeader>Document</DataHeader>
              <ActionsHeader />
            </DataHead>
            <DataBody>
              {rows.map((a) => {
                const { state } = agreementState(a, today);
                const mark = TONE[state];
                return (
                  <DataRow key={a.id} tone={state === "expired" ? "danger" : undefined}>
                    <DataRowHeader pinned className="sm:min-w-[12rem]">
                      {a.vendor}
                      <p className="mt-0.5 text-xs font-normal text-ink-2">
                        {AGREEMENT_TYPE_LABELS[a.type]} · {companyName(a.company)}
                        {a.signedOn !== null && ` · signed ${dayLabel(a.signedOn, now)}`}
                      </p>
                      {a.notes !== null && <p className="mt-1 hidden max-w-md text-sm font-normal text-ink-2 sm:block">{a.notes}</p>}
                    </DataRowHeader>
                    <DataCell hideBelow="md" className="whitespace-nowrap text-ink-2">
                      {AGREEMENT_TYPE_LABELS[a.type]}
                    </DataCell>
                    <DataCell className="min-w-[11rem]">
                      {a.status !== "active" && a.expiresOn === null ? (
                        <Blank />
                      ) : (
                        <StatusChip tone={mark?.tone ?? "neutral"} icon={mark?.icon}>
                          {a.status === "active" ? agreementText(a, today, now) : `Ends ${a.expiresOn === null ? "" : dayLabel(a.expiresOn, now)}`}
                        </StatusChip>
                      )}
                    </DataCell>
                    <DataCell>
                      <StatusChip tone={a.status === "active" ? "info" : "neutral"} variant="outline">
                        {AGREEMENT_STATUS_LABELS[a.status]}
                      </StatusChip>
                    </DataCell>
                    <DataCell className="text-xs whitespace-nowrap">
                      {a.link === null ? <span className="text-ink-2">No link</span> : <ExternalLink href={a.link}>Agreement</ExternalLink>}
                      <ChangedBy by={a.changedBy} />
                    </DataCell>
                    <DataCell actions className="py-2.5 whitespace-normal">
                      <div className="flex justify-end">
                        <button type="button" aria-label={`Edit ${a.vendor}`} onClick={() => setEditing(a.id)} className={rowButton}>
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
