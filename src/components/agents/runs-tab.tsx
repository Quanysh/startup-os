"use client";

import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useId, useState, type FormEvent } from "react";
import { api } from "@convex/_generated/api";
import { AGENT_RUN_STATUSES, MAX_SCHEDULE_VALUE, RUN_TRIGGERS, type AgentRunStatus, type RunTrigger } from "@convex/lib/agentBuilder";
import { MAX_RUN_MESSAGE, STARTUP_OS_WORDS } from "@convex/lib/agentStartupOs";
import { OS_AGENT_WORDS, RUNS_ON_LINES, RUNS_ON_WORDS, type RunsOn } from "@convex/lib/osAgents";
import { WaitingLink } from "@/components/approvals/waiting-link";
import { fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
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
import { StatusChip } from "@/components/ui/status-chip";
import { RUN_STATUS, TRIGGER_WORDS, durationWords, toolCallWords } from "@/lib/agents/builder";
import { messageOf } from "@/lib/errors";
import { atWords } from "@/lib/source-freshness";

type RunsView = FunctionReturnType<typeof api.agentBuilder.runs>;
type Run = RunsView["runs"][number];
type Child = Run["children"][number];

/** What a published agent takes, for Run now: its variables, or a conversation. */
export type RunInputShape = { mode: "text" | "messages"; variables: { name: string; required: boolean }[] };

/** JSON text shown as indented text; anything else as it is. Always rendered as text. */
function readable(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, 2);
  } catch {
    return text;
  }
}

/** One run as a row; a sub-agent's run sits under the run that called it. */
function RunRow({
  run,
  now,
  child,
  actions = false,
  proposals = false,
  onAnswer,
}: {
  run: Run | Child;
  now: number;
  child?: boolean;
  /** The table has a proposals column (Startup OS's own runs). */
  proposals?: boolean;
  /** The table has an actions column (some answer this viewer may read). */
  actions?: boolean;
  /** Startup OS's own run, for a viewer who may read its answer: open it. */
  onAnswer?: () => void;
}) {
  const status = RUN_STATUS[run.status];
  return (
    <DataRow tone={run.status === "error" || run.status === "timeout" ? "danger" : run.status === "awaiting_approval" ? "warning" : undefined}>
      <DataRowHeader pinned className="font-normal">
        {child === true ? (
          <span className="pl-4 text-ink-2">
            <span aria-hidden>↳ </span>
            <span className="sr-only">Called: </span>
            <code className="font-mono text-xs text-ink">{run.agentId}</code>
          </span>
        ) : (
          <code className="font-mono text-xs">{run.runId}</code>
        )}
        <p className="text-xs text-ink-2">{run.version}</p>
      </DataRowHeader>
      <DataCell className="whitespace-nowrap">{atWords(run.startedAt, now)}</DataCell>
      <DataCell>
        {TRIGGER_WORDS[run.trigger]}
        {run.runner === "mac" && <p className="text-xs text-ink-2">{RUNS_ON_WORDS.claude_mac}</p>}
      </DataCell>
      <DataCell exportValue={status.words}>
        <StatusChip tone={status.tone}>{status.words}</StatusChip>
        {run.errorClass !== null && <p className="mt-1 font-mono text-xs text-ink-2">{run.errorClass}</p>}
      </DataCell>
      <DataCell numeric>{durationWords(run.durationMs)}</DataCell>
      <DataCell numeric>{run.steps}</DataCell>
      <DataCell numeric>{run.costUsd === null ? <Blank>Not priced</Blank> : `$${run.costUsd.toFixed(4)}`}</DataCell>
      {proposals && <DataCell numeric>{run.proposals === null ? <Blank /> : run.proposals}</DataCell>}
      <DataCell>
        {run.toolCalls.length === 0 ? (
          <Blank>None</Blank>
        ) : (
          <ul className="space-y-0.5 text-xs">
            {run.toolCalls.map((call, i) => (
              <li key={i} className="font-mono">
                {toolCallWords(call)}
              </li>
            ))}
          </ul>
        )}
      </DataCell>
      {actions && (
        <DataCell actions>
          {onAnswer !== undefined && run.status !== "awaiting_approval" && (
            <button type="button" onClick={onAnswer} className={quietButtonClass}>
              Answer
            </button>
          )}
        </DataCell>
      )}
    </DataRow>
  );
}

