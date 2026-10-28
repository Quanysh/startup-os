"use client";

import { useQuery } from "convex/react";
import { Blank, DataBody, DataCell, DataHead, DataHeader, DataRow, DataRowHeader, DataTable } from "@/components/ui/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { KindTag } from "@/components/ui/status-chip";
import { api } from "@convex/_generated/api";
import { AREA_WORDS } from "@/lib/agents/builder";
import { prettyJson } from "@/lib/agents/harness";
import { agoWords } from "@/lib/source-freshness";

/**
 * A project's tool catalogue (the Tools tab): what it can run for agents
 * built here, each reading or changing data, for patient data or not,
 * whether it asks a person first, and which published agents use it. Startup
 * OS's own tools for Startup OS, each with the page it needs.
 */
export function ToolsTable({ project, now }: { project: string; now: number }) {
  const view = useQuery(api.agentBuilder.tools, { project });
  if (view === undefined) return <Skeleton className="h-40 rounded-inner" />;
  if (view.tools.length === 0) {
    return <p className="text-sm text-ink-3">No tool reported yet. The project sends its tools with its usage report.</p>;
  }
  return (
    <DataTable label="Tools" download="Agent tools" className="min-w-[48rem]">
      <DataHead>
        <DataHeader pinned>Tool</DataHeader>
        <DataHeader>Does</DataHeader>
        <DataHeader>Patient data</DataHeader>
        {view.runsHere && <DataHeader>Page it needs</DataHeader>}
        <DataHeader>Approval</DataHeader>
        <DataHeader>Used by</DataHeader>
        <DataHeader>Input</DataHeader>
      </DataHead>
      <DataBody>
        {view.tools.map((tool) => (
          <DataRow key={tool.id}>
            <DataRowHeader pinned>
              {tool.name}
              <p className="font-mono text-xs font-normal text-ink-2">{tool.id}</p>
              {tool.lastReportedAt !== null && (
                <p className="text-xs font-normal text-ink-2">{`Reported ${agoWords(now, tool.lastReportedAt)}`}</p>
              )}
            </DataRowHeader>
            <DataCell exportValue={tool.effect === "write" ? "Changes data" : "Reads"}>
              <KindTag tone={tool.effect === "write" ? "plum" : "teal"}>{tool.effect === "write" ? "Changes data" : "Reads"}</KindTag>
              {tool.kind === "provider" && <p className="mt-1 text-xs text-ink-2">Built into the provider</p>}
              {tool.description !== "" && <p className="mt-1 max-w-sm text-xs text-ink-2">{tool.description}</p>}
            </DataCell>
            <DataCell exportValue={tool.phi ? "Yes" : "No"}>
              {tool.phi ? <KindTag tone="sand">Handles patient data</KindTag> : <span className="text-xs text-ink-2">No</span>}
            </DataCell>
            {view.runsHere && <DataCell>{tool.area === null ? <Blank /> : (AREA_WORDS[tool.area] ?? tool.area)}</DataCell>}
            <DataCell>{tool.effect === "write" ? "Always asks first" : tool.approvable ? "May ask first" : "Never asks"}</DataCell>
            <DataCell>
              {tool.usedBy.length === 0 ? <Blank>None</Blank> : <span className="font-mono text-xs">{tool.usedBy.join(", ")}</span>}
            </DataCell>
            <DataCell exportValue="">
              <details>
                <summary className="cursor-pointer text-xs text-ink-2 hover:text-ink">Schema</summary>
                <pre className="mt-1 max-h-48 max-w-xs overflow-auto rounded-inner bg-surface p-2 font-mono text-xs whitespace-pre-wrap text-ink">
                  {prettyJson(tool.inputSchema)}
                </pre>
              </details>
            </DataCell>
          </DataRow>
        ))}
      </DataBody>
    </DataTable>
  );
}
