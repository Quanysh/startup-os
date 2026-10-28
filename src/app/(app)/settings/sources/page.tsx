"use client";

import { useQuery } from "convex/react";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  KeyRoundIcon,
} from "lucide-react";
import Link from "next/link";
import { api } from "@convex/_generated/api";
import { cadenceOf, cadenceWords, failureKeyOf } from "@convex/lib/cadence";
import { MIRROR_SOURCES } from "@convex/lib/mirrorRules";
import { Panel } from "@/components/panel";
import { RunSource } from "@/components/run-source";
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
import { KindTag, StatusChip, type KindTone } from "@/components/ui/status-chip";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { COMPANIES, companyIds } from "@/lib/company";
import { ageLabel } from "@/lib/freshness";
import { sourceLabel } from "@/lib/metrics/scorecard";
import { feedLabel, sourceCondition } from "@/lib/source-condition";
import { STATE_TONE, STATE_WORDS, classify } from "@/lib/source-freshness";
import { cn } from "@/lib/utils";

const isMirrorSource = (id: string) => (MIRROR_SOURCES as readonly string[]).includes(id);

type Source = NonNullable<ReturnType<typeof useQuery<typeof api.sources.list>>>[number];

/** When a source last ran, for the runs that count: null where it has none to speak of. */
function lastRunOf(source: Source): number | null {
  const condition = sourceCondition(source);
  if (source.status === null || (condition !== "ok" && condition !== "failed")) return null;
  return source.status.lastRunAt;
}

function SourceState({ source, now }: { source: Source; now: number | null }) {
  const condition = sourceCondition(source);
  if (condition === "unconfigured") {
    return (
      <div className="text-sm">
        <p>
          <StatusChip tone="warning" icon={KeyRoundIcon}>
            Not configured
          </StatusChip>
        </p>
        <p className="mt-1 text-xs text-ink-2">
          Set{" "}
          {source.missingEnv.map((name, i) => (
            <span key={name}>
              {i > 0 && ", "}
              <code className="rounded bg-surface px-1 py-0.5 font-mono text-[11px] text-ink">
                {name}
              </code>
            </span>
          ))}{" "}
          in the Convex dashboard.
          {source.pushEnv !== null && (
            <>
              {" "}
              Or set{" "}
              <code className="rounded bg-surface px-1 py-0.5 font-mono text-[11px] text-ink">
                {source.pushEnv}
              </code>{" "}
              to have a connector run push it.
            </>
          )}
        </p>
      </div>
    );
  }
  if (condition === "ready") {
    return (
      <p>
        <StatusChip tone="success" icon={CircleCheckIcon}>
          Ready
        </StatusChip>
      </p>
    );
  }
  const { status } = source;
  if (condition === "waiting" || status === null) {
    return (
      <p>
        <StatusChip tone="neutral" icon={CircleDashedIcon}>
          Configured, nothing received yet
        </StatusChip>
      </p>
    );
  }
  const ok = condition === "ok";
  return (
    <div className="text-sm">
      <p>
        <StatusChip tone={ok ? "success" : "danger"} icon={ok ? CircleCheckIcon : CircleAlertIcon}>
          {ok ? "Working" : "Last run failed"}
        </StatusChip>
      </p>
      {!ok && status.message && (
        <p className="mt-1 break-words text-xs text-ink-2">{status.message}</p>
      )}
      {!ok && status.lastOkAt !== null && now !== null && (
        <p className="mt-1 text-xs text-ink-2">
          Numbers on screen were last confirmed {ageLabel(now, status.lastOkAt)}.
        </p>
      )}
    </div>
  );
}

const DOT = { good: "bg-good", watch: "bg-watch", weak: "bg-weak", neutral: "bg-ink-3" } as const;

/**
 * Whether its numbers are on time, by the same cadence and in the same words
 * as the "Updated …" line in each page's header, so the two never disagree.
 */
function Timeliness({ source, now }: { source: Source; now: number }) {
  const cadence = cadenceOf(source.id);
  if (cadence === null || cadence.kind === "typed" || source.status === null) return null;
  const state = classify(
    { cadence, lastOkAt: source.status.lastOkAt, failureKey: failureKeyOf(source.status.state) },
    now,
  );
  return (
    <span className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-2">
      <span aria-hidden className={cn("size-1.5 rounded-full", DOT[STATE_TONE[state]])} />
      {STATE_WORDS[state]}
    </span>
  );
}

// Which way a source is fed is a kind, not a state: a hue each.
const FEED_TONE: Record<Source["kind"], KindTone> = { api: "teal", ingest: "violet", manual: "slate" };
/** A pulled source fed by a connector run is "pushed", and wears that hue. */
const feedTone = (source: Source): KindTone =>
  source.kind === "api" && source.fedBy === "push" ? "violet" : FEED_TONE[source.kind];

