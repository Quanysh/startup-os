"use client";

import { useMutation, useQuery } from "convex/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useId, useState, type ReactNode } from "react";
import { api } from "@convex/_generated/api";
import { PATIENT_DATA_NOTE, dayOf } from "@convex/lib/agentControl";
import { INTERNAL_PROJECT, INTERNAL_PROJECT_NAME, LEGACY_PROJECT } from "@convex/lib/agentProjects";
import { featureOn } from "@convex/lib/featureGates";
import { PRODUCT } from "@convex/lib/identity";
import { AgentDetail, type DetailTab } from "@/components/agents/agent-detail";
import { AgentsTable, agentKey, type AgentRow } from "@/components/agents/agents-table";
import { BotsTab } from "@/components/agents/bots-tab";
import { ChangeLog } from "@/components/agents/change-log";
import { ConnectProject, TokenReveal } from "@/components/agents/connect-project";
import { CreateAgent } from "@/components/agents/create-agent";
import { LaunchAgent } from "@/components/agents/launch-agent";
import { ProjectCards } from "@/components/agents/project-cards";
import { ProjectPanel } from "@/components/agents/project-panel";
import { ProvidersPanel } from "@/components/agents/providers-panel";
import { ToolsTable } from "@/components/agents/tools-table";
import { PageFreshness } from "@/components/freshness/freshness-indicator";
import { PageHeader } from "@/components/page-header";
import { Panel, primaryButtonClass, quietButtonClass } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { BOT_VIEW_KEYS } from "@/lib/agents/bots-view";
import { EMPTY_STEPS, notConnectedWords } from "@/lib/agents/view";
import { messageOf } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { convexSiteOrigin, mcpUrlOf } from "@/lib/work/ingest-url";

// Where a project's package calls: this deployment's own HTTP origin
// (`*.convex.site`), fixed at build time. Not the app's public origin: the
// pass-through there does not carry /agents/v1.
const SITE_URL = convexSiteOrigin({
  siteUrl: process.env.NEXT_PUBLIC_CONVEX_SITE_URL,
  convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL,
});

// The agent endpoint's public address (as Settings › Connections shows it),
// from which each bot's own connector address is made: `<this>/bot/<id>`.
const MCP_URL = mcpUrlOf({
  osUrl: process.env.NEXT_PUBLIC_OS_URL,
  siteUrl: process.env.NEXT_PUBLIC_CONVEX_SITE_URL,
  convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL,
});

function Loading() {
  return (
    <div className="space-y-6" aria-busy>
      <Skeleton className="h-32 rounded-card" />
      <Skeleton className="h-64 rounded-card" />
    </div>
  );
}

