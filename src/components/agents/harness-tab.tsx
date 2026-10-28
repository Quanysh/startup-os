"use client";

import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useId, useRef, useState, type FormEvent } from "react";
import { api } from "@convex/_generated/api";
import {
  MAX_NOTE_LENGTH,
  PARAM_BOUNDS,
  PARAM_KEYS,
  codeVariantsOf,
  effectiveOf,
  harnessProblems,
  inputOf,
  partsAgainst,
  variantNames,
  type Effective,
  type HarnessDefaults,
  type PromptInput,
  type Variants,
} from "@convex/lib/agentHarness";
import { GATE_WORDS } from "@convex/lib/agentJobs";
import { fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import { KindTag } from "@/components/ui/status-chip";
import { PARAM_HINTS, changedParts, paramsFromText, paramsText, partsWords, prettyJson, problemsByVariant } from "@/lib/agents/harness";
import { messageOf } from "@/lib/errors";
import { atWords } from "@/lib/source-freshness";
import { cn } from "@/lib/utils";
import { GateChip, ProblemList, SECTION_NOTE, TemplateField, VariantDiffs, VariantSwitcher } from "./harness-parts";

export type HarnessView = NonNullable<FunctionReturnType<typeof api.agentHarness.harness>>;
type Draft = NonNullable<HarnessView["draft"]>;

const BUILT_IN_PROMPT = "Using the project's built-in prompt.";

/** The code's defaults in one paragraph: what it declares, and what it does not. */
function DefaultsNote({ defaults }: { defaults: HarnessDefaults | null }) {
  if (defaults === null) {
    return (
      <p className="text-sm text-ink-2">
        The project has not reported this agent&apos;s harness yet. A draft can still be written; its rules are checked
        once the code declares its defaults.
      </p>
    );
  }
  const variants = variantNames(codeVariantsOf(defaults) ?? {});
  const said = [
    defaults.prompt === undefined
      ? "No prompt template declared"
      : `Prompt ${defaults.prompt.version}, ${defaults.prompt.variables.length} variable${defaults.prompt.variables.length === 1 ? "" : "s"}${variants.length > 1 ? `, ${variants.length} variants` : ""}${inputOf(defaults) === "messages" ? ", its own conversation" : ""}`,
    defaults.tools === undefined || defaults.tools.length === 0
      ? "no tools"
      : `${defaults.tools.length} tool${defaults.tools.length === 1 ? "" : "s"}`,
    defaults.output === undefined ? "free-text output" : `output schema ${defaults.output.schemaVersion}`,
  ];
  return <p className="text-sm text-ink-2">{`The code declares: ${said.join(", ")}.`}</p>;
}

/** What is live now: the published version, or the code's own harness. */
function PublishedSummary({ view, now }: { view: HarnessView; now: number }) {
  const published = view.published;
  if (published === null) {
    return (
      <p className="text-sm text-ink">
        Nothing is published: the agent runs the project&apos;s built-in harness. {BUILT_IN_PROMPT}
      </p>
    );
  }
  return (
    <div className="space-y-1">
      <p className="text-sm text-ink">
        <span className="font-medium">{published.name}</span>
        {` is published. ${partsWords(changedParts(published.parts))}.`}
      </p>
      {published.parts.prompt === undefined && <p className="text-xs text-ink-2">{BUILT_IN_PROMPT}</p>}
      <p className="text-xs text-ink-2">
        {`Published by ${published.publishedBy ?? "someone"}${published.publishedAt === null ? "" : `, ${atWords(published.publishedAt, now)}`}${published.note === "" ? "" : `. ${published.note}`}`}
      </p>
    </div>
  );
}

type EditorState = {
  /** Every variant as the editor holds it: the draft's, and any the code declares that the draft lacks. */
  variants: Variants;
  params: Record<string, string>;
  /** null: the code's own choice, untouched. */
  tools: string[] | null;
  schema: string;
  note: string;
};

/**
 * The variants to edit: the draft's (or the code's) as they would run, with
 * any the code declares and the draft lacks added from the code, a user
 * template in each for an agent that sends one user turn and none for one
 * that sends its own conversation.
 */
function editorVariants(draft: Draft, defaults: HarnessDefaults | null): Variants {
  const input = inputOf(defaults);
  const running = effectiveOf(draft.parts, defaults).prompt?.variants ?? {};
  const code = codeVariantsOf(defaults) ?? (Object.keys(running).length > 0 ? {} : { default: { system: "", user: "" } });
  const all = { ...code, ...running };
  return Object.fromEntries(
    variantNames(all).map((name) => {
      const variant = all[name]!;
      return [name, input === "messages" ? { system: variant.system } : { system: variant.system, user: variant.user ?? "" }];
    }),
  );
}

function initialState(draft: Draft, defaults: HarnessDefaults | null): EditorState {
  const effective = effectiveOf(draft.parts, defaults);
  return {
    variants: editorVariants(draft, defaults),
    params: paramsText(effective.params),
    tools: effective.tools,
    schema: prettyJson(effective.outputSchema),
    note: draft.note,
  };
}

/** The editor's state as every part would run: a part neither the code nor the draft has stays null. */
function effectiveFrom(state: EditorState, hasPrompt: boolean): Effective {
  return {
    prompt: hasPrompt ? { variants: state.variants } : null,
    params: paramsFromText(state.params),
    tools: state.tools,
    outputSchema: state.schema.trim() === "" ? null : state.schema,
  };
}

/** The open draft: prompt, parameters, tools and schema, its rules as they are typed, and saving. */
/** The words for an agent that sends its own conversation. */
export const MESSAGES_NOTE = "This agent sends its own conversation; only the system prompt is editable.";

function DraftEditor({ view, draft }: { view: HarnessView; draft: Draft }) {
  const save = useMutation(api.agentHarness.saveDraft);
  const discard = useMutation(api.agentHarness.discardDraft);
  const defaults = view.defaults;
  const [state, setState] = useState<EditorState>(() => initialState(draft, defaults));
  const [initial] = useState(() => JSON.stringify(initialState(draft, defaults)));
  const [status, setStatus] = useState<{ busy: boolean; error: string | null; saved: boolean }>({
    busy: false,
    error: null,
    saved: false,
  });
  const systemRef = useRef<HTMLTextAreaElement>(null);
  const userRef = useRef<HTMLTextAreaElement>(null);
  const input: PromptInput = inputOf(defaults);
  const lastFocused = useRef<"system" | "user">(input === "messages" ? "system" : "user");
  const names = variantNames(state.variants);
  const [current, setCurrent] = useState(() => names[0] ?? "default");
  const id = useId();

  const hasPrompt = defaults?.prompt !== undefined || draft.parts.prompt !== undefined;
  const declared = codeVariantsOf(defaults);
  const notDeclared = declared === null ? [] : names.filter((name) => declared[name] === undefined);
  const variant = state.variants[current] ?? { system: "", user: "" };
  const effective = effectiveFrom(state, hasPrompt);
  const parts = partsAgainst(effective, defaults);
  const problems = harnessProblems(parts, { defaults, patientProviders: view.patientProviders });
  const dirty = JSON.stringify(state) !== initial;
  const set = (next: Partial<EditorState>) => {
    setState((before) => ({ ...before, ...next }));
    setStatus((before) => ({ ...before, saved: false }));
  };

  const setTemplate = (which: "system" | "user", text: string) =>
    set({ variants: { ...state.variants, [current]: { ...variant, [which]: text } } });

  const insert = (name: string) => {
    const which = input === "messages" ? "system" : lastFocused.current;
    const field = which === "system" ? systemRef.current : userRef.current;
    const text = variant[which] ?? "";
    const at = field?.selectionStart ?? text.length;
    const end = field?.selectionEnd ?? at;
    setTemplate(which, `${text.slice(0, at)}{{${name}}}${text.slice(end)}`);
    requestAnimationFrame(() => field?.focus());
  };

  const removeVariant = (name: string) => {
    const { [name]: _gone, ...rest } = state.variants;
    set({ variants: rest });
    setCurrent(variantNames(rest)[0] ?? "default");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setStatus({ busy: true, error: null, saved: false });
    try {
      await save({
        id: draft.id,
        revision: draft.revision,
        prompt: effective.prompt,
        params: effective.params,
        tools: effective.tools,
        outputSchema: effective.outputSchema,
        note: state.note,
      });
      setStatus({ busy: false, error: null, saved: true });
    } catch (failure) {
      setStatus({ busy: false, error: messageOf(failure), saved: false });
    }
  };

  const published = view.published;
  const against = effectiveOf(published?.parts ?? {}, defaults);
  const againstName = published === null ? "the project's built-in harness" : published.name;
  const outputProblems = problems.filter((issue) => issue.path.startsWith("output"));
  const toolsDeclared = defaults?.tools ?? [];
  const variables = defaults?.prompt?.variables ?? [];

  return (
    <form onSubmit={submit} className="space-y-6">
      <section aria-labelledby={`${id}-prompt`} className="space-y-3">
        <h4 id={`${id}-prompt`} className="text-sm font-medium text-ink">
          Prompt
        </h4>
        {!hasPrompt ? (
          <p className="text-sm text-ink-2">No prompt template declared: the code builds its prompt itself.</p>
        ) : (
          <>
            {draft.parts.prompt === undefined && <p className="text-xs text-ink-2">{BUILT_IN_PROMPT}</p>}
            <p className="text-xs text-ink-2">
              A template, never a patient&apos;s words: the project fills each variable in. Use{" "}
              <code className="font-mono">{"{{name}}"}</code>, exactly.
            </p>
            {input === "messages" && <p className="rounded-inner bg-info-soft px-3 py-2 text-sm text-info-ink">{MESSAGES_NOTE}</p>}
            {names.length > 1 && (
              <div className="space-y-1">
                <p className="text-xs text-ink-2">
                  The code picks one variant at each call. Every variant it declares is published together: edit any, drop
                  none.
                </p>
                <VariantSwitcher
                  names={names}
                  current={current}
                  problems={problemsByVariant(problems)}
                  notDeclared={notDeclared}
                  onPick={setCurrent}
                />
              </div>
            )}
            {notDeclared.includes(current) && (
              <p className="text-sm text-ink-2">
                {`The code does not declare ${current}: it cannot be published. `}
                <button type="button" onClick={() => removeVariant(current)} className="text-ink underline underline-offset-2">
                  Remove it
                </button>
              </p>
            )}
            {variables.length > 0 && (
              <div className="flex flex-wrap items-center gap-2" aria-label="Variables">
                <span className="text-xs text-ink-2">Insert a variable:</span>
                {variables.map((variable) => (
                  <button
                    key={variable.name}
                    type="button"
                    onClick={() => insert(variable.name)}
                    className="rounded-md bg-surface px-2 py-0.5 font-mono text-xs text-ink outline-none hover:bg-info-soft focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    {`{{${variable.name}}}`}
                    {variable.required && <span className="ml-1 font-sans text-ink-2">required</span>}
                  </button>
                ))}
              </div>
            )}
            <TemplateField
              key={`${current}-system`}
              id={`${id}-system`}
              label={names.length > 1 ? `System, ${current}` : "System"}
              fieldRef={systemRef}
              value={variant.system}
              invalid={problems.some((issue) => issue.path === `prompt.${current}.system`)}
              onFocus={() => (lastFocused.current = "system")}
              onChange={(text) => setTemplate("system", text)}
            />
            {input === "text" && (
              <TemplateField
                key={`${current}-user`}
                id={`${id}-user`}
                label={names.length > 1 ? `User, ${current}` : "User"}
                fieldRef={userRef}
                value={variant.user ?? ""}
                rows={6}
                invalid={problems.some((issue) => issue.path === `prompt.${current}.user`)}
                onFocus={() => (lastFocused.current = "user")}
                onChange={(text) => setTemplate("user", text)}
              />
            )}
            <p className="text-xs text-ink-2">{SECTION_NOTE}</p>
            <details className="space-y-2">
              <summary className="cursor-pointer text-sm text-ink-2 hover:text-ink">
                {`Changes against ${againstName}, by variant`}
              </summary>
              <VariantDiffs before={against.prompt?.variants ?? {}} after={state.variants} />
            </details>
          </>
        )}
      </section>

      <section aria-labelledby={`${id}-params`} className="space-y-3">
        <h4 id={`${id}-params`} className="text-sm font-medium text-ink">
          Model parameters
        </h4>
        <p className="text-xs text-ink-2">
          Published parameters replace the code&apos;s whole set, so every one is here; leave a field blank to send none.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {PARAM_KEYS.map((key) => (
            <label key={key} className="min-w-0 text-sm text-ink" htmlFor={`${id}-${key}`}>
              {PARAM_BOUNDS[key].label}
              <input
                id={`${id}-${key}`}
                inputMode="decimal"
                value={state.params[key] ?? ""}
                placeholder={PARAM_HINTS[key]}
                aria-invalid={problems.some((issue) => issue.path === `params.${key}`) || undefined}
                onChange={(event) => set({ params: { ...state.params, [key]: event.target.value } })}
                className={`${fieldClass} mt-1 h-10`}
              />
            </label>
          ))}
        </div>
      </section>

      <section aria-labelledby={`${id}-tools`} className="space-y-3">
        <h4 id={`${id}-tools`} className="text-sm font-medium text-ink">
          Tools
        </h4>
        {toolsDeclared.length === 0 ? (
          <p className="text-sm text-ink-2">The code declares no tools.</p>
        ) : (
          <ul className="space-y-2">
            {toolsDeclared.map((tool) => {
              const on = (state.tools ?? []).includes(tool.id);
              return (
                <li key={tool.id}>
                  <label className="flex items-start gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(event) => {
                        const now = new Set(state.tools ?? []);
                        if (event.target.checked) now.add(tool.id);
                        else now.delete(tool.id);
                        set({ tools: toolsDeclared.map((t) => t.id).filter((t) => now.has(t)) });
                      }}
                      className="mt-0.5 size-4 shrink-0 accent-brand"
                    />
                    <span className="min-w-0">
                      <span className="font-medium">{tool.name}</span>{" "}
                      <code className="font-mono text-xs text-ink-2">{tool.id}</code>
                      {tool.phi && (
                        <span className="ml-2">
                          <KindTag tone="sand">Handles patient data</KindTag>
                        </span>
                      )}
                      {tool.kind === "provider" && (
                        <span className="ml-2">
                          <KindTag tone="slate">Built into the provider: skipped in test runs</KindTag>
                        </span>
                      )}
                      {tool.description !== "" && <span className="block text-xs text-ink-2">{tool.description}</span>}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        {state.tools === null && toolsDeclared.length > 0 && (
          <p className="text-xs text-ink-2">The code has not said which tools are on by default; none is switched on here.</p>
        )}
      </section>

      <section aria-labelledby={`${id}-schema`} className="space-y-3">
        <h4 id={`${id}-schema`} className="text-sm font-medium text-ink">
          Output schema
        </h4>
        {defaults?.output === undefined && state.schema.trim() === "" ? (
          <p className="text-sm text-ink-2">Free-text output: the code declares no schema.</p>
        ) : (
          <>
            <p className="text-xs text-ink-2">
              It may add optional properties, widen an enum and change descriptions. Every property the code requires
              stays required, with its type. An incompatible schema can be neither tested nor published.
            </p>
            <label className="block text-sm text-ink" htmlFor={`${id}-schema-text`}>
              JSON Schema
              <textarea
                id={`${id}-schema-text`}
                rows={10}
                value={state.schema}
                spellCheck={false}
                aria-invalid={outputProblems.length > 0 || undefined}
                onChange={(event) => set({ schema: event.target.value })}
                className={`${fieldClass} mt-1 py-2 font-mono text-xs`}
              />
            </label>
            <ProblemList issues={outputProblems} empty="Compatible with the code's schema." />
          </>
        )}
      </section>

      <label className="block text-sm text-ink" htmlFor={`${id}-note`}>
        Note
        <input
          id={`${id}-note`}
          value={state.note}
          maxLength={MAX_NOTE_LENGTH}
          placeholder="Why this version"
          onChange={(event) => set({ note: event.target.value })}
          className={`${fieldClass} mt-1 h-10`}
        />
      </label>

      <ProblemList issues={problems.filter((issue) => !issue.path.startsWith("output"))} />

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={status.busy || !dirty} className={primaryButtonClass}>
          {status.busy ? "Saving…" : "Save draft"}
        </button>
        <button
          type="button"
          onClick={() => void discard({ id: draft.id }).catch((failure) => setStatus({ busy: false, error: messageOf(failure), saved: false }))}
          className={quietButtonClass}
        >
          Discard draft
        </button>
        {dirty && <p className="text-sm text-ink-2">Not saved yet.</p>}
        {status.saved && !dirty && <p className="text-sm text-ink-2">Saved. A changed draft needs a new test run.</p>}
        {status.error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {status.error}
          </p>
        )}
      </div>
    </form>
  );
}

/** Publishing: the gate, the button for those who may, and the owner's override with a reason. */
export function PublishBlock({ view, draft }: { view: NonNullable<HarnessView>; draft: NonNullable<HarnessView["draft"]> }) {
  const publish = useMutation(api.agentHarness.publish);
  const [override, setOverride] = useState<string | null>(null);
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: string | null }>({
    busy: false,
    error: null,
    done: null,
  });
  const id = useId();
  const go = async (reason?: string) => {
    setState({ busy: true, error: null, done: null });
    try {
      const result = await publish(reason === undefined ? { id: draft.id } : { id: draft.id, overrideReason: reason });
      setState({
        busy: false,
        error: null,
        done: `${result.version} is published in config version ${result.configVersion}. It is pending until the project applies it.`,
      });
    } catch (failure) {
      setState({ busy: false, error: messageOf(failure), done: null });
    }
  };
  const blocked = draft.problems.length > 0;
  return (
    <section aria-labelledby={id} className="space-y-3 rounded-inner bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h4 id={id} className="text-sm font-medium text-ink">
          Publish
        </h4>
        <GateChip gate={draft.gate} />
      </div>
      <p className="text-sm text-ink-2">{GATE_WORDS[draft.gate]}</p>
      {!view.mayPublish ? (
        <p className="text-sm text-ink-2">Publishing and rolling back are for the owner and engineers.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={state.busy || blocked || draft.gate !== "passed"}
            onClick={() => void go()}
            className={primaryButtonClass}
          >
            {`Publish ${draft.name}`}
          </button>
          {view.isOwner && draft.gate !== "passed" && override === null && (
            <button type="button" disabled={blocked} onClick={() => setOverride("")} className={quietButtonClass}>
              Publish without a passing test run
            </button>
          )}
        </div>
      )}
      {override !== null && (
        <div className="space-y-2">
          <label className="block text-sm text-ink" htmlFor={`${id}-reason`}>
            Why it goes live untested (kept with the version)
            <input
              id={`${id}-reason`}
              value={override}
              maxLength={MAX_NOTE_LENGTH}
              onChange={(event) => setOverride(event.target.value)}
              className={`${fieldClass} mt-1 h-10`}
            />
          </label>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              disabled={state.busy || override.trim() === ""}
              onClick={() => void go(override)}
              className={primaryButtonClass}
            >
              Publish anyway
            </button>
            <button type="button" onClick={() => setOverride(null)} className={quietButtonClass}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {state.done !== null && <p className="text-sm text-ink">{state.done}</p>}
      {state.error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
    </section>
  );
}

/** The Harness tab: what is live, and the draft that may replace it. */
export function HarnessTab({ view, now }: { view: HarnessView; now: number }) {
  const start = useMutation(api.agentHarness.newDraft);
  const [error, setError] = useState<string | null>(null);
  const draft = view.draft;
  const begin = async (from: "published" | "default") => {
    setError(null);
    try {
      await start({ project: view.project, agentId: view.agentId, from });
    } catch (failure) {
      setError(messageOf(failure));
    }
  };
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <PublishedSummary view={view} now={now} />
        <DefaultsNote defaults={view.defaults} />
      </div>

      {draft === null ? (
        <div className="flex flex-wrap items-center gap-3">
          {view.published !== null && (
            <button type="button" onClick={() => void begin("published")} className={primaryButtonClass}>
              {`New draft from ${view.published.name}`}
            </button>
          )}
          <button
            type="button"
            onClick={() => void begin("default")}
            className={cn(view.published === null ? primaryButtonClass : quietButtonClass)}
          >
            New draft from the code&apos;s defaults
          </button>
          {error !== null && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-medium text-ink">{`Draft ${draft.name}, revision ${draft.revision}`}</h4>
            <GateChip gate={draft.gate} />
            <span className="text-xs text-ink-2">
              {`Started by ${draft.createdBy}${draft.basedOn === null ? " from the code's defaults" : ` from h${draft.basedOn}`}, ${atWords(draft.createdAt, now)}.`}
            </span>
          </div>
          <DraftEditor key={`${draft.id}:${draft.revision}`} view={view} draft={draft} />
          <PublishBlock view={view} draft={draft} />
        </div>
      )}
    </div>
  );
}
