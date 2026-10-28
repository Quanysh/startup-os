"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import { effectiveOf, type Effective, type HarnessParts } from "@convex/lib/agentHarness";
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
import { Skeleton } from "@/components/ui/skeleton";
import { partsWords, prettyJson } from "@/lib/agents/harness";
import { messageOf } from "@/lib/errors";
import { atWords } from "@/lib/source-freshness";
import { DiffView, VariantDiffs, VersionChip } from "./harness-parts";
import type { HarnessView } from "./harness-tab";

type Version = HarnessView["versions"][number];

const paramsJson = (effective: Effective) => (effective.params === null ? "" : JSON.stringify(effective.params, null, 2));
const toolsText = (effective: Effective) => (effective.tools ?? []).join("\n");

/**
 * One version against another, part by part, as each would run: the prompt
 * variant by variant. A version's prompt is read only when it is opened; the
 * draft's and the published one's came with the tab.
 */
function VersionDiff({ view, version }: { view: HarnessView; version: Version }) {
  const known = [view.draft, view.published].find((row) => row?.id === version.id)?.parts;
  const fetched = useQuery(api.agentHarness.version, known === undefined ? { id: version.id } : "skip");
  const parts: HarnessParts | null | undefined = known ?? (fetched === null ? null : fetched?.parts);
  if (parts === undefined) return <Skeleton className="h-32 rounded-inner" />;
  if (parts === null) return <p className="text-sm text-ink-3">There is no such version.</p>;
  const base = view.published !== null && view.published.id !== version.id ? view.published : null;
  const before = effectiveOf(base?.parts ?? {}, view.defaults);
  const after = effectiveOf(parts, view.defaults);
  return (
    <div className="space-y-3 rounded-inner bg-surface p-4">
      <p className="text-sm text-ink-2">
        {`${version.name} against ${base === null ? "the project's built-in harness" : base.name}.`}
      </p>
      <div className="min-w-0">
        <p className="text-xs font-medium text-ink-2">Prompt, by variant</p>
        <VariantDiffs before={before.prompt?.variants ?? {}} after={after.prompt?.variants ?? {}} />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <DiffView label="Parameters" before={paramsJson(before)} after={paramsJson(after)} />
        <DiffView label="Tools" before={toolsText(before)} after={toolsText(after)} />
      </div>
      <DiffView label="Output schema" before={prettyJson(before.outputSchema)} after={prettyJson(after.outputSchema)} />
    </div>
  );
}

/** The Versions tab: every version with who and when, a diff, and rolling back. */
export function VersionsTab({ view, now }: { view: HarnessView; now: number }) {
  const rollback = useMutation(api.agentHarness.rollback);
  const [opened, setOpened] = useState<string | null>(null);
  const [state, setState] = useState<{ busy: string | null; error: string | null; done: string | null }>({
    busy: null,
    error: null,
    done: null,
  });
  const back = async (version: Version) => {
    setState({ busy: version.id, error: null, done: null });
    try {
      const result = await rollback({ id: version.id });
      setState({
        busy: null,
        error: null,
        done: `${result.version} is published again in config version ${result.configVersion}. It is pending until the project applies it.`,
      });
    } catch (failure) {
      setState({ busy: null, error: messageOf(failure), done: null });
    }
  };
  if (view.versions.length === 0) {
    return <p className="text-sm text-ink-3">No version yet: the agent runs the project&apos;s built-in harness.</p>;
  }
  const openVersion = view.versions.find((row) => row.id === opened) ?? null;
  return (
    <div className="space-y-6">
      <DataTable label="Versions" download="Agent harness versions" className="min-w-[52rem]">
        <DataHead>
          <DataHeader pinned>Version</DataHeader>
          <DataHeader>State</DataHeader>
          <DataHeader>What it changes</DataHeader>
          <DataHeader>Made</DataHeader>
          <DataHeader>Last published</DataHeader>
          <DataHeader>Note</DataHeader>
          <ActionsHeader />
        </DataHead>
        <DataBody>
          {view.versions.map((row) => {
            const wasPublished = row.publishedAt !== null;
            return (
              <DataRow key={row.id}>
                <DataRowHeader pinned>
                  {row.name}
                  {row.status === "draft" && <p className="text-xs font-normal text-ink-2">{`Revision ${row.revision}`}</p>}
                </DataRowHeader>
                <DataCell>
                  <VersionChip status={row.status} wasPublished={wasPublished} />
                </DataCell>
                <DataCell>
                  {partsWords(row.changed)}
                  {row.promptVariants !== null && row.promptVariants.length > 1 && (
                    <p className="text-xs text-ink-2">{`Variants: ${row.promptVariants.join(", ")}`}</p>
                  )}
                </DataCell>
                <DataCell className="whitespace-nowrap">{`${row.createdBy}, ${atWords(row.createdAt, now)}`}</DataCell>
                <DataCell className="whitespace-nowrap">
                  {row.publishedAt === null ? <Blank>Never</Blank> : `${row.publishedBy ?? "Someone"}, ${atWords(row.publishedAt, now)}`}
                </DataCell>
                <DataCell>{row.note === "" ? <Blank /> : row.note}</DataCell>
                <DataCell>
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      onClick={() => setOpened(opened === row.id ? null : row.id)}
                      className={rowActionClass}
                    >
                      {opened === row.id ? "Hide changes" : "Changes"}
                    </button>
                    {view.mayPublish && row.status === "archived" && wasPublished && (
                      <button
                        type="button"
                        disabled={state.busy !== null}
                        onClick={() => void back(row)}
                        className={rowActionClass}
                      >
                        {`Roll back to ${row.name}`}
                      </button>
                    )}
                  </div>
                </DataCell>
              </DataRow>
            );
          })}
        </DataBody>
      </DataTable>
      {state.done !== null && <p className="text-sm text-ink">{state.done}</p>}
      {state.error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      {!view.mayPublish && <p className="text-xs text-ink-2">Rolling back is for the owner and engineers.</p>}
      {openVersion !== null && <VersionDiff view={view} version={openVersion} />}

      <section aria-label="Publishes and rollbacks" className="space-y-2">
        <h4 className="text-sm font-medium text-ink">Publishes and rollbacks</h4>
        {view.events.length === 0 ? (
          <p className="text-sm text-ink-3">Nothing published yet.</p>
        ) : (
          <DataTable label="Publishes and rollbacks" download="Agent harness history" className="min-w-[40rem]">
            <DataHead>
              <DataHeader pinned>When</DataHeader>
              <DataHeader>What</DataHeader>
              <DataHeader>By</DataHeader>
              <DataHeader numeric>Config version</DataHeader>
              <DataHeader>Published untested because</DataHeader>
            </DataHead>
            <DataBody>
              {view.events.map((event) => (
                <DataRow key={event.id} tone={event.overrideReason !== null ? "warning" : undefined}>
                  <DataRowHeader pinned className="font-normal whitespace-nowrap">
                    {atWords(event.at, now)}
                  </DataRowHeader>
                  <DataCell>{event.action === "publish" ? `Published ${event.name}` : `Rolled back to ${event.name}`}</DataCell>
                  <DataCell>{event.by}</DataCell>
                  <DataCell numeric>{event.configVersion}</DataCell>
                  <DataCell>{event.overrideReason ?? <Blank />}</DataCell>
                </DataRow>
              ))}
            </DataBody>
          </DataTable>
        )}
      </section>
    </div>
  );
}