function Block({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  const id = useId();
  return (
    <Panel aria-labelledby={id} className="min-w-0">
      <h2 id={id} className="text-base">
        {title}
      </h2>
      {note !== undefined && <p className="mt-1 max-w-3xl text-xs text-ink-2">{note}</p>}
      <div className="mt-4">{children}</div>
    </Panel>
  );
}

type Opened = "connect" | "launch" | "create" | null;

/** Reads the address (which project and agent are open), so it sits under the page's Suspense boundary. */
function Agents() {
  const { can, isOwner } = useViewer();
  const allowed = can("agents");
  const now = useNow();
  const today = now === null ? null : dayOf(now);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const project = params.get("project");
  const scope = project === null || project === INTERNAL_PROJECT ? undefined : project;

  // Convex refuses all of these without the agents area, so none is sent without it.
  const projects = useQuery(api.agentProjects.list, allowed && today !== null ? { today } : "skip");
  const internal = useQuery(api.agentProjects.startupOs, allowed && isOwner && today !== null ? { today } : "skip");
  const data = useQuery(
    api.agentControl.overview,
    allowed && today !== null ? (scope === undefined ? { today } : { today, project: scope }) : "skip",
  );
  const changes = useQuery(api.agentControl.changes, allowed ? (scope === undefined ? {} : { project: scope }) : "skip");
  // Agents built to run in Startup OS itself (v1.3), on its own card's view.
  const builtHere = useQuery(
    api.agentControl.overview,
    allowed && today !== null && project === INTERNAL_PROJECT ? { today, project: INTERNAL_PROJECT } : "skip",
  );
  const change = useMutation(api.agentControl.change);
  const resend = useMutation(api.agentControl.resend);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<Opened>(null);
  const [fresh, setFresh] = useState<{ name: string; slug: string; token: string } | null>(null);
  // The tab a newly created agent opens on.
  const [openOn, setOpenOn] = useState<DetailTab>("overview");

  if (projects === undefined || data === undefined || changes === undefined || now === null || today === null) {
    return <Loading />;
  }
  const internalCard = isOwner ? (internal ?? null) : null;

  // The open project and agent are the address, so a view can be shared and Back closes it.
  // `in` is the open agent's project, when every project's agents are shown.
  const go = (next: Partial<Record<"project" | "agent" | "in", string | null>>) => {
    const query = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value === null) query.delete(key);
      else if (value !== undefined) query.set(key, value);
    }
    const text = query.toString();
    router.replace(text === "" ? pathname : `${pathname}?${text}`, { scroll: false });
  };
  const selectedAgent = params.get("agent");
  const agentProject = project ?? (selectedAgent === null ? null : (params.get("in") ?? LEGACY_PROJECT));

  const toggle = async (row: AgentRow, on: boolean) => {
    setBusy(agentKey(row));
    setError(null);
    try {
      await change({ project: row.project, agentId: row.agentId, enabled: on });
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(null);
    }
  };

  // Startup OS's own rows say its name, as every project's do: never the slug.
  const names = new Map([...projects.map((p) => [p.slug, p.name] as const), [INTERNAL_PROJECT, INTERNAL_PROJECT_NAME] as const]);
  const current = projects.find((p) => p.slug === project) ?? null;
  const legacyInView = scope === undefined || scope === LEGACY_PROJECT;
  const legacyCard = projects.find((p) => p.slug === LEGACY_PROJECT);
  const showSteering =
    featureOn("verticalStartupAgents") && legacyInView && legacyCard !== undefined && !legacyCard.connected && !data.steering.connected;
  const waiting = changes.some((row) => row.status === "failed" && row.project === LEGACY_PROJECT);
  const nothingYet = projects.length === 0 && !data.pushed;
  // The owner's own tab: the external bots that call Startup OS (convex/bots.ts).
  const view = isOwner && params.get("view") === "bots" ? "bots" : "agents";
  const tabs = isOwner && (
    <div role="tablist" aria-label="Agents or bots" className="flex gap-1">
      {(["agents", "bots"] as const).map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          aria-selected={view === tab}
          onClick={() => {
            const query = new URLSearchParams(params.toString());
            if (tab === "bots") query.set("view", "bots");
            else {
              query.delete("view");
              // The bots' own view (filter, search, open bot) goes with the tab.
              for (const key of BOT_VIEW_KEYS) query.delete(key);
            }
            const text = query.toString();
            router.replace(text === "" ? pathname : `${pathname}?${text}`, { scroll: false });
          }}
          className={cn(
            "h-9 rounded-full px-4 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            view === tab ? "bg-brand-fill text-on-brand" : "text-ink-2 hover:bg-surface hover:text-ink",
          )}
        >
          {tab === "agents" ? "Agents" : "Bots"}
        </button>
      ))}
    </div>
  );
  if (view === "bots") {
    return (
      <>
        {tabs}
        <BotsTab now={now} mcpUrl={MCP_URL} />
      </>
    );
  }

  const actions = (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        aria-expanded={opened === "connect"}
        onClick={() => setOpened(opened === "connect" ? null : "connect")}
        className={nothingYet ? primaryButtonClass : cn(quietButtonClass, "bg-surface text-ink")}
      >
        Connect a project
      </button>
      <button
        type="button"
        aria-expanded={opened === "create"}
        onClick={() => setOpened(opened === "create" ? null : "create")}
        className={nothingYet ? cn(quietButtonClass, "bg-surface text-ink") : primaryButtonClass}
      >
        Create agent
      </button>
      {!nothingYet && (
        <button
          type="button"
          aria-expanded={opened === "launch"}
          onClick={() => setOpened(opened === "launch" ? null : "launch")}
          className={cn(quietButtonClass, "bg-surface text-ink")}
        >
          Launch agent
        </button>
      )}
    </div>
  );

  return (
    <>
      {nothingYet && (
        <Panel>
          <ol className="max-w-3xl list-decimal space-y-1 pl-5 text-sm text-ink-2">
            {EMPTY_STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </Panel>
      )}

      {tabs}

      {actions}

      {fresh !== null && (
        <Panel aria-label="New token" className="min-w-0">
          <TokenReveal name={fresh.name} token={fresh.token} siteUrl={SITE_URL} onDone={() => setFresh(null)} />
        </Panel>
      )}

      {opened === "connect" && (
        <Block title="Connect a project" note={`The project gets a token, shown once. Its agents run inside it: ${PRODUCT.name} keeps their configuration and daily totals, never patient data.`}>
          <ConnectProject
            taken={projects.map((p) => p.slug)}
            onCancel={() => setOpened(null)}
            onConnected={(made) => {
              setFresh(made);
              setOpened(null);
              go({ project: made.slug, agent: null });
            }}
          />
        </Block>
      )}

      {opened === "create" && (
        <Block
          title="Create an agent"
          note={`Built here, from scratch: it runs in a connected project, from its package, or in ${PRODUCT.name} itself. It starts as a draft; set its instructions, tools and triggers on its Builder tab, test it and publish it.`}
        >
          <CreateAgent
            projects={projects.map((p) => ({
              slug: p.slug,
              name: p.name,
              holdsPatientData: p.holdsPatientData,
              allowedProviders: p.allowedProviders,
            }))}
            initial={project}
            onCancel={() => setOpened(null)}
            onCreated={(slug, agentId) => {
              setOpened(null);
              setOpenOn("builder");
              go({ project: slug, agent: agentId, in: null });
            }}
          />
        </Block>
      )}

      {opened === "launch" && (
        <Block title="Launch an agent">
          <LaunchAgent
            projects={projects.map((p) => ({ slug: p.slug, name: p.name }))}
            initial={scope ?? null}
            onCancel={() => setOpened(null)}
            onLaunched={(slug, agentId) => {
              setOpened(null);
              go({ project: slug, agent: agentId });
            }}
          />
        </Block>
      )}

      {(projects.length > 0 || internalCard !== null) && (
        <ProjectCards
          projects={projects}
          internal={internalCard}
          selected={project}
          now={now}
          onSelect={(slug) => go({ project: slug, agent: null, in: null })}
        />
      )}

      {current !== null && (
        <Panel aria-label={current.name} className="min-w-0">
          <ProjectPanel project={current} now={now} onToken={setFresh} />
        </Panel>
      )}

      {project === INTERNAL_PROJECT && internalCard !== null ? (
        <>
          <Block
            title={`${PRODUCT.name}'s agents`}
            note={`Its own four (the chief of staff, the engineering manager, sales, finance) and any built on this page to run here, on its own tools, never with patient data. Each of the four runs on Claude on your Mac or on Gemini in ${PRODUCT.name}, as you choose on its Overview tab; their instructions, tools and schedule are edited, tested and published like any agent's. A switch here is the one on the Assistant page.`}
          >
            {builtHere === undefined ? (
              <Skeleton className="h-24 rounded-inner" />
            ) : builtHere.agents.length === 0 ? (
              <p className="text-sm text-ink-3">None yet. Its own four appear once you have signed in; to add one, Create agent, then choose {PRODUCT.name}.</p>
            ) : (
              <AgentsTable
                label={`${PRODUCT.name}'s agents`}
                rows={builtHere.agents}
                selected={selectedAgent === null ? null : `${INTERNAL_PROJECT}/${selectedAgent}`}
                busy={busy}
                onSelect={(row) => go({ agent: row.agentId })}
                onToggle={toggle}
              />
            )}
            {error !== null && (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {error}
              </p>
            )}
          </Block>
          {selectedAgent !== null && (
            <Panel aria-label={`Agent ${selectedAgent}`} className="min-w-0">
              <AgentDetail
                key={`${INTERNAL_PROJECT}/${selectedAgent}`}
                project={INTERNAL_PROJECT}
                agentId={selectedAgent}
                today={today}
                now={now}
                initialTab={openOn}
                onClose={() => {
                  setOpenOn("overview");
                  go({ agent: null, in: null });
                }}
              />
            </Panel>
          )}
          <Block title={`${PRODUCT.name}'s tools`} note="What an agent built to run here may use: the owner's agent tools, each with the page it needs.">
            <ToolsTable project={INTERNAL_PROJECT} now={now} />
          </Block>
        </>
      ) : (
        !nothingYet && (
          <>
            {showSteering && (
              <p className="rounded-inner bg-info-soft px-4 py-2 text-sm text-info-ink">
                {notConnectedWords(data.steering.missing)}
              </p>
            )}

            <Block
              title="Agents"
              note="The last seven days of calls, errors and the worst day's p95; cost today and this month. A figure the project did not report is left blank, never counted as zero."
            >
              {data.agents.length === 0 ? (
                <p className="text-sm text-ink-3">No agent has reported or been launched yet.</p>
              ) : (
                <AgentsTable
                  rows={data.agents}
                  projectNames={scope === undefined ? names : undefined}
                  selected={selectedAgent === null || agentProject === null ? null : `${agentProject}/${selectedAgent}`}
                  busy={busy}
                  onSelect={(row) =>
                    scope === undefined
                      ? go({ agent: row.agentId, in: row.project })
                      : go({ agent: row.agentId })
                  }
                  onToggle={toggle}
                />
              )}
              {error !== null && (
                <p role="alert" className="mt-3 text-sm text-destructive">
                  {error}
                </p>
              )}
            </Block>

            {selectedAgent !== null && agentProject !== null && (
              <Panel aria-label={`Agent ${selectedAgent}`} className="min-w-0">
                <AgentDetail
                  key={`${agentProject}/${selectedAgent}`}
                  project={agentProject}
                  agentId={selectedAgent}
                  today={today}
                  now={now}
                  initialTab={openOn}
                  onClose={() => {
                    setOpenOn("overview");
                    go({ agent: null, in: null });
                  }}
                />
              </Panel>
            )}

            <Block title="Providers" note={PATIENT_DATA_NOTE}>
              {scope !== undefined ? (
                <ProvidersPanel rows={data.providers} now={now} note={false} />
              ) : data.providers.length === 0 ? (
                <p className="text-sm text-ink-3">No project has reported a provider yet.</p>
              ) : (
                <div className="space-y-6">
                  {[...new Set(data.providers.map((row) => row.project))].map((slug) => (
                    <section key={slug} aria-label={names.get(slug) ?? slug} className="space-y-2">
                      <h3 className="text-sm font-medium text-ink">{names.get(slug) ?? slug}</h3>
                      <ProvidersPanel rows={data.providers.filter((row) => row.project === slug)} now={now} note={false} />
                    </section>
                  ))}
                </div>
              )}
            </Block>

            <Block
              title="Changes"
              note="Each launch or change is a new version of its project's config. The project fetches it; it is pending until the project says it applied that version."
            >
              {changes.length === 0 ? (
                <p className="text-sm text-ink-3">Nothing has been changed from here yet.</p>
              ) : (
                <div className="space-y-3">
                  {waiting && data.steering.connected && (
                    <button type="button" onClick={() => void resend({})} className={quietButtonClass}>
                      Send Vertical Startup&apos;s latest config again
                    </button>
                  )}
                  <ChangeLog rows={changes} now={now} projectNames={scope === undefined ? names : undefined} />
                </div>
              )}
            </Block>
          </>
        )
      )}

      <div className="max-w-3xl space-y-1.5 text-xs leading-relaxed text-ink-2">
        <p>
          Each project&apos;s agents run inside it. It reports daily totals for each agent by prompt version, provider and
          model: calls, errors, schema failures, fallbacks, refusals, tokens, cost and latency. Ids and numbers only:
          never a patient, a prompt or an answer. What goes back is configuration: each agent&apos;s switch, model,
          fallback and budget.
        </p>
      </div>
    </>
  );
}

export default function AgentsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Agents"
        purpose="Every project's AI agents: connect a project, launch its agents, and watch the model each runs on, what it costs and how it is doing."
        aside={<PageFreshness page="agents" />}
      />
      <Suspense fallback={<Loading />}>
        <Agents />
      </Suspense>
    </div>
  );
}
