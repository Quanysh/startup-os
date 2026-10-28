"use client";

import { useMutation } from "convex/react";
import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import { PROJECT_WORDS, providerList } from "@convex/lib/agentProjects";
import { PRODUCT } from "@convex/lib/identity";
import { quietButtonClass } from "@/components/panel";
import { ConfirmDialog } from "@/components/work/confirm-dialog";
import { FAIL_MODE_WORDS, LEGACY_SENTENCE, REGION_WORDS, connectionReading } from "@/lib/agents/view";
import { messageOf } from "@/lib/errors";
import { agoWords } from "@/lib/source-freshness";
import { cn } from "@/lib/utils";
import { randomNonce } from "@/lib/work/pkce";
import type { ProjectCard } from "./project-cards";
import { StateChip } from "./parts";
import { ToolsTable } from "./tools-table";

const PANEL_TABS = [
  { id: "connection", label: "Connection" },
  { id: "tools", label: "Tools" },
] as const;
type PanelTab = (typeof PANEL_TABS)[number]["id"];

/**
 * One project, opened: where it is, what it is held to, its connection and
 * config versions, and its token's two actions. A new token is handed to
 * `onToken`, to be shown once.
 */
export function ProjectPanel({
  project,
  now,
  onToken,
}: {
  project: ProjectCard;
  now: number;
  onToken: (made: { name: string; slug: string; token: string }) => void;
}) {
  const rotate = useMutation(api.agentProjects.rotateToken);
  const disconnect = useMutation(api.agentProjects.disconnect);
  const [asking, setAsking] = useState<"rotate" | "disconnect" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<PanelTab>("connection");
  const reading = connectionReading(project, now);

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
      setAsking(null);
    } catch (failure) {
      setError(messageOf(failure, PROJECT_WORDS.tokenNotMade));
    } finally {
      setBusy(false);
    }
  };
  const issue = () =>
    run(async () => {
      const made = await rotate({ slug: project.slug, entropy: randomNonce() });
      onToken({ name: project.name, slug: made.slug, token: made.token });
    });

  const hasToken = project.connected;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base">{project.name}</h2>
          <p className="mt-1 text-xs text-ink-2">
            {`${project.slug} · ${REGION_WORDS[project.region]} · ${project.holdsPatientData ? "holds patient data" : "no patient data"} · may use ${providerList(project.allowedProviders)}`}
          </p>
        </div>
        <StateChip state={reading.state}>{reading.words}</StateChip>
      </div>
      <div role="tablist" aria-label="This project" className="inline-flex max-w-full flex-wrap gap-1 rounded-full bg-surface p-1">
        {PANEL_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={cn(
              "h-9 rounded-full px-4 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              tab === item.id ? "bg-brand-fill text-on-brand" : "text-ink-2 hover:text-ink",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      {tab === "tools" ? (
        <div role="tabpanel" aria-label="Tools" className="space-y-2">
          <p className="max-w-3xl text-xs text-ink-2">
            What the project can run for agents built here, as its last report said. A tool that changes data always asks a person first.
          </p>
          <ToolsTable project={project.slug} now={now} />
        </div>
      ) : (
      <div role="tabpanel" aria-label="Connection" className="space-y-4">
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-ink-2">When it cannot reach {PRODUCT.name}</dt>
          <dd className="mt-0.5 text-ink">{FAIL_MODE_WORDS[project.failMode]}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-2">Config</dt>
          <dd className="mt-0.5 text-ink">
            {project.latestVersion === 0
              ? "Nothing launched or changed from here yet"
              : `Version ${project.latestVersion}; ${project.appliedVersion === null ? "none applied yet" : `version ${project.appliedVersion} applied`}`}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-2">Token</dt>
          <dd className="mt-0.5 text-ink">
            {project.tokenCreatedAt === null ? "None" : `Made ${agoWords(now, project.tokenCreatedAt)}`}
          </dd>
        </div>
      </dl>
      {project.phiMismatch && (
        <p className="flex items-start gap-2 rounded-inner bg-danger-soft px-4 py-2 text-sm text-danger-ink">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          This project says one of its agents handles patient data, and it is not marked as holding patient data. That
          agent is held to providers for patient data all the same, and the project fails open: check how it is set up.
        </p>
      )}
      {project.legacy && <p className="max-w-3xl text-xs text-ink-2">{LEGACY_SENTENCE}</p>}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => (hasToken ? setAsking("rotate") : void issue())}
          className={cn(quietButtonClass, "bg-surface text-ink")}
        >
          {hasToken ? "Rotate token" : project.status === "disconnected" ? "Connect again" : "Issue a token"}
        </button>
        {hasToken && (
          <button type="button" onClick={() => setAsking("disconnect")} className={cn(quietButtonClass, "hover:text-destructive")}>
            Disconnect
          </button>
        )}
      </div>
      {error !== null && asking === null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {asking === "rotate" && (
        <ConfirmDialog
          title={`Rotate ${project.name}'s token?`}
          confirmLabel="Rotate"
          busy={busy}
          error={error}
          onConfirm={() => void issue()}
          onKeep={() => setAsking(null)}
        >
          The token it has stops working at once. Its agents cannot reach {PRODUCT.name} until the new one is set in the
          project.
        </ConfirmDialog>
      )}
      {asking === "disconnect" && (
        <ConfirmDialog
          title={`Disconnect ${project.name}?`}
          confirmLabel="Disconnect"
          busy={busy}
          error={error}
          onConfirm={() => void run(() => disconnect({ slug: project.slug }).then(() => undefined))}
          onKeep={() => setAsking(null)}
        >
          {`Its token stops working at once, and its agents ${project.failMode === "closed" ? "stop" : "keep their last config"}. Its agents, figures and changes are kept; a new token connects it again.`}
        </ConfirmDialog>
      )}
      </div>
      )}
    </div>
  );
}