/** Run now (the owner's): a published Startup OS agent started at once, with what is typed here. */
function RunNow({ agentId, input }: { agentId: string; input: RunInputShape | null }) {
  const id = useId();
  const start = useMutation(api.agentRuntime.runNow);
  const [values, setValues] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null; started: boolean }>({ busy: false, error: null, started: false });
  if (input === null) return <p className="text-sm text-ink-2">Publish it first: only a published agent runs.</p>;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setState({ busy: true, error: null, started: false });
    try {
      const variables = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ""));
      await start({ agentId, variables, ...(input.mode === "messages" ? { message } : {}) });
      setState({ busy: false, error: null, started: true });
    } catch (failure) {
      setState({ busy: false, error: messageOf(failure), started: false });
    }
  };
  return (
    <form onSubmit={submit} aria-label="Run now" className="space-y-3">
      {input.mode === "messages" ? (
        <label className="block max-w-xl text-sm text-ink" htmlFor={`${id}-message`}>
          Message
          <textarea
            id={`${id}-message`}
            rows={3}
            maxLength={MAX_RUN_MESSAGE}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className={`${fieldClass} mt-1 py-2`}
          />
        </label>
      ) : (
        input.variables.length > 0 && (
          <div className="grid gap-3 md:grid-cols-2">
            {input.variables.map((variable) => (
              <label key={variable.name} className="min-w-0 text-sm text-ink" htmlFor={`${id}-${variable.name}`}>
                {`${variable.name}${variable.required ? ", required" : ""}`}
                <input
                  id={`${id}-${variable.name}`}
                  maxLength={MAX_SCHEDULE_VALUE}
                  value={values[variable.name] ?? ""}
                  onChange={(e) => setValues({ ...values, [variable.name]: e.target.value })}
                  className={`${fieldClass} mt-1 h-10`}
                />
              </label>
            ))}
          </div>
        )
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={state.busy} className={primaryButtonClass}>
          {state.busy ? "Starting…" : "Run now"}
        </button>
        {state.started && <p className="text-sm text-ink-2">Started. Its run shows below when it ends or waits for you.</p>}
        {state.error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
      </div>
    </form>
  );
}

/**
 * The calls this agent's runs wait on, as one line to /approvals: the one
 * place they are approved or denied (a denial with a reason, as a proposal's
 * rejection). Nothing is decided here.
 */
function WaitingCalls({ agentId }: { agentId: string }) {
  const pending = useQuery(api.agentRuntime.approvals, { agentId });
  if (pending === undefined) return <Skeleton className="h-5 w-40" />;
  if (pending.length === 0) return null;
  return <WaitingLink count={pending.length} href="/approvals?kind=tool_call" />;
}

/** One run's answer, as text: never a renderer. */
function RunAnswer({ runId, onClose }: { runId: string; onClose: () => void }) {
  const answer = useQuery(api.agentRuntime.output, { runId });
  return (
    <section aria-label="The run's answer" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="min-w-0 text-sm font-medium break-all text-ink">{`Answer of ${runId}`}</h4>
        <button type="button" onClick={onClose} className={quietButtonClass}>
          Close
        </button>
      </div>
      {answer === undefined ? (
        <Skeleton className="h-24 rounded-inner" />
      ) : answer === null ? (
        <p className="text-sm text-ink-3">It kept no answer: it ended before giving one.</p>
      ) : (
        <>
          <pre className="max-h-96 overflow-y-auto rounded-inner bg-surface p-3 font-mono text-xs break-words whitespace-pre-wrap text-ink">
            {answer.format === "json" && !answer.truncated ? readable(answer.text) : answer.text}
          </pre>
          {answer.truncated && <p className="text-xs text-ink-2">Cut at 64 KB.</p>}
        </>
      )}
    </section>
  );
}

/**
 * The Runs tab: each run (ids, states and numbers), filtered by state and how
 * it was started, with the sub-agent runs it started under it, and how many
 * tool calls wait on a person. For an agent Startup OS runs itself, the owner
 * also starts it here (Run now) and is led to /approvals for what it waits on
 * ("N waiting → Approvals": decided there alone), and a run's answer opens
 * below the table for whoever may read it.
 */
export function RunsTab({
  project,
  agentId,
  now,
  isOwner = false,
  input = null,
  runsOn = null,
}: {
  project: string;
  agentId: string;
  now: number;
  isOwner?: boolean;
  /** What its published version takes (Startup OS's own agents): Run now's fields. */
  input?: RunInputShape | null;
  /** Startup OS's agents: where it runs. One of the four on the Mac is started there, at its times. */
  runsOn?: RunsOn | null;
}) {
  const id = useId();
  const [status, setStatus] = useState<AgentRunStatus | "">("");
  const [trigger, setTrigger] = useState<RunTrigger | "">("");
  const [opened, setOpened] = useState<string | null>(null);
  const view = useQuery(api.agentBuilder.runs, {
    project,
    agentId,
    ...(status === "" ? {} : { status }),
    ...(trigger === "" ? {} : { trigger }),
  });
  const runsHere = view?.runsHere === true;
  // An answer opens only where what was decided when it was kept lets this viewer read it.
  const answers = view?.runs.some((run) => run.answer || run.children.some((child) => child.answer)) === true;
  const answerOf = (run: { runId: string; answer: boolean }) => (run.answer ? () => setOpened(run.runId) : undefined);
  return (
    <div className="space-y-6">
      {runsHere && isOwner && (
        <section aria-label="Start it" className="space-y-3">
          <h4 className="text-sm font-medium text-ink">Run now</h4>
          {runsOn === "claude_mac" ? (
            <div className="max-w-3xl space-y-1 text-sm text-ink-2">
              <p>{OS_AGENT_WORDS.macRunNow}</p>
              <p className="text-xs">{RUNS_ON_LINES.claude_mac}</p>
            </div>
          ) : (
            <RunNow agentId={agentId} input={input} />
          )}
        </section>
      )}
      {runsHere && isOwner && <WaitingCalls agentId={agentId} />}
      <div className="space-y-4">
        <div className="flex flex-wrap gap-4">
          <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-status`}>
            State
            <select id={`${id}-status`} value={status} onChange={(e) => setStatus(e.target.value as AgentRunStatus | "")} className={`${fieldClass} mt-1 h-10`}>
              <option value="">Any</option>
              {AGENT_RUN_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {RUN_STATUS[s].words}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-trigger`}>
            Started by
            <select id={`${id}-trigger`} value={trigger} onChange={(e) => setTrigger(e.target.value as RunTrigger | "")} className={`${fieldClass} mt-1 h-10`}>
              <option value="">Anything</option>
              {RUN_TRIGGERS.map((t) => (
                <option key={t} value={t}>
                  {TRIGGER_WORDS[t]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {view === undefined ? (
          <Skeleton className="h-48 rounded-inner" />
        ) : (
          <>
            <p className="text-sm text-ink">
              {view.pendingApprovals === 0
                ? "Nothing waits for approval."
                : `${view.pendingApprovals} tool call${view.pendingApprovals === 1 ? "" : "s"} wait${view.pendingApprovals === 1 ? "s" : ""} for approval, in ${view.runsWaiting} run${view.runsWaiting === 1 ? "" : "s"}. ${
                    runsHere ? (isOwner ? STARTUP_OS_WORDS.approvalsHere : "The owner approves them on Approvals.") : "Approvals are given in the project's own app."
                  }`}
            </p>
            {view.runs.length === 0 ? (
              <p className="text-sm text-ink-3">
                {status !== "" || trigger !== ""
                  ? "No run like that."
                  : runsHere
                    ? "No run yet. It runs on its schedule, with Run now, or as another agent's sub-agent."
                    : "No run reported yet. The project sends them with its usage report."}
              </p>
            ) : (
              <DataTable label="Runs" download="Agent runs" className="min-w-[56rem]">
                <DataHead>
                  <DataHeader pinned>Run</DataHeader>
                  <DataHeader>Started</DataHeader>
                  <DataHeader>Started by</DataHeader>
                  <DataHeader>State</DataHeader>
                  <DataHeader numeric>Took</DataHeader>
                  <DataHeader numeric>Steps</DataHeader>
                  <DataHeader numeric>Cost</DataHeader>
                  {runsHere && <DataHeader numeric>Proposals</DataHeader>}
                  <DataHeader>Tool calls</DataHeader>
                  {answers && <ActionsHeader />}
                </DataHead>
                <DataBody>
                  {view.runs.flatMap((run) => [
                    <RunRow key={run.runId} run={run} now={now} actions={answers} proposals={runsHere} onAnswer={answerOf(run)} />,
                    ...run.children.map((child) => (
                      <RunRow
                        key={`${run.runId}/${child.runId}`}
                        run={child}
                        now={now}
                        child
                        actions={answers}
                        proposals={runsHere}
                        onAnswer={answerOf(child)}
                      />
                    )),
                  ])}
                </DataBody>
              </DataTable>
            )}
            {opened !== null && <RunAnswer runId={opened} onClose={() => setOpened(null)} />}
            <p className="text-xs text-ink-2">
              {runsHere
                ? "Kept for ninety days. A run is ids, states and numbers; its answer is kept apart, for whoever may read every page its tools read."
                : "Kept for ninety days. A run is ids, states and numbers: never a prompt, an argument or an answer."}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
