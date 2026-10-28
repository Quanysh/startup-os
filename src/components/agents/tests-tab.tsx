"use client";

import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useId, useState, type FormEvent } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { providerLabel, PROVIDER_INFO, isKnownProvider } from "@convex/lib/agentControl";
import { OS_AGENT_WORDS } from "@convex/lib/osAgents";
import {
  ASSERT_OPS,
  ASSERT_OP_WORDS,
  MADE_UP_NOTE,
  MAX_MESSAGES,
  MAX_RUN_MODELS,
  MESSAGE_ROLES,
  caseAgentProblems,
  caseProblems,
  type AssertOp,
  type Assertion,
  type CaseMessage,
  type MessageRole,
} from "@convex/lib/agentJobs";
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
  rowActionClass,
} from "@/components/ui/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusChip } from "@/components/ui/status-chip";
import { RUN_STATUS_WORDS, runCountWords } from "@/lib/agents/harness";
import { ms, pairWords } from "@/lib/agents/view";
import { messageOf } from "@/lib/errors";
import { atWords } from "@/lib/source-freshness";
import { JsonFold, ProblemList } from "./harness-parts";

type TestsView = FunctionReturnType<typeof api.agentHarness.tests>;
type CaseRow = TestsView["cases"][number];
type RunRow = TestsView["runs"][number];

const blankAssertion = (): Assertion => ({ path: "$", op: "exists", value: "true" });

const OP_HINT: Record<AssertOp, string> = {
  equals: 'JSON: "73560", 3, true, ["a"]',
  contains: 'JSON: a value the array holds, or text the string holds: "735"',
  exists: "true or false",
  matches: 'A pattern in quotes: "^7\\\\d{4}$". It must match the whole value.',
};

const ROLE_WORDS: Record<MessageRole, string> = { user: "User", assistant: "Assistant" };

/** A case's conversation, for an agent that sends its own: each message's role and text, in order. */
function MessagesEditor({
  id,
  messages,
  onChange,
}: {
  id: string;
  messages: CaseMessage[];
  onChange: (messages: CaseMessage[]) => void;
}) {
  const set = (i: number, next: Partial<CaseMessage>) =>
    onChange(messages.map((message, j) => (j === i ? { ...message, ...next } : message)));
  const nextRole: MessageRole = messages.at(-1)?.role === "user" ? "assistant" : "user";
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm text-ink">Conversation</legend>
      <p className="text-xs text-ink-2">This agent sends its own conversation: made-up messages, in order, text only.</p>
      {messages.map((message, i) => (
        <div key={i} className="grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)_auto]">
          <select
            aria-label={`Message ${i + 1}, role`}
            value={message.role}
            onChange={(event) => set(i, { role: event.target.value as MessageRole })}
            className={`${fieldClass} h-10`}
          >
            {MESSAGE_ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_WORDS[role]}
              </option>
            ))}
          </select>
          <textarea
            id={`${id}-m-${i}`}
            aria-label={`Message ${i + 1}, text`}
            rows={2}
            value={message.content}
            onChange={(event) => set(i, { content: event.target.value })}
            className={`${fieldClass} py-2`}
          />
          <button type="button" onClick={() => onChange(messages.filter((_, j) => j !== i))} className={quietButtonClass}>
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={messages.length >= MAX_MESSAGES}
        onClick={() => onChange([...messages, { role: nextRole, content: "" }])}
        className={quietButtonClass}
      >
        Add a message
      </button>
    </fieldset>
  );
}

