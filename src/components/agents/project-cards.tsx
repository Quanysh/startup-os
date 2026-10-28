"use client";

import { TriangleAlertIcon } from "lucide-react";
import type { Cost } from "@convex/lib/agentControl";
import { INTERNAL_PROJECT, type FailMode, type Region } from "@convex/lib/agentProjects";
import { KindTag } from "@/components/ui/status-chip";
import { connectionReading, costNote, costWords } from "@/lib/agents/view";
import { cn } from "@/lib/utils";
import type { RunsOn } from "@convex/lib/osAgents";
import { RunsOnChip, StateChip } from "./parts";

export type ProjectCard = {
  slug: string;
  name: string;
  region: Region;
  holdsPatientData: boolean;
  allowedProviders: string[];
  status: "active" | "disconnected";
  connected: boolean;
  legacy: boolean;
  tokenCreatedAt: number | null;
  lastSeenAt: number | null;
  lastUsageAt: number | null;
  failMode: FailMode;
  agentsCount: number;
  knownCount: number;
  callsToday: number | null;
  errorsToday: number | null;
  costToday: Cost;
  latestVersion: number;
  appliedVersion: number | null;
  phiMismatch: boolean;
};

/** Startup OS's own agents, as the owner's card shows them. */
export type InternalCard = {
  name: string;
  note: string;
  today: { calls: number; errors: number };
  agents: { id: string; name: string; on: boolean; runsOn: RunsOn }[];
};

const cardClass =
  "flex h-full w-full flex-col gap-3 rounded-inner border border-line bg-panel p-4 text-left outline-none transition hover:bg-surface focus-visible:ring-3 focus-visible:ring-ring/50 aria-pressed:border-brand aria-pressed:ring-2 aria-pressed:ring-brand";

function Figure({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="text-xs text-ink-2">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-ink tabular-nums">{children}</dd>
    </div>
  );
}

/** "None reported", in the quiet colour: a figure that is not known is not a zero. */
const Missing = ({ children = "None reported" }: { children?: string }) => (
  <span className="font-normal text-ink-3">{children}</span>
);

/**
 * The projects as cards: every one first ("All projects"), then each
 * connected project, then Startup OS's own (the owner's). Each says where it
 * is, whether it holds patient data, whether it is connected, how many
 * agents it has, and today's cost and errors. Choosing one is the address.
 */
export function ProjectCards({
  projects,
  internal,
  selected,
  now,
  onSelect,
}: {
  projects: readonly ProjectCard[];
  internal: InternalCard | null;
  selected: string | null;
  now: number;
  onSelect: (slug: string | null) => void;
}) {
  return (
    <ul aria-label="Projects" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <li className="min-w-0">
        <button type="button" aria-pressed={selected === null} onClick={() => onSelect(null)} className={cardClass}>
          <span className="text-sm font-medium text-ink">All projects</span>
          <span className="text-xs text-ink-2">
            {`${projects.length} ${projects.length === 1 ? "project" : "projects"}, ${projects.reduce((n, p) => n + p.agentsCount, 0)} agents`}
          </span>
        </button>
      </li>
      {projects.map((project) => {
        const reading = connectionReading(project, now);
        return (
          <li key={project.slug} className="min-w-0">
            <button
              type="button"
              aria-pressed={selected === project.slug}
              aria-label={project.name}
              onClick={() => onSelect(project.slug)}
              className={cardClass}
            >
              <div className="flex w-full flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{project.name}</p>
                  <p className="truncate text-xs text-ink-2">{project.slug}</p>
                </div>
                <StateChip state={reading.state}>{reading.words}</StateChip>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <KindTag tone="slate">{project.region}</KindTag>
                <KindTag tone={project.holdsPatientData ? "teal" : "sand"}>
                  {project.holdsPatientData ? "Patient data" : "No patient data"}
                </KindTag>
              </div>
              <dl className="grid w-full grid-cols-3 gap-2">
                <Figure label="Agents">{project.agentsCount}</Figure>
                <Figure label="Cost today" title={costNote(project.costToday) ?? undefined}>
                  {project.costToday.usd === null ? <Missing>{costWords(project.costToday)}</Missing> : costWords(project.costToday)}
                </Figure>
                <Figure label="Errors today">
                  {project.errorsToday === null ? <Missing /> : project.errorsToday.toLocaleString("en-US")}
                </Figure>
              </dl>
              {project.phiMismatch && (
                <p className="inline-flex items-center gap-1 text-xs text-danger-ink">
                  <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
                  Reports an agent that handles patient data
                </p>
              )}
            </button>
          </li>
        );
      })}
      {internal !== null && (
        <li className="min-w-0">
          <button
            type="button"
            aria-pressed={selected === INTERNAL_PROJECT}
            aria-label={internal.name}
            onClick={() => onSelect(INTERNAL_PROJECT)}
            className={cn(cardClass)}
          >
            <div className="flex w-full flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink">{internal.name}</p>
                <p className="text-xs text-ink-2">Internal</p>
              </div>
              <StateChip state="typed">Not token-connected</StateChip>
            </div>
            <p className="text-xs text-ink-2">{internal.note}</p>
            {internal.agents.length > 0 && (
              <span className="flex w-full flex-col gap-1" aria-label="Where each runs">
                {internal.agents.map((agent) => (
                  <span key={agent.id} className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-xs">
                    <span className={cn("min-w-0 truncate", agent.on ? "text-ink" : "text-ink-3")}>
                      {agent.on ? agent.name : `${agent.name} (off)`}
                    </span>
                    <RunsOnChip runsOn={agent.runsOn} />
                  </span>
                ))}
              </span>
            )}
            <dl className="grid w-full grid-cols-3 gap-2">
              <Figure label="Agents">{internal.agents.length}</Figure>
              <Figure label="Calls today">{internal.today.calls.toLocaleString("en-US")}</Figure>
              <Figure label="Errors today">{internal.today.errors.toLocaleString("en-US")}</Figure>
            </dl>
          </button>
        </li>
      )}
    </ul>
  );
}
