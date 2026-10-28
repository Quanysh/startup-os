"use client";

import { ExternalLinkIcon } from "lucide-react";
import { POST_STATUSES, POST_STATUS_LABELS, accountLabel, engagementRate } from "@convex/lib/linkedin";
import { fieldClass } from "@/components/panel";
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
import { KindTag, StatusChip } from "@/components/ui/status-chip";
import { COMPANIES } from "@/lib/company";
import { localIsoDate } from "@/lib/dates";
import { dayLabel } from "@/lib/format";
import { accountsOf, type PostRow, type View } from "@/lib/linkedin/view";
import { cn } from "@/lib/utils";
import { POST_TONE } from "./calendar";
import { useId } from "react";

const percent = (rate: number | null) => (rate === null ? null : `${(rate * 100).toFixed(1)}%`);

/** The filters the calendar and the table share. */
export function Filters({ rows, view, setView }: { rows: readonly PostRow[]; view: View; setView: (next: View) => void }) {
  const ids = { q: useId(), account: useId(), status: useId() };
  const control = cn(fieldClass, "mt-1 h-9");
  const label = "text-xs font-medium text-ink-2";
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <div>
        <label htmlFor={ids.q} className={label}>
          Search
        </label>
        <input id={ids.q} type="search" value={view.q} onChange={(e) => setView({ ...view, q: e.target.value })} className={control} />
      </div>
      <div>
        <label htmlFor={ids.account} className={label}>
          Account
        </label>
        <select id={ids.account} value={view.account ?? ""} onChange={(e) => setView({ ...view, account: e.target.value || null })} className={control}>
          <option value="">All accounts</option>
          {accountsOf(rows).map(({ key, row }) => (
            <option key={key} value={key}>
              {row.account === "page" ? `${COMPANIES[row.company].name} page` : `${row.person} (${COMPANIES[row.company].name})`}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={ids.status} className={label}>
          Status
        </label>
        <select
          id={ids.status}
          value={view.status ?? ""}
          onChange={(e) => setView({ ...view, status: (e.target.value || null) as View["status"] })}
          className={control}
        >
          <option value="">Any</option>
          {POST_STATUSES.map((status) => (
            <option key={status} value={status}>
              {POST_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** Every post in view, newest first, with its latest figures. Downloads as CSV. */
export function PostsTable({
  rows,
  now,
  showCompany,
  onOpen,
}: {
  rows: readonly PostRow[];
  now: number;
  showCompany: boolean;
  onOpen: (id: string) => void;
}) {
  if (rows.length === 0) return <p className="text-sm text-ink-2">No post matches. Add the next one when it is planned.</p>;
  return (
    <DataTable caption="LinkedIn posts, newest first" download="LinkedIn posts" className="min-w-[56rem]">
      <DataHead>
        <DataHeader pinned>Post</DataHeader>
        <DataHeader>Account</DataHeader>
        <DataHeader>Status</DataHeader>
        <DataHeader>Date</DataHeader>
        <DataHeader hideBelow="md">Pillar</DataHeader>
        <DataHeader hideBelow="md">Owner</DataHeader>
        <DataHeader numeric>Impressions</DataHeader>
        <DataHeader numeric>Engagement</DataHeader>
        <DataHeader hideBelow="sm">Link</DataHeader>
        <ActionsHeader />
      </DataHead>
      <DataBody>
        {rows.map((row) => {
          const latest = row.snapshots.at(-1) ?? null;
          const at = row.publishedAt ?? row.plannedAt;
          const { tone, icon } = POST_TONE[row.status];
          return (
            <DataRow key={row.id}>
              <DataRowHeader pinned className="max-w-[26rem]" exportValue={row.title}>
                <span className="block [overflow-wrap:anywhere]">{row.title}</span>
                {row.byClient !== null && <span className="mt-0.5 block text-xs font-normal text-ink-2">Added by {row.byClient}</span>}
              </DataRowHeader>
              <DataCell>
                {accountLabel(row, COMPANIES[row.company].name)}
                {showCompany && row.account === "person" && <span className="block text-xs text-ink-2">{COMPANIES[row.company].name}</span>}
              </DataCell>
              <DataCell exportValue={POST_STATUS_LABELS[row.status]}>
                <StatusChip tone={tone} icon={icon}>
                  {POST_STATUS_LABELS[row.status]}
                </StatusChip>
              </DataCell>
              <DataCell className="whitespace-nowrap" exportValue={at === null ? "" : localIsoDate(at)}>
                {at === null ? <Blank>Undated</Blank> : dayLabel(localIsoDate(at), now)}
              </DataCell>
              <DataCell hideBelow="md">{row.pillar === null ? <Blank /> : <KindTag tone="teal">{row.pillar}</KindTag>}</DataCell>
              <DataCell hideBelow="md">{row.owner === null ? <Blank>Nobody</Blank> : (row.owner.name ?? row.owner.email ?? "A teammate")}</DataCell>
              <DataCell numeric>{latest?.impressions == null ? <Blank /> : latest.impressions.toLocaleString("en-US")}</DataCell>
              <DataCell numeric>{latest === null ? <Blank /> : (percent(engagementRate(latest)) ?? <Blank />)}</DataCell>
              <DataCell hideBelow="sm" exportValue={row.link ?? ""}>
                {row.link === null ? (
                  <Blank />
                ) : (
                  <a href={row.link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand underline underline-offset-2">
                    Open
                    <ExternalLinkIcon aria-hidden className="size-3.5" />
                    <span className="sr-only"> on LinkedIn</span>
                  </a>
                )}
              </DataCell>
              <DataCell actions>
                <button type="button" onClick={() => onOpen(row.id)} className={rowActionClass} aria-label={`Open ${row.title}`}>
                  Open
                </button>
              </DataCell>
            </DataRow>
          );
        })}
      </DataBody>
    </DataTable>
  );
}