/** Add or change one made-up test case. Saved only with the tick. */
function CaseForm({
  project,
  agentId,
  variables,
  variants,
  input,
  subAgentTools,
  editing,
  onDone,
}: {
  project: string;
  agentId: string;
  variables: TestsView["variables"];
  variants: TestsView["variants"];
  input: TestsView["input"];
  /** v1.3: the sub-agents an agent built here may call, by tool id; none for a code agent. */
  subAgentTools: TestsView["subAgentTools"];
  editing: CaseRow | null;
  onDone: () => void;
}) {
  const save = useMutation(api.agentHarness.saveCase);
  const id = useId();
  const names = [...new Set([...variables.map((v) => v.name), ...Object.keys(editing?.variables ?? {})])];
  const [name, setName] = useState(editing?.name ?? "");
  const [values, setValues] = useState<Record<string, string>>(editing?.variables ?? {});
  const [fixtures, setFixtures] = useState(editing?.toolFixtures ?? "");
  const [subFixtures, setSubFixtures] = useState(editing?.subAgentFixtures ?? "");
  const [expect, setExpect] = useState<Assertion[]>(editing?.expect ?? [blankAssertion()]);
  const [variant, setVariant] = useState(editing?.variant ?? "default");
  const [messages, setMessages] = useState<CaseMessage[]>(
    editing?.messages ?? (input === "messages" ? [{ role: "user", content: "" }] : []),
  );
  const [madeUp, setMadeUp] = useState(false);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });

  const filled = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ""));
  const chosenVariant = variant === "default" ? null : variant;
  const conversation = input === "messages" ? messages : null;
  const problems = [
    ...caseProblems({
      name,
      variables: filled,
      toolFixtures: fixtures,
      expect,
      variant: chosenVariant,
      messages: conversation,
      subAgentFixtures: subFixtures,
    }),
    ...caseAgentProblems(name.trim(), { variant: chosenVariant, messages: conversation }, { variants, input }).map(
      (message) => ({ path: "case", message }),
    ),
  ];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setState({ busy: true, error: null });
    try {
      await save({
        project,
        agentId,
        ...(editing === null ? {} : { id: editing.id }),
        name,
        variables: filled,
        toolFixtures: fixtures.trim() === "" ? null : fixtures,
        ...(subAgentTools.length === 0 ? {} : { subAgentFixtures: subFixtures.trim() === "" ? null : subFixtures }),
        expect,
        variant: chosenVariant,
        messages: conversation,
        madeUp,
      });
      onDone();
    } catch (failure) {
      setState({ busy: false, error: messageOf(failure) });
    }
  };

  const setAssertion = (i: number, next: Partial<Assertion>) =>
    setExpect(expect.map((row, j) => (j === i ? { ...row, ...next } : row)));

  return (
    <form onSubmit={submit} className="space-y-4 rounded-inner bg-surface p-4">
      <p className="text-sm font-medium text-ink">{MADE_UP_NOTE}</p>
      <label className="block text-sm text-ink" htmlFor={`${id}-name`}>
        Name
        <input
          id={`${id}-name`}
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          className={`${fieldClass} mt-1 h-10`}
        />
      </label>
      {variants.length > 1 && (
        <label className="block text-sm text-ink" htmlFor={`${id}-variant`}>
          Variant
          <span className="block text-xs text-ink-2">The prompt variant the project runs for this case.</span>
          <select
            id={`${id}-variant`}
            value={variant}
            onChange={(event) => setVariant(event.target.value)}
            className={`${fieldClass} mt-1 h-10 font-mono text-xs`}
          >
            {variants.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
      {input === "messages" && <MessagesEditor id={id} messages={messages} onChange={setMessages} />}
      {names.length === 0 ? (
        <p className="text-xs text-ink-2">The code declares no variables.</p>
      ) : (
        names.map((variable) => {
          const declared = variables.find((v) => v.name === variable);
          return (
            <label key={variable} className="block text-sm text-ink" htmlFor={`${id}-v-${variable}`}>
              <code className="font-mono text-xs">{`{{${variable}}}`}</code>
              {declared?.required === true && <span className="ml-1 text-xs text-ink-2">required</span>}
              {declared === undefined && <span className="ml-1 text-xs text-ink-2">not declared by the code</span>}
              <textarea
                id={`${id}-v-${variable}`}
                rows={3}
                value={values[variable] ?? ""}
                onChange={(event) => setValues({ ...values, [variable]: event.target.value })}
                className={`${fieldClass} mt-1 py-2`}
              />
            </label>
          );
        })
      )}
      <label className="block text-sm text-ink" htmlFor={`${id}-fixtures`}>
        Tool fixtures, optional
        <span className="block text-xs text-ink-2">JSON: each tool id and what it returns in the test.</span>
        <textarea
          id={`${id}-fixtures`}
          rows={3}
          value={fixtures}
          spellCheck={false}
          onChange={(event) => setFixtures(event.target.value)}
          className={`${fieldClass} mt-1 py-2 font-mono text-xs`}
        />
      </label>
      {subAgentTools.length > 0 && (
        <label className="block text-sm text-ink" htmlFor={`${id}-sub-fixtures`}>
          Sub-agent fixtures, optional
          <span className="block text-xs text-ink-2">
            {`JSON: for each sub-agent (${subAgentTools.join(", ")}), its own tools' answers. No tool runs in a test; a sub-agent runs on the case's model.`}
          </span>
          <textarea
            id={`${id}-sub-fixtures`}
            rows={3}
            value={subFixtures}
            spellCheck={false}
            onChange={(event) => setSubFixtures(event.target.value)}
            className={`${fieldClass} mt-1 py-2 font-mono text-xs`}
          />
        </label>
      )}

      <fieldset className="space-y-2">
        <legend className="text-sm text-ink">Expectations</legend>
        <p className="text-xs text-ink-2">
          A path into the output (<code className="font-mono">$.codes[0]</code>), what it must do, and a JSON value.
        </p>
        {expect.map((row, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_10rem_minmax(0,1.5fr)_auto]">
            <input
              aria-label={`Expectation ${i + 1}, path`}
              value={row.path}
              onChange={(event) => setAssertion(i, { path: event.target.value })}
              className={`${fieldClass} h-10 font-mono text-xs`}
            />
            <select
              aria-label={`Expectation ${i + 1}, kind`}
              value={row.op}
              onChange={(event) => setAssertion(i, { op: event.target.value as AssertOp })}
              className={`${fieldClass} h-10`}
            >
              {ASSERT_OPS.map((op) => (
                <option key={op} value={op}>
                  {ASSERT_OP_WORDS[op]}
                </option>
              ))}
            </select>
            <input
              aria-label={`Expectation ${i + 1}, value`}
              value={row.value}
              placeholder={OP_HINT[row.op]}
              title={OP_HINT[row.op]}
              onChange={(event) => setAssertion(i, { value: event.target.value })}
              className={`${fieldClass} h-10 font-mono text-xs`}
            />
            <button
              type="button"
              onClick={() => setExpect(expect.filter((_, j) => j !== i))}
              className={quietButtonClass}
            >
              Remove
            </button>
          </div>
        ))}
        {expect.some((row) => row.op === "matches") && (
          <p className="text-xs text-ink-2">A pattern must match the whole value, with no backreferences or nested quantifiers.</p>
        )}
        <button type="button" onClick={() => setExpect([...expect, blankAssertion()])} className={quietButtonClass}>
          Add an expectation
        </button>
      </fieldset>

      <ProblemList issues={problems} />

      <label className="flex items-start gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={madeUp}
          onChange={(event) => setMadeUp(event.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-brand"
        />
        <span>This case is made-up data, never a real patient.</span>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={state.busy || !madeUp || problems.length > 0} className={primaryButtonClass}>
          {state.busy ? "Saving…" : "Save case"}
        </button>
        <button type="button" onClick={onDone} className={quietButtonClass}>
          Cancel
        </button>
        {state.error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
      </div>
    </form>
  );
}

const modelKey = (pair: { provider: string; model: string }) => `${pair.provider}|${pair.model}`;

/** Start a run of the draft as it is now: models (up to four) and cases. */
function RunForm({ view }: { view: TestsView }) {
  const start = useMutation(api.agentHarness.startRun);
  const [models, setModels] = useState<string[]>(view.choices.slice(0, 1).map(modelKey));
  const [cases, setCases] = useState<string[]>(view.cases.map((c) => c.id));
  const [state, setState] = useState<{ busy: boolean; error: string | null; started: boolean }>({
    busy: false,
    error: null,
    started: false,
  });
  const id = useId();
  const draft = view.draft;
  if (draft === null) return <p className="text-sm text-ink-2">Start a draft on the Harness tab to test it.</p>;
  if (view.cases.length === 0) return <p className="text-sm text-ink-2">Add a made-up case first.</p>;
  if (view.choices.length === 0) {
    return <p className="text-sm text-ink-2">The project has reported no model that is up and allowed for this agent.</p>;
  }
  const toggle = (list: string[], value: string, on: boolean) =>
    on ? [...list, value] : list.filter((item) => item !== value);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setState({ busy: true, error: null, started: false });
    try {
      await start({
        draftId: draft.id,
        models: view.choices.filter((pair) => models.includes(modelKey(pair))),
        caseIds: cases as Id<"agentHarnessCases">[],
      });
      setState({ busy: false, error: null, started: true });
    } catch (failure) {
      setState({ busy: false, error: messageOf(failure), started: false });
    }
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-4 md:grid-cols-2">
        <fieldset className="space-y-2">
          <legend className="text-sm text-ink">{`Models, up to ${MAX_RUN_MODELS}`}</legend>
          {view.choices.map((pair) => {
            const info = isKnownProvider(pair.provider) ? PROVIDER_INFO[pair.provider] : null;
            return (
              <label key={modelKey(pair)} className="flex items-start gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={models.includes(modelKey(pair))}
                  onChange={(event) => setModels(toggle(models, modelKey(pair), event.target.checked))}
                  className="mt-0.5 size-4 shrink-0 accent-brand"
                />
                <span>
                  {pairWords(pair)}
                  {info !== null && !info.patientData && <span className="ml-1 text-xs text-ink-2">(not for patient data)</span>}
                </span>
              </label>
            );
          })}
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="text-sm text-ink">Cases</legend>
          {view.cases.map((row) => (
            <label key={row.id} className="flex items-start gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={cases.includes(row.id)}
                onChange={(event) => setCases(toggle(cases, row.id, event.target.checked))}
                className="mt-0.5 size-4 shrink-0 accent-brand"
              />
              <span>{row.name}</span>
            </label>
          ))}
        </fieldset>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          id={id}
          type="submit"
          disabled={state.busy || models.length === 0 || models.length > MAX_RUN_MODELS || cases.length === 0}
          className={primaryButtonClass}
        >
          {`Test ${draft.name}, revision ${draft.revision}`}
        </button>
        {state.started && <p className="text-sm text-ink-2">Queued. The project picks it up on its next poll.</p>}
        {state.error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
      </div>
    </form>
  );
}

const resultChip = (row: { passed: boolean; error: string | null }) =>
  row.passed ? (
    <StatusChip tone="success">Passed</StatusChip>
  ) : row.error !== null ? (
    <StatusChip tone="danger">{`Error: ${row.error.replace("_", " ")}`}</StatusChip>
  ) : (
    <StatusChip tone="danger">Failed</StatusChip>
  );

const skippedWords = (tools: readonly string[]) => `Skipped: ${tools.join(", ")} (built into the provider)`;

/** One run opened: each case on each model. */
function RunResults({ runId }: { runId: Id<"agentHarnessRuns"> }) {
  const run = useQuery(api.agentHarness.run, { id: runId });
  if (run === undefined) return <Skeleton className="h-32 rounded-inner" />;
  if (run === null) return <p className="text-sm text-ink-3">There is no such run.</p>;
  const rows = run.cases.flatMap((c) =>
    run.models.map((pair) => ({
      key: `${c.caseId}|${modelKey(pair)}`,
      name: c.name,
      variant: c.variant,
      expected: c.expect.length,
      pair,
      result: run.results.find((r) => r.caseId === c.caseId && r.provider === pair.provider && r.model === pair.model) ?? null,
    })),
  );
  const skipped = run.results.some((result) => result.skippedTools.length > 0);
  return (
    <div className="space-y-2">
      {skipped && (
        <p className="text-xs text-ink-2">
          Tools built into the provider are skipped in test runs: a result that needed one was run without it.
        </p>
      )}
      <DataTable label="Results" download="Agent test results" className="min-w-[56rem]">
        <DataHead>
          <DataHeader pinned>Case</DataHeader>
          <DataHeader>Model</DataHeader>
          <DataHeader>Result</DataHeader>
          <DataHeader>Schema</DataHeader>
          <DataHeader numeric>Expectations</DataHeader>
          <DataHeader numeric>Latency</DataHeader>
          <DataHeader numeric>Tokens in, out</DataHeader>
          <DataHeader numeric>Cost</DataHeader>
          <DataHeader>Output (made-up data)</DataHeader>
        </DataHead>
        <DataBody>
          {rows.map(({ key, name, variant, expected, pair, result }) => (
            <DataRow key={key} tone={result !== null && !result.passed ? "danger" : undefined}>
              <DataRowHeader pinned>
                {name}
                {variant !== null && <p className="font-mono text-xs font-normal text-ink-2">{variant}</p>}
              </DataRowHeader>
              <DataCell>
                {pair.model}
                <p className="text-xs text-ink-2">{providerLabel(pair.provider)}</p>
              </DataCell>
              <DataCell>
                {result === null ? <Blank>No answer</Blank> : resultChip(result)}
                {result !== null && result.skippedTools.length > 0 && (
                  <p className="mt-1 text-xs text-ink-2">{skippedWords(result.skippedTools)}</p>
                )}
                {result !== null && result.steps != null && (
                  <p className="mt-1 text-xs text-ink-2">{`${result.steps} step${result.steps === 1 ? "" : "s"}`}</p>
                )}
                {result !== null && result.toolCalls != null && result.toolCalls.length > 0 && (
                  <ul className="mt-1 space-y-0.5 font-mono text-xs text-ink-2">
                    {result.toolCalls.map((call, i) => (
                      <li key={i}>{`${call.toolId}: ${call.status === "skipped" ? "no fixture" : call.status}`}</li>
                    ))}
                  </ul>
                )}
              </DataCell>
              <DataCell>{result === null ? <Blank /> : result.schemaValid ? "Valid" : "Not valid"}</DataCell>
              <DataCell numeric>
                {result === null ? <Blank /> : `${result.assertions.filter((a) => a.passed).length} of ${expected}`}
              </DataCell>
              <DataCell numeric>{result === null ? <Blank /> : ms(result.latencyMs)}</DataCell>
              <DataCell numeric>
                {result === null ? (
                  <Blank />
                ) : (
                  `${result.inputTokens.toLocaleString("en-US")}, ${result.outputTokens.toLocaleString("en-US")}`
                )}
              </DataCell>
              <DataCell numeric>
                {result === null ? <Blank /> : result.costUsd === null ? <Blank>Not priced</Blank> : `$${result.costUsd.toFixed(4)}`}
              </DataCell>
              <DataCell>{result === null ? <Blank /> : <JsonFold summary="Show output" json={result.output} />}</DataCell>
            </DataRow>
          ))}
        </DataBody>
      </DataTable>
    </div>
  );
}

function RunsTable({ runs, now, opened, onOpen }: { runs: readonly RunRow[]; now: number; opened: string | null; onOpen: (id: Id<"agentHarnessRuns"> | null) => void }) {
  return (
    <DataTable label="Test runs" download="Agent test runs" className="min-w-[44rem]">
      <DataHead>
        <DataHeader pinned>Run</DataHeader>
        <DataHeader>Models</DataHeader>
        <DataHeader>Result</DataHeader>
        <DataHeader>By</DataHeader>
        <DataHeader>When</DataHeader>
        <ActionsHeader />
      </DataHead>
      <DataBody>
        {runs.map((run) => (
          <DataRow key={run.id}>
            <DataRowHeader pinned>
              {run.name}
              {run.ofDraftNow && <p className="text-xs font-normal text-ink-2">The draft as it is now</p>}
            </DataRowHeader>
            <DataCell>{run.models.map((pair) => pair.model).join(", ")}</DataCell>
            <DataCell>
              {run.status === "done" ? (
                <StatusChip tone={run.passed === run.expected && run.received === run.expected ? "success" : "danger"}>
                  {runCountWords(run)}
                </StatusChip>
              ) : (
                <StatusChip tone={run.status === "expired" ? "danger" : "info"}>{RUN_STATUS_WORDS[run.status]}</StatusChip>
              )}
            </DataCell>
            <DataCell>{run.createdBy}</DataCell>
            <DataCell className="whitespace-nowrap">{atWords(run.createdAt, now)}</DataCell>
            <DataCell>
              <button type="button" onClick={() => onOpen(opened === run.id ? null : run.id)} className={rowActionClass}>
                {opened === run.id ? "Close" : "Open"}
              </button>
            </DataCell>
          </DataRow>
        ))}
      </DataBody>
    </DataTable>
  );
}

/** The Tests tab: made-up cases, a run of the draft, and runs with their results. */
export function TestsTab({ project, agentId, now }: { project: string; agentId: string; now: number }) {
  const view = useQuery(api.agentHarness.tests, { project, agentId });
  const remove = useMutation(api.agentHarness.removeCase);
  const [editing, setEditing] = useState<CaseRow | "new" | null>(null);
  const [opened, setOpened] = useState<Id<"agentHarnessRuns"> | null>(null);
  if (view === undefined) return <Skeleton className="h-64 rounded-inner" />;
  return (
    <div className="space-y-6">
      <p className="rounded-inner bg-info-soft px-4 py-2 text-sm text-info-ink">{MADE_UP_NOTE}</p>

      <section aria-label="Test cases" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h4 className="text-sm font-medium text-ink">Test cases</h4>
          {editing === null && (
            <button type="button" onClick={() => setEditing("new")} className={quietButtonClass}>
              Add a case
            </button>
          )}
        </div>
        {editing !== null && (
          <CaseForm
            key={editing === "new" ? "new" : editing.id}
            project={project}
            agentId={agentId}
            variables={view.variables}
            variants={view.variants}
            input={view.input}
            subAgentTools={view.subAgentTools}
            editing={editing === "new" ? null : editing}
            onDone={() => setEditing(null)}
          />
        )}
        {view.cases.length === 0 ? (
          <p className="text-sm text-ink-3">No case yet.</p>
        ) : (
          <DataTable label="Test cases" download={false} className="min-w-[40rem]">
            <DataHead>
              <DataHeader pinned>Case</DataHeader>
              <DataHeader>Variables</DataHeader>
              <DataHeader numeric>Expectations</DataHeader>
              <DataHeader>Changed</DataHeader>
              <ActionsHeader />
            </DataHead>
            <DataBody>
              {view.cases.map((row) => (
                <DataRow key={row.id}>
                  <DataRowHeader pinned>
                    {row.name}
                    {(row.variant !== null || row.messages !== null) && (
                      <p className="text-xs font-normal text-ink-2">
                        {[
                          row.variant === null ? null : `Variant ${row.variant}`,
                          row.messages === null ? null : `${row.messages.length} message${row.messages.length === 1 ? "" : "s"}`,
                        ]
                          .filter((part) => part !== null)
                          .join(", ")}
                      </p>
                    )}
                  </DataRowHeader>
                  <DataCell>
                    {Object.keys(row.variables).length === 0 ? <Blank>None</Blank> : Object.keys(row.variables).join(", ")}
                  </DataCell>
                  <DataCell numeric>{row.expect.length}</DataCell>
                  <DataCell className="whitespace-nowrap">{`${row.updatedBy}, ${atWords(row.updatedAt, now)}`}</DataCell>
                  <DataCell>
                    <div className="flex gap-1">
                      <button type="button" onClick={() => setEditing(row)} className={rowActionClass}>
                        Edit
                      </button>
                      <button type="button" onClick={() => void remove({ id: row.id })} className={rowActionClass}>
                        Remove
                      </button>
                    </div>
                  </DataCell>
                </DataRow>
              ))}
            </DataBody>
          </DataTable>
        )}
      </section>

      <section aria-label="Run the tests" className="space-y-3">
        <h4 className="text-sm font-medium text-ink">Run the tests</h4>
        <p className="text-xs text-ink-2">
          The project runs the draft on each model against each case and sends back what came out. A run of a draft that
          changed since does not count for publishing.
        </p>
        {view.runsOn === "claude_mac" ? (
          <p className="max-w-3xl text-sm text-ink-2">{OS_AGENT_WORDS.macTests}</p>
        ) : (
          <RunForm key={`${view.draft?.id ?? "none"}:${view.draft?.revision ?? 0}:${view.cases.length}`} view={view} />
        )}
      </section>

      <section aria-label="Runs" className="space-y-3">
        <h4 className="text-sm font-medium text-ink">Runs</h4>
        {view.runs.length === 0 ? (
          <p className="text-sm text-ink-3">No run yet.</p>
        ) : (
          <RunsTable runs={view.runs} now={now} opened={opened} onOpen={setOpened} />
        )}
        {opened !== null && <RunResults runId={opened} />}
      </section>
    </div>
  );
}
