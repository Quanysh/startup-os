"use client";

import { PLAYS_WINDOW_DAYS, winRateText, type PlayTally } from "@convex/lib/outcomes";
import {
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
} from "@/components/ui/data-table";

/**
 * A bot's "Plays" on Agents › Bots (Bot Loop v3): each play it logged an
 * outcome of in the last 30 days, with worked, failed, pending and its win
 * rate (worked of worked and failed). Nothing at all for a bot with none.
 * A play's name is text a bot chose: shown as text.
 */
export function BotPlays({ name, plays }: { name: string; plays: readonly PlayTally[] | undefined }) {
  if (plays === undefined || plays.length === 0) return null;
  return (
    <DataTable
      caption={`${name}'s plays, last ${PLAYS_WINDOW_DAYS} days`}
      showCaption
      download={false}
      className="min-w-[20rem]"
      boxClassName="mt-2"
    >
      <DataHead>
        <DataHeader pinned>Play</DataHeader>
        <DataHeader numeric>Worked</DataHeader>
        <DataHeader numeric>Failed</DataHeader>
        <DataHeader numeric hideBelow="sm">
          Pending
        </DataHeader>
        <DataHeader numeric>Win rate</DataHeader>
      </DataHead>
      <DataBody>
        {plays.map((tally) => (
          <DataRow key={tally.play}>
            <DataRowHeader pinned>{tally.play}</DataRowHeader>
            <DataCell numeric>{tally.worked}</DataCell>
            <DataCell numeric>{tally.failed}</DataCell>
            <DataCell numeric hideBelow="sm">
              {tally.pending}
            </DataCell>
            <DataCell numeric>{winRateText(tally.winRate)}</DataCell>
          </DataRow>
        ))}
      </DataBody>
    </DataTable>
  );
}
