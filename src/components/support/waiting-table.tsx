import { CircleCheckIcon, ExternalLinkIcon } from "lucide-react";
import { intercomLink } from "@convex/lib/support";
import { FIN_RESULT_WORDS, NEEDS_YOU_AFTER_MS, type Wait } from "@convex/lib/supportMetrics";
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
import { atWords } from "@/lib/source-freshness";
import { durationWords, pageAreaWords } from "@/lib/support/words";

/**
 * The customers waiting on a person, the longest wait first: how long, where
 * in Globex the chat began, what Fin did, who has it, when the customer
 * last wrote, and the chat in Intercom. A wait past four hours (what Today's
 * "Needs you" lists) wears the danger tone; its age says why.
 */
export function WaitingTable({ waits, appId, now }: { waits: readonly Wait[]; appId: string | null; now: number }) {
  if (waits.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm text-ink-2">
        <CircleCheckIcon aria-hidden className="size-4 shrink-0 text-good" />
        Nobody is waiting on a person.
      </p>
    );
  }
  return (
    <DataTable label="Waiting on a person" download="Waiting on a person">
      <DataHead>
        <DataHeader pinned>Waiting</DataHeader>
        <DataHeader>Page</DataHeader>
        <DataHeader>Fin</DataHeader>
        <DataHeader>Assignee</DataHeader>
        <DataHeader hideBelow="md">Customer last wrote</DataHeader>
        <ActionsHeader>Open in Intercom</ActionsHeader>
      </DataHead>
      <DataBody>
        {waits.map((wait) => {
          const href = intercomLink(appId, wait.intercomId);
          return (
            <DataRow key={wait.intercomId} tone={wait.waitedMs > NEEDS_YOU_AFTER_MS ? "danger" : undefined}>
              <DataRowHeader pinned className="font-num whitespace-nowrap">
                {durationWords(wait.waitedMs)}
              </DataRowHeader>
              <DataCell>{wait.pageArea === null ? <Blank>{pageAreaWords(null)}</Blank> : pageAreaWords(wait.pageArea)}</DataCell>
              <DataCell>{FIN_RESULT_WORDS[wait.fin]}</DataCell>
              <DataCell>
                {wait.assigneeName ??
                  (wait.assigneeId === null ? <Blank>Unassigned</Blank> : `Teammate ${wait.assigneeId}`)}
              </DataCell>
              <DataCell hideBelow="md" className="whitespace-nowrap">
                {wait.lastCustomerReplyAt === null ? <Blank /> : atWords(wait.lastCustomerReplyAt, now)}
              </DataCell>
              <DataCell actions>
                {href !== null && (
                  <a href={href} target="_blank" rel="noreferrer noopener" className={rowActionClass}>
                    Open in Intercom
                    <ExternalLinkIcon aria-hidden className="size-3.5" />
                  </a>
                )}
              </DataCell>
            </DataRow>
          );
        })}
      </DataBody>
    </DataTable>
  );
}
