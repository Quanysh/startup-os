"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import { MIRROR_SOURCES, type MirrorSource } from "@convex/lib/mirrorRules";
import { Panel, quietButtonClass } from "@/components/panel";
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
import { StatusMark, type StatusTone } from "@/components/ui/status-chip";
import { ConfirmDialog } from "@/components/work/confirm-dialog";
import { useNow } from "@/hooks/use-now";
import { messageOf } from "@/lib/errors";
import { ageLabel } from "@/lib/freshness";
import { cn } from "@/lib/utils";

type Source = NonNullable<ReturnType<typeof useQuery<typeof api.sources.list>>>[number];

const isMirror = (id: string): id is MirrorSource =>
  (MIRROR_SOURCES as readonly string[]).includes(id);
/** Their keys live in the Convex environment, where the OS cannot delete them. */
const KEYED: readonly MirrorSource[] = ["linear", "fireflies"];

function Code({ children }: { children: string }) {
  return (
    <code className="rounded bg-surface px-1 py-0.5 font-mono text-[11px] text-ink">{children}</code>
  );
}

/** How one source stands, in a sentence. `status.message` is always one of this codebase's own. */
function RowState({ source, off, now }: { source: Source; off: boolean; now: number | null }) {
  const { status } = source;
  const age = (at: number) => (now === null ? "" : ` ${ageLabel(now, at)}`);
  if (off) return <>Off. Nothing from {source.label} is stored.</>;
  if (source.missingEnv.length > 0) {
    return (
      <>
        Not set up. Set{" "}
        {source.missingEnv.map((name, i) => (
          <span key={name}>
            {i > 0 && ", "}
            <Code>{name}</Code>
          </span>
        ))}{" "}
        in the Convex dashboard.
      </>
    );
  }
  // Fed by a connector run: nothing is read on a schedule, so an older
  // "not set up" or "turned off" note says nothing about now.
  if (source.fedBy === "push" && (status === null || status.state === "not_configured")) {
    return <>Pushed by a connector run. Waiting for its first push.</>;
  }
  if (status === null) return <>Waiting for its first read.</>;
  if (status.state === "ok" && status.lastOkAt !== null) {
    return <>Last read{age(status.lastOkAt)}.</>;
  }
  // A setup step still to do (Google not connected yet), in its own sentence.
  if (status.state === "not_configured") return <>{status.message ?? "Not set up."}</>;
  return (
    <>
      Last run failed: {status.message ?? "no reason was recorded."}
      {status.lastOkAt !== null && <> Last good read{age(status.lastOkAt)}.</>}
    </>
  );
}

/**
 * The tone of the sentence `RowState` says, branch for branch: read is good,
 * a setup step still to do asks for a look, a failed run asks for action, and
 * off or waiting is neither.
 */
function toneOf(source: Source, off: boolean): StatusTone {
  const { status } = source;
  if (off) return "neutral";
  if (source.missingEnv.length > 0) return "warning";
  if (source.fedBy === "push" && (status === null || status.state === "not_configured")) {
    return "neutral";
  }
  if (status === null) return "neutral";
  if (status.state === "ok" && status.lastOkAt !== null) return "success";
  if (status.state === "not_configured") return "warning";
  return "danger";
}

export function SourceSwitches() {
  const settings = useQuery(api.workTools.settings);
  const sources = useQuery(api.sources.list);
  const turnOff = useMutation(api.workTools.turnOff);
  const turnOn = useMutation(api.workTools.turnOn);
  const now = useNow();

  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<MirrorSource | null>(null);
  const [error, setError] = useState<{ source: MirrorSource; message: string } | null>(null);

  const rows = (sources ?? []).filter((source) => isMirror(source.id));
  const asking = rows.find((source) => source.id === confirming);

  const change = async (source: MirrorSource, to: "on" | "off") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await (to === "off" ? turnOff({ source }) : turnOn({ source }));
      setConfirming(null);
    } catch (failure) {
      setError({ source, message: messageOf(failure, "That could not be changed. Try again.") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel aria-labelledby="work-sources">
      <h2 id="work-sources" className="text-base">
        What is read
      </h2>
      {settings === undefined || sources === undefined ? (
        <Skeleton data-testid="sources-loading" className="mt-4 h-40 rounded-inner" />
      ) : (
        <DataTable caption="What is read" className="min-w-[44rem]" boxClassName="mt-2">
          <DataHead>
            <DataHeader pinned>Source</DataHeader>
            <DataHeader>Reads</DataHeader>
            <DataHeader>State</DataHeader>
            <ActionsHeader />
          </DataHead>
          <DataBody>
            {rows.map((source) => {
              const id = source.id as MirrorSource;
              const off = settings.off.includes(id);
              const canTurnOff = !off && source.missingEnv.length === 0;
              const tone = toneOf(source, off);
              return (
                <DataRow key={id} tone={tone === "danger" ? "danger" : undefined}>
                  <DataRowHeader pinned className="sm:whitespace-nowrap">
                    {source.label}
                  </DataRowHeader>
                  <DataCell className="max-w-[20rem] min-w-[12rem] text-xs text-ink-2">
                    {source.description}
                  </DataCell>
                  <DataCell className="max-w-[24rem] min-w-[14rem]">
                    <div className="flex items-start gap-1.5">
                      {/* The sentence says the state; the mark lets it be found by eye. */}
                      <StatusMark tone={tone} className="mt-0.5" />
                      <p
                        className="min-w-0 break-words text-sm text-ink-2"
                        data-testid={`state-${id}`}
                        data-tone={tone}
                      >
                        <RowState source={source} off={off} now={now} />
                      </p>
                    </div>
                    {error?.source === id && confirming === null && (
                      <p role="alert" className="mt-1.5 text-sm text-destructive">
                        {error.message}
                      </p>
                    )}
                  </DataCell>
                  <DataCell actions className="py-2.5">
                    {off ? (
                      <button
                        type="button"
                        aria-label={`Turn on: ${source.label}`}
                        aria-disabled={busy}
                        onClick={() => change(id, "on")}
                        className={cn(
                          quietButtonClass,
                          "h-8 border border-line bg-panel px-3 text-xs text-ink hover:bg-panel aria-disabled:opacity-60",
                        )}
                      >
                        Turn on
                      </button>
                    ) : (
                      canTurnOff && (
                        <button
                          type="button"
                          aria-label={`Turn off and delete: ${source.label}`}
                          onClick={() => {
                            setError(null);
                            setConfirming(id);
                          }}
                          className={cn(
                            quietButtonClass,
                            "h-8 px-3 text-xs hover:bg-panel hover:text-destructive",
                          )}
                        >
                          Turn off and delete
                        </button>
                      )
                    )}
                  </DataCell>
                </DataRow>
              );
            })}
          </DataBody>
        </DataTable>
      )}

      {asking && confirming && (
        <ConfirmDialog
          title={`Turn off ${asking.label}?`}
          confirmLabel="Turn off and delete"
          busy={busy}
          error={error?.source === confirming ? error.message : null}
          onConfirm={() => change(confirming, "off")}
          onKeep={() => {
            setConfirming(null);
            setError(null);
          }}
        >
          This deletes what the OS has stored from it.
          {KEYED.includes(confirming) &&
            " Its key stays in the Convex dashboard until you remove it there."}
        </ConfirmDialog>
      )}
    </Panel>
  );
}