export default function SourcesPage() {
  // The four work tools' state has one place, Settings › Connections
  // (`SourceSwitches`): they are not rows here.
  const sources = useQuery(api.sources.list)?.filter((source) => !isMirrorSource(source.id));
  const runs = useQuery(api.sources.recentRuns, { limit: 15 });
  const now = useNow();
  // The owner is sent every source. A teammate with this page is sent the
  // sources of their own companies, and never the owner's own work tools.
  const viewer = useViewer();
  const theirs = companyIds().filter((id) => viewer.companies.includes(id))
    .map((id) => COMPANIES[id].name)
    .join(" and ");

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl sm:text-3xl">Sources</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-2">
          Where each number comes from, whether it is connected, and how its last run
          went. Numbers with no system of record are recorded on Finance, under
          &ldquo;Record a figure&rdquo;.
        </p>
        {viewer.isOwner ? (
          <p className="mt-1 max-w-2xl text-sm text-ink-2">
            Your work tools (mail, calendar, Linear and Fireflies) are on{" "}
            <Link href="/settings/connections" className="font-medium text-ink underline underline-offset-2">
              Settings › Connections
            </Link>
            .
          </p>
        ) : (
          <p className="mt-1 max-w-2xl text-sm text-ink-2">
            You see the sources that serve {theirs}. The owner&apos;s own work tools (mail,
            calendar, Linear and Fireflies) are not listed here.
          </p>
        )}
      </header>

      <Panel aria-labelledby="sources-list">
        <h2 id="sources-list" className="text-base">
          Connected sources
        </h2>
        {sources === undefined ? (
          <Skeleton className="mt-4 h-32 rounded-inner" />
        ) : (
          <DataTable caption="Connected sources" className="min-w-[64rem]" boxClassName="mt-2">
            <DataHead>
              <DataHeader pinned>Source</DataHeader>
              <DataHeader>Feeds</DataHeader>
              <DataHeader>How it arrives</DataHeader>
              <DataHeader>Last run</DataHeader>
              <DataHeader>State</DataHeader>
              <ActionsHeader />
            </DataHead>
            <DataBody>
              {sources.map((source) => {
                const lastRun = lastRunOf(source);
                return (
                  <DataRow
                    key={source.id}
                    tone={sourceCondition(source) === "failed" ? "danger" : undefined}
                  >
                    <DataRowHeader pinned className="sm:whitespace-nowrap">
                      {source.label}
                    </DataRowHeader>
                    <DataCell className="max-w-[20rem] min-w-[14rem] text-xs text-ink-2">
                      {source.description}
                    </DataCell>
                    <DataCell className="whitespace-nowrap">
                      <KindTag tone={feedTone(source)}>{feedLabel(source)}</KindTag>
                      {cadenceOf(source.id) !== null && (
                        <span className="mt-1 block text-xs text-ink-2">
                          {cadenceWords(cadenceOf(source.id)!)}
                        </span>
                      )}
                    </DataCell>
                    <DataCell className="font-num whitespace-nowrap text-ink-2">
                      {lastRun === null ? (
                        <Blank>{source.kind === "manual" ? "No runs" : "Not yet"}</Blank>
                      ) : now === null ? (
                        ""
                      ) : (
                        <>
                          {ageLabel(now, lastRun)}
                          <Timeliness source={source} now={now} />
                        </>
                      )}
                    </DataCell>
                    <DataCell className="max-w-[22rem] min-w-[14rem]">
                      <SourceState source={source} now={now} />
                    </DataCell>
                    <DataCell actions className="whitespace-normal">
                      {source.fedBy === "pull" && (
                        <RunSource
                          source={source.id}
                          label={source.label}
                          backfill={source.canBackfill}
                          className="justify-end text-right"
                        />
                      )}
                    </DataCell>
                  </DataRow>
                );
              })}
            </DataBody>
          </DataTable>
        )}
      </Panel>

      <section aria-labelledby="runs" className="rounded-card bg-panel p-5 shadow-soft sm:p-6">
        <h2 id="runs" className="text-base">
          Recent runs
        </h2>
        {runs === undefined ? (
          <Skeleton className="mt-4 h-24 rounded-inner" />
        ) : runs.length === 0 ? (
          <p className="mt-3 text-sm text-ink-3">
            No pushes or syncs yet. They are listed here as they happen.
          </p>
        ) : (
          <DataTable caption="Recent runs" className="min-w-[34rem]" boxClassName="mt-2">
            <DataHead>
              <DataHeader pinned>Source</DataHeader>
              <DataHeader>Result</DataHeader>
              <DataHeader numeric>New</DataHeader>
              <DataHeader numeric>Changed</DataHeader>
              <DataHeader numeric>Same</DataHeader>
              <DataHeader>When</DataHeader>
            </DataHead>
            <DataBody>
              {runs.map((run) => (
                <DataRow key={run.id} tone={run.status === "ok" ? undefined : "danger"}>
                  <DataRowHeader pinned>{sourceLabel(run.source)}</DataRowHeader>
                  <DataCell>
                    <StatusChip
                      tone={run.status === "ok" ? "success" : "danger"}
                      icon={run.status === "ok" ? CircleCheckIcon : CircleAlertIcon}
                    >
                      {run.status === "ok" ? "OK" : "Failed"}
                    </StatusChip>
                    {run.message && (
                      <span className="mt-0.5 block max-w-xs break-words text-xs text-ink-2">
                        {run.message}
                      </span>
                    )}
                  </DataCell>
                  {[run.inserted, run.updated, run.unchanged].map((count, i) => (
                    <DataCell key={i} numeric className={cn(count === 0 && "text-ink-2")}>
                      {count}
                    </DataCell>
                  ))}
                  <DataCell className="font-num whitespace-nowrap text-ink-2">
                    {now !== null ? ageLabel(now, run.startedAt) : ""}
                  </DataCell>
                </DataRow>
              ))}
            </DataBody>
          </DataTable>
        )}
      </section>
    </div>
  );
}
