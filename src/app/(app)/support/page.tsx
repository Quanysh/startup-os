"use client";

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { CircleAlertIcon } from "lucide-react";
import { api } from "@convex/_generated/api";
import { supportFigures } from "@convex/lib/supportMetrics";
import { PageFreshness } from "@/components/freshness/freshness-indicator";
import { Masonry } from "@/components/masonry";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import {
  Block,
  ChatsByWeek,
  ConnectIntercom,
  FinOutcomes,
  InboxHygiene,
  Quiet,
  TopArticles,
} from "@/components/support/blocks";
import { SupportKeyFigures } from "@/components/support/key-figures";
import { WaitingTable } from "@/components/support/waiting-table";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { COMPANIES } from "@/lib/company";
import { atWords } from "@/lib/source-freshness";
import { failureSentence } from "@/lib/support/words";

type Overview = FunctionReturnType<typeof api.support.overview>;

function Loading() {
  return (
    <div className="space-y-6" aria-busy>
      <Skeleton className="h-28 rounded-card" />
      <Skeleton className="h-64 rounded-card" />
      <Skeleton className="h-64 rounded-card" />
    </div>
  );
}

/**
 * Globex's Intercom inbox: who waits on a person, how fast people answer,
 * how Fin does, and what to tidy. Globex's alone (the shell shows it only
 * with Globex in view) and the `support` area's. The data is the daily
 * Intercom task's last push: waits are counted to it, windows and weeks to
 * this page's clock.
 */
export default function SupportPage() {
  const { can, companies } = useViewer();
  // Convex refuses anyone else: never asked for them.
  const allowed = can("support") && companies.includes("kz");
  const data = useQuery(api.support.overview, allowed ? {} : "skip");
  const now = useNow();
  return (
    <div className="space-y-6">
      <PageHeader
        title="Support"
        purpose={`${COMPANIES.kz.name}'s Intercom inbox: who is waiting on a person, how fast people answer, and how Fin does.`}
        aside={
          <>
            <PageFreshness page="support" />
            {/* Chats have arrived, but no new push can: the setup panel is for a source that never pushed. */}
            {data !== undefined && !data.configured && data.status.lastOkAt !== null && (
              <span className="text-xs text-ink-3">Push token not set: no new push can arrive</span>
            )}
          </>
        }
      />
      {data === undefined || now === null ? <Loading /> : <Loaded data={data} now={now} />}
    </div>
  );
}

function Loaded({ data, now }: { data: Overview; now: number }) {
  const pushedAt = data.status.lastOkAt;
  const failure = failureSentence(data.status.failure);
  if (pushedAt === null) {
    return data.configured ? (
      <Panel>
        <Quiet>Waiting for the first push from the daily Intercom task. Nothing here is known until it arrives.</Quiet>
        {failure !== null && (
          <p role="alert" className="mt-2 text-sm text-danger-ink">
            {failure}
          </p>
        )}
      </Panel>
    ) : (
      <ConnectIntercom />
    );
  }

  const figures = supportFigures(data.rows, now, pushedAt);
  return (
    <>
      {failure !== null && (
        <p role="alert" className="flex items-start gap-2 rounded-inner bg-danger-soft px-4 py-3 text-sm text-danger-ink">
          <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          {failure}
        </p>
      )}
      {data.rows.length === 0 ? (
        <Panel>
          <Quiet>No chats in the last 90 days.</Quiet>
        </Panel>
      ) : (
        <>
          <SupportKeyFigures figures={figures} />
          <Block
            title="Waiting on a person"
            note={`As of the last push, ${atWords(pushedAt, now)}. The task pushes once a day, so a chat answered since may still be here; Intercom has the latest.`}
          >
            <WaitingTable waits={figures.waiting} appId={data.appId} now={now} />
          </Block>
          <Masonry minColumnWidth={340} maxColumns={2}>
            <ChatsByWeek figures={figures} />
            <FinOutcomes figures={figures} />
            <TopArticles figures={figures} />
            <InboxHygiene figures={figures} appId={data.appId} />
          </Masonry>
        </>
      )}
    </>
  );
}
