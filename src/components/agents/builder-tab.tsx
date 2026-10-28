"use client";

import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api } from "@convex/_generated/api";
import { providerLabel } from "@convex/lib/agentControl";
import {
  DEFAULT_LIMITS,
  declarativeProblems,
  embedSnippet,
  runPath,
  type CatalogTool,
  type Definition,
} from "@convex/lib/agentBuilder";
import { nextRuns } from "@convex/lib/agentCron";
import {
  DEFAULT_VARIANT,
  MAX_NOTE_LENGTH,
  PARAM_BOUNDS,
  PARAM_KEYS,
  VARIANT_NAME_PATTERN,
  variantNames,
  type Variants,
} from "@convex/lib/agentHarness";
import { PRODUCT } from "@convex/lib/identity";
import { MAC_TOOLS_LINE, RUNS_ON_LINES, type RunsOn } from "@convex/lib/osAgents";
import { STARTUP_OS_WORDS } from "@convex/lib/agentStartupOs";
import { fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { KindTag } from "@/components/ui/status-chip";
import { AREA_WORDS, budgetOf, utcWords, wholeOf } from "@/lib/agents/builder";
import { PARAM_HINTS, paramsFromText, paramsText, problemsByVariant } from "@/lib/agents/harness";
import { messageOf } from "@/lib/errors";
import { atWords } from "@/lib/source-freshness";
import { cn } from "@/lib/utils";
import { GateChip, ProblemList, SECTION_NOTE, TemplateField, VariantSwitcher } from "./harness-parts";
import { PublishBlock, type HarnessView } from "./harness-tab";

type Draft = NonNullable<HarnessView["draft"]>;
type Options = FunctionReturnType<typeof api.agentBuilder.builder>;

/** The builder's state: every field as typed. Numbers stay text until they are read. */
type State = {
  name: string;
  description: string;
  mode: "text" | "messages";
  variables: { name: string; required: boolean }[];
  variants: Variants;
  provider: string;
  model: string;
  fallbackProvider: string;
  fallbackModel: string;
  params: Record<string, string>;
  tools: string[];
  approvals: string[];
  schemaOn: boolean;
  schema: string;
  api: boolean;
  scheduleOn: boolean;
  cron: string;
  scheduleValues: Record<string, string>;
  subAgentOn: boolean;
  toolId: string;
  subDescription: string;
  chatOn: boolean;
  chatTitle: string;
  greeting: string;
  maxSteps: string;
  timeoutSeconds: string;
  budget: string;
  note: string;
};

function initialState(draft: Draft): State {
  const d = draft.definition!;
  const variants = draft.parts.prompt?.variants ?? { [DEFAULT_VARIANT]: { system: "", user: "" } };
  return {
    name: d.name,
    description: d.description,
    mode: d.input.mode,
    variables: d.input.variables.map((v) => ({ ...v })),
    variants,
    provider: d.model?.provider ?? "",
    model: d.model?.model ?? "",
    fallbackProvider: d.model?.fallbackProvider ?? "",
    fallbackModel: d.model?.fallbackModel ?? "",
    params: paramsText(draft.parts.params ?? null),
    tools: draft.parts.tools ?? [],
    approvals: d.approvals,
    schemaOn: draft.parts.outputSchema !== undefined,
    schema: draft.parts.outputSchema ?? '{\n  "type": "object",\n  "properties": {}\n}',
    api: d.triggers.api,
    scheduleOn: d.triggers.schedule !== undefined,
    cron: d.triggers.schedule?.cron ?? "0 6 * * 1-5",
    scheduleValues: { ...(d.triggers.schedule?.variables ?? {}) },
    subAgentOn: d.triggers.subAgent !== undefined,
    toolId: d.triggers.subAgent?.toolId ?? "",
    subDescription: d.triggers.subAgent?.description ?? "",
    chatOn: d.triggers.chat?.enabled === true,
    chatTitle: d.triggers.chat?.title ?? d.name,
    greeting: d.triggers.chat?.greeting ?? "",
    maxSteps: String(d.limits.maxSteps),
    timeoutSeconds: String(d.limits.timeoutMs / 1000),
    budget: d.limits.monthlyBudgetUsd === undefined ? "" : String(d.limits.monthlyBudgetUsd),
    note: draft.note,
  };
}

/** The variants as the agent takes them: a user template in each for variables, none for a conversation. */
const shaped = (variants: Variants, mode: "text" | "messages"): Variants =>
  Object.fromEntries(
    variantNames(variants).map((name) => {
      const v = variants[name]!;
      return [name, mode === "messages" ? { system: v.system } : { system: v.system, user: v.user ?? "" }];
    }),
  );

/** The state as a definition and parts, exactly what is saved and what the rules read. */
function built(state: State) {
  const declared = new Set(state.variables.map((v) => v.name));
  const timeout = Number(state.timeoutSeconds.trim());
  const definition: Definition = {
    name: state.name,
    description: state.description,
    input: { mode: state.mode, variables: state.variables },
    ...(state.model.trim() === ""
      ? {}
      : {
          model: {
            provider: state.provider,
            model: state.model.trim(),
            ...(state.fallbackModel.trim() === ""
              ? {}
              : { fallbackProvider: state.fallbackProvider, fallbackModel: state.fallbackModel.trim() }),
          },
        }),
    triggers: {
      api: state.api,
      ...(state.scheduleOn
        ? {
            schedule: {
              cron: state.cron,
              variables: Object.fromEntries(Object.entries(state.scheduleValues).filter(([name, value]) => declared.has(name) && value !== "")),
            },
          }
        : {}),
      ...(state.subAgentOn ? { subAgent: { toolId: state.toolId.trim(), description: state.subDescription } } : {}),
      ...(state.chatOn ? { chat: { enabled: true, title: state.chatTitle, greeting: state.greeting } } : {}),
    },
    approvals: state.approvals.filter((id) => state.tools.includes(id)),
    limits: {
      maxSteps: wholeOf(state.maxSteps) ?? Number.NaN,
      timeoutMs: Number.isFinite(timeout) ? Math.round(timeout * 1000) : Number.NaN,
      ...(budgetOf(state.budget) === undefined ? {} : { monthlyBudgetUsd: budgetOf(state.budget)! }),
    },
  };
  const params = paramsFromText(state.params);
  return {
    definition,
    prompt: { variants: shaped(state.variants, state.mode) },
    params,
    tools: state.tools,
    outputSchema: state.schemaOn ? state.schema : null,
  };
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h4 id={id} className="text-sm font-medium text-ink">
        {title}
      </h4>
      {note !== undefined && <p className="max-w-3xl text-xs text-ink-2">{note}</p>}
      {children}
    </section>
  );
}

function Check({ checked, disabled, onChange, children }: { checked: boolean; disabled?: boolean; onChange: (on: boolean) => void; children: ReactNode }) {
  return (
    <label className={cn("flex items-start gap-2 text-sm text-ink", disabled && "text-ink-2")}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-brand"
      />
      <span className="min-w-0">{children}</span>
    </label>
  );
}

/** A tool's tags: what it does, patient data, the page it needs, built into the provider. */
function ToolTags({ tool }: { tool: CatalogTool & { area?: string | null } }) {
  return (
    <span className="flex flex-wrap gap-1">
      <KindTag tone={tool.effect === "write" ? "plum" : "teal"}>{tool.effect === "write" ? "Changes data" : "Reads"}</KindTag>
      {tool.phi && <KindTag tone="sand">Handles patient data</KindTag>}
      {tool.area != null && <KindTag tone="slate">{AREA_WORDS[tool.area as keyof typeof AREA_WORDS] ?? tool.area}</KindTag>}
      {tool.kind === "provider" && <KindTag tone="slate">Built into the provider</KindTag>}
    </span>
  );
}

/** The open draft of an agent built here: every part of it, its rules as it is typed, and saving. */
function BuilderEditor({ view, draft, options, now }: { view: HarnessView; draft: Draft; options: Options; now: number }) {
  const save = useMutation(api.agentBuilder.saveDefinition);
  const discard = useMutation(api.agentHarness.discardDraft);
  const id = useId();
  const [state, setState] = useState<State>(() => initialState(draft));
  const [initial] = useState(() => JSON.stringify(initialState(draft)));
  const [current, setCurrent] = useState(DEFAULT_VARIANT);
  const [newVariant, setNewVariant] = useState("");
  const [status, setStatus] = useState<{ busy: boolean; error: string | null; saved: boolean }>({ busy: false, error: null, saved: false });
  const systemRef = useRef<HTMLTextAreaElement>(null);
  const userRef = useRef<HTMLTextAreaElement>(null);
  const lastFocused = useRef<"system" | "user">("system");
  const set = (next: Partial<State>) => {
    setState((before) => ({ ...before, ...next }));
    setStatus((before) => ({ ...before, saved: false }));
  };

  const out = built(state);
  const catalog: CatalogTool[] = options.tools.map((tool) => ({ ...tool, area: tool.area ?? undefined }));
  const peers = options.peers;
  const problems = declarativeProblems(
    out.definition,
    {
      prompt: out.prompt,
      ...(out.params === null ? {} : { params: out.params }),
      tools: out.tools,
      ...(out.outputSchema === null ? {} : { outputSchema: out.outputSchema }),
    },
    {
      agentId: view.agentId,
      catalog,
      peers,
      policy: { holdsPatientData: options.project.holdsPatientData, allowedProviders: options.project.allowedProviders },
      publishing: true,
      publishedToolId: options.publishedToolId,
      ownerPublishing: options.isOwner,
      ...(options.project.runsHere ? { runsHere: true } : {}),
      ...(options.macRun ? { macRun: true } : {}),
    },
  );
  const dirty = JSON.stringify(state) !== initial;
  const names = variantNames(state.variants);
  const variant = state.variants[current] ?? { system: "", user: "" };
  const at = (path: string) => problems.some((issue) => issue.path === path || issue.path.startsWith(`${path}.`));

  const setTemplate = (which: "system" | "user", text: string) =>
    set({ variants: { ...state.variants, [current]: { ...variant, [which]: text } } });
  const insert = (name: string) => {
    const which = state.mode === "messages" ? "system" : lastFocused.current;
    const field = which === "system" ? systemRef.current : userRef.current;
    const text = variant[which] ?? "";
    const start = field?.selectionStart ?? text.length;
    const end = field?.selectionEnd ?? start;
    setTemplate(which, `${text.slice(0, start)}{{${name}}}${text.slice(end)}`);
    requestAnimationFrame(() => field?.focus());
  };
  const toggleTool = (toolId: string, on: boolean, write: boolean) => {
    const tools = on ? [...state.tools, toolId] : state.tools.filter((t) => t !== toolId);
    const approvals = on && write ? [...new Set([...state.approvals, toolId])] : state.approvals.filter((t) => tools.includes(t));
    set({ tools, approvals });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setStatus({ busy: true, error: null, saved: false });
    try {
      await save({
        id: draft.id,
        revision: draft.revision,
        definition: out.definition,
        prompt: out.prompt,
        params: out.params,
        tools: out.tools,
        outputSchema: out.outputSchema,
        note: state.note,
      });
      setStatus({ busy: false, error: null, saved: true });
    } catch (failure) {
      setStatus({ busy: false, error: messageOf(failure), saved: false });
    }
  };

  const runsHere = options.project.runsHere;
  const pairsFor = (provider: string) => options.pairs.filter((pair) => pair.provider === provider).map((pair) => pair.model);
  const configured = (provider: string) => options.providers.find((p) => p.provider === provider)?.configured ?? null;
  const reportedUp = (provider: string, model: string) =>
    runsHere || model.trim() === "" || options.pairs.some((pair) => pair.provider === provider && pair.model === model.trim());
  const upcoming = state.scheduleOn ? nextRuns(state.cron, now, 3) : [];
  const writeTools = catalog.filter((tool) => tool.effect === "write").map((tool) => tool.id);
  const peerTools = options.peers.filter((peer) => peer.toolId !== null);

  return (
    <form onSubmit={submit} className="space-y-8">
      <Section title="About">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-name`}>
            Name
            <input id={`${id}-name`} maxLength={60} value={state.name} aria-invalid={at("name") || undefined} onChange={(e) => set({ name: e.target.value })} className={`${fieldClass} mt-1 h-10`} />
          </label>
          <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-description`}>
            What it does
            <input id={`${id}-description`} maxLength={500} value={state.description} aria-invalid={at("description") || undefined} onChange={(e) => set({ description: e.target.value })} className={`${fieldClass} mt-1 h-10`} />
          </label>
        </div>
      </Section>

      <Section title="Input" note="What each run is given: variables filled into its message, or a conversation (a chat box sends one).">
        <div className="flex flex-wrap gap-4">
          <Check checked={state.mode === "text"} onChange={(on) => on && set({ mode: "text" })}>
            Variables, filled into a message
          </Check>
          <Check checked={state.mode === "messages"} onChange={(on) => on && set({ mode: "messages" })}>
            A conversation
          </Check>
        </div>
        <ul className="space-y-2" aria-label="Variables">
          {state.variables.map((variable, i) => (
            <li key={i} className="flex flex-wrap items-center gap-3">
              <input
                aria-label={`Variable ${i + 1}`}
                value={variable.name}
                maxLength={40}
                placeholder="request"
                onChange={(e) => set({ variables: state.variables.map((v, j) => (j === i ? { ...v, name: e.target.value } : v)) })}
                className={`${fieldClass} h-9 w-48 font-mono`}
              />
              <Check checked={variable.required} onChange={(on) => set({ variables: state.variables.map((v, j) => (j === i ? { ...v, required: on } : v)) })}>
                Required
              </Check>
              <button type="button" onClick={() => set({ variables: state.variables.filter((_, j) => j !== i) })} className={quietButtonClass}>
                Remove
              </button>
            </li>
          ))}
        </ul>
        <button type="button" onClick={() => set({ variables: [...state.variables, { name: "", required: true }] })} className={quietButtonClass}>
          Add a variable
        </button>
      </Section>

      <Section title="Instructions" note="A template, never a patient's words: the project fills each variable in. Use {{name}}, exactly.">
        <div className="flex flex-wrap items-end gap-2">
          <VariantSwitcher names={names} current={current} problems={problemsByVariant(problems)} onPick={setCurrent} />
          <input
            aria-label="New variant's name"
            placeholder="retry"
            value={newVariant}
            maxLength={32}
            onChange={(e) => setNewVariant(e.target.value)}
            className={`${fieldClass} h-9 w-32 font-mono`}
          />
          <button
            type="button"
            disabled={!VARIANT_NAME_PATTERN.test(newVariant) || state.variants[newVariant] !== undefined}
            onClick={() => {
              set({ variants: { ...state.variants, [newVariant]: { system: variant.system, user: variant.user ?? "" } } });
              setCurrent(newVariant);
              setNewVariant("");
            }}
            className={quietButtonClass}
          >
            Add a variant
          </button>
          {current !== DEFAULT_VARIANT && (
            <button
              type="button"
              onClick={() => {
                const { [current]: _gone, ...rest } = state.variants;
                set({ variants: rest });
                setCurrent(DEFAULT_VARIANT);
              }}
              className={quietButtonClass}
            >
              {`Remove ${current}`}
            </button>
          )}
        </div>
        {state.variables.some((v) => v.name !== "") && (
          <div className="flex flex-wrap items-center gap-2" aria-label="Insert a variable">
            <span className="text-xs text-ink-2">Insert a variable:</span>
            {state.variables
              .filter((v) => v.name !== "")
              .map((v) => (
                <button
                  key={v.name}
                  type="button"
                  onClick={() => insert(v.name)}
                  className="rounded-md bg-surface px-2 py-0.5 font-mono text-xs text-ink outline-none hover:bg-info-soft focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {`{{${v.name}}}`}
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
          invalid={at(`prompt.${current}.system`)}
          onFocus={() => (lastFocused.current = "system")}
          onChange={(text) => setTemplate("system", text)}
        />
        {state.mode === "text" && (
          <TemplateField
            key={`${current}-user`}
            id={`${id}-user`}
            label={names.length > 1 ? `Message, ${current}` : "Message"}
            fieldRef={userRef}
            rows={4}
            value={variant.user ?? ""}
            invalid={at(`prompt.${current}.user`)}
            onFocus={() => (lastFocused.current = "user")}
            onChange={(text) => setTemplate("user", text)}
          />
        )}
        <p className="text-xs text-ink-2">{SECTION_NOTE}</p>
      </Section>

      <Section
        title="Model"
        note={
          runsHere
            ? `${PRODUCT.name}'s own providers. A provider not configured cannot run it yet.`
            : options.project.holdsPatientData
              ? "This project holds patient data: Vertex AI only."
              : "A model the project may use. Test runs choose their own models."
        }
      >
        <div className="grid gap-4 md:grid-cols-2">
          {(["primary", "fallback"] as const).map((which) => {
            const providerKey = which === "primary" ? "provider" : "fallbackProvider";
            const modelKey = which === "primary" ? "model" : "fallbackModel";
            const provider = state[providerKey] || options.project.allowedProviders[0] || "";
            const ok = configured(provider);
            return (
              <div key={which} className="grid min-w-0 gap-2 sm:grid-cols-2">
                <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-${which}-provider`}>
                  {which === "primary" ? "Provider" : "Fallback provider"}
                  <select
                    id={`${id}-${which}-provider`}
                    value={provider}
                    onChange={(e) => set({ [providerKey]: e.target.value } as Partial<State>)}
                    className={`${fieldClass} mt-1 h-10`}
                  >
                    {options.project.allowedProviders.map((p) => (
                      <option key={p} value={p}>
                        {`${providerLabel(p)}${configured(p) === false ? `, ${STARTUP_OS_WORDS.notConfigured}` : ""}`}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-${which}-model`}>
                  {which === "primary" ? "Model" : "Fallback model"}
                  <input
                    id={`${id}-${which}-model`}
                    list={`${id}-${which}-models`}
                    maxLength={80}
                    placeholder={which === "primary" ? "Choose a model" : "No fallback"}
                    value={state[modelKey]}
                    aria-invalid={(which === "primary" && at("model")) || undefined}
                    onChange={(e) => set({ [modelKey]: e.target.value, [providerKey]: provider } as Partial<State>)}
                    className={`${fieldClass} mt-1 h-10 font-mono`}
                  />
                  <datalist id={`${id}-${which}-models`}>
                    {pairsFor(provider).map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </label>
                {ok === false && <p className="text-xs text-ink-2 sm:col-span-2">{`${providerLabel(provider)} is ${STARTUP_OS_WORDS.notConfigured} in ${PRODUCT.name}.`}</p>}
                {!reportedUp(provider, state[modelKey]) && (
                  <p className="text-xs text-ink-2 sm:col-span-2">The project has not reported this model up yet.</p>
                )}
              </div>
            );
          })}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {PARAM_KEYS.map((key) => (
            <label key={key} className="min-w-0 text-sm text-ink" htmlFor={`${id}-${key}`}>
              {PARAM_BOUNDS[key].label}
              <input
                id={`${id}-${key}`}
                inputMode="decimal"
                value={state.params[key] ?? ""}
                placeholder={PARAM_HINTS[key]}
                aria-invalid={at(`params.${key}`) || undefined}
                onChange={(e) => set({ params: { ...state.params, [key]: e.target.value } })}
                className={`${fieldClass} mt-1 h-10`}
              />
            </label>
          ))}
        </div>
      </Section>

      <Section
        title="Tools"
        note={
          runsHere
            ? `${PRODUCT.name}'s own tools. One that changes data always asks a person first. A tool of a page only the owner may give makes the agent the owner's to publish, and its runs the owner's to read.`
            : "What the project can run. One that changes data always asks a person first; any other may."
        }
      >
        {catalog.length === 0 ? (
          <p className="text-sm text-ink-2">The project has not reported its tools yet. Its next report brings them.</p>
        ) : (
          <ul className="space-y-3">
            {catalog.map((tool) => {
              const on = state.tools.includes(tool.id);
              const write = writeTools.includes(tool.id);
              return (
                <li key={tool.id} className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                  <Check checked={on} onChange={(next) => toggleTool(tool.id, next, write)}>
                    <span className="font-medium">{tool.name}</span> <code className="font-mono text-xs text-ink-2">{tool.id}</code>
                    <span className="mt-1 block">
                      <ToolTags tool={tool} />
                    </span>
                    {tool.description !== "" && <span className="mt-1 block text-xs text-ink-2">{tool.description}</span>}
                  </Check>
                  {tool.approvable ? (
                    <div className="pl-6 sm:pl-0">
                      <Check
                        checked={on && (write || state.approvals.includes(tool.id))}
                        disabled={!on || write}
                        onChange={(next) =>
                          set({ approvals: next ? [...state.approvals, tool.id] : state.approvals.filter((t) => t !== tool.id) })
                        }
                      >
                        {write ? "Asks a person first (always)" : "Asks a person first"}
                      </Check>
                    </div>
                  ) : (
                    <p className="pl-6 text-xs text-ink-2 sm:pl-0">Runs inside the model: it cannot ask first.</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Sub-agents" note="Other agents built here, published and offered as a sub-agent, that this one may call. At most 3 deep, and never round in a circle.">
        {peerTools.length === 0 ? (
          <p className="text-sm text-ink-2">No other agent built here is published as a sub-agent yet.</p>
        ) : (
          <ul className="space-y-2">
            {peerTools.map((peer) => (
              <li key={peer.agentId} className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <Check checked={state.tools.includes(peer.toolId!)} onChange={(on) => toggleTool(peer.toolId!, on, false)}>
                  <span className="font-medium">{peer.name}</span> <code className="font-mono text-xs text-ink-2">{peer.toolId}</code>
                  {peer.description !== "" && <span className="block text-xs text-ink-2">{peer.description}</span>}
                </Check>
                <div className="pl-6 sm:pl-0">
                  <Check
                    checked={state.tools.includes(peer.toolId!) && state.approvals.includes(peer.toolId!)}
                    disabled={!state.tools.includes(peer.toolId!)}
                    onChange={(next) =>
                      set({ approvals: next ? [...state.approvals, peer.toolId!] : state.approvals.filter((t) => t !== peer.toolId) })
                    }
                  >
                    Asks a person first
                  </Check>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Answer" note="Free text, or JSON that follows a schema.">
        <Check checked={state.schemaOn} onChange={(on) => set({ schemaOn: on })}>
          Answer in JSON that follows a schema
        </Check>
        {state.schemaOn && (
          <label className="block text-sm text-ink" htmlFor={`${id}-schema`}>
            JSON Schema
            <textarea
              id={`${id}-schema`}
              rows={8}
              spellCheck={false}
              value={state.schema}
              aria-invalid={at("output") || undefined}
              onChange={(e) => set({ schema: e.target.value })}
              className={`${fieldClass} mt-1 py-2 font-mono text-xs`}
            />
          </label>
        )}
      </Section>

      <Section title="How it is started" note="At least one, to publish it.">
        <div className="space-y-4">
          <div className="space-y-1">
            <Check checked={state.api} onChange={(on) => set({ api: on })}>
              An API endpoint
            </Check>
            {state.api &&
              (runsHere ? (
                <p className="pl-6 text-xs text-ink-2">{STARTUP_OS_WORDS.noApi}</p>
              ) : (
                <p className="pl-6 text-xs text-ink-2">
                  In the project&apos;s app: <code className="font-mono text-ink">{`POST ${runPath(view.agentId)}`}</code>, behind the app&apos;s own
                  sign-in.
                </p>
              ))}
          </div>
          <div className="space-y-2">
            <Check checked={state.scheduleOn} onChange={(on) => set({ scheduleOn: on })}>
              On a schedule
            </Check>
            {state.scheduleOn && (
              <div className="space-y-2 pl-6">
                <label className="block max-w-sm text-sm text-ink" htmlFor={`${id}-cron`}>
                  Cron, five fields, UTC
                  <input
                    id={`${id}-cron`}
                    value={state.cron}
                    maxLength={100}
                    aria-invalid={at("triggers.schedule") || undefined}
                    onChange={(e) => set({ cron: e.target.value })}
                    className={`${fieldClass} mt-1 h-10 font-mono`}
                  />
                </label>
                {upcoming.length > 0 && (
                  <div className="text-xs text-ink-2">
                    Next runs:
                    <ul className="mt-1 space-y-0.5">
                      {upcoming.map((time) => (
                        <li key={time} className="font-mono text-ink">
                          {utcWords(time)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {state.variables
                  .filter((v) => v.name !== "")
                  .map((v) => (
                    <label key={v.name} className="block max-w-xl text-sm text-ink" htmlFor={`${id}-sched-${v.name}`}>
                      {`${v.name}${v.required ? ", required" : ""}`}
                      <input
                        id={`${id}-sched-${v.name}`}
                        maxLength={2000}
                        value={state.scheduleValues[v.name] ?? ""}
                        onChange={(e) => set({ scheduleValues: { ...state.scheduleValues, [v.name]: e.target.value } })}
                        className={`${fieldClass} mt-1 h-10`}
                      />
                    </label>
                  ))}
              </div>
            )}
          </div>
          <div className="space-y-2">
            <Check checked={state.subAgentOn} onChange={(on) => set({ subAgentOn: on })}>
              As a sub-agent of other agents built here
            </Check>
            {state.subAgentOn && (
              <div className="grid gap-3 pl-6 md:grid-cols-2">
                <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-toolid`}>
                  Tool id it is called by
                  <input
                    id={`${id}-toolid`}
                    maxLength={64}
                    placeholder="triage"
                    value={state.toolId}
                    aria-invalid={at("triggers.subAgent.toolId") || undefined}
                    onChange={(e) => set({ toolId: e.target.value })}
                    className={`${fieldClass} mt-1 h-10 font-mono`}
                  />
                </label>
                <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-subdesc`}>
                  What it does, for the agents that call it
                  <input
                    id={`${id}-subdesc`}
                    maxLength={500}
                    value={state.subDescription}
                    onChange={(e) => set({ subDescription: e.target.value })}
                    className={`${fieldClass} mt-1 h-10`}
                  />
                </label>
              </div>
            )}
          </div>
          <div className="space-y-2">
            {runsHere && <p className="text-xs text-ink-2">{STARTUP_OS_WORDS.noChat}</p>}
            {(!runsHere || state.chatOn) && (
              <Check checked={state.chatOn} onChange={(on) => set({ chatOn: on })}>
                A chat box in the app
              </Check>
            )}
            {state.chatOn && (
              <div className="space-y-3 pl-6">
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-chat-title`}>
                    Title
                    <input id={`${id}-chat-title`} maxLength={60} value={state.chatTitle} onChange={(e) => set({ chatTitle: e.target.value })} className={`${fieldClass} mt-1 h-10`} />
                  </label>
                  <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-greeting`}>
                    Greeting
                    <input id={`${id}-greeting`} maxLength={500} value={state.greeting} onChange={(e) => set({ greeting: e.target.value })} className={`${fieldClass} mt-1 h-10`} />
                  </label>
                </div>
                {!runsHere && (
                  <div className="text-xs text-ink-2">
                    Put it in the app with:
                    <pre className="mt-1 overflow-x-auto rounded-inner bg-surface p-2 font-mono text-xs text-ink">{embedSnippet(view.agentId)}</pre>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </Section>

      <Section title="Limits">
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-steps`}>
            Most steps, 1 to 30
            <input id={`${id}-steps`} inputMode="numeric" placeholder={String(DEFAULT_LIMITS.maxSteps)} value={state.maxSteps} aria-invalid={at("limits.maxSteps") || undefined} onChange={(e) => set({ maxSteps: e.target.value })} className={`${fieldClass} mt-1 h-10`} />
          </label>
          <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-timeout`}>
            Time limit, seconds
            <input id={`${id}-timeout`} inputMode="decimal" placeholder={String(DEFAULT_LIMITS.timeoutMs / 1000)} value={state.timeoutSeconds} aria-invalid={at("limits.timeoutMs") || undefined} onChange={(e) => set({ timeoutSeconds: e.target.value })} className={`${fieldClass} mt-1 h-10`} />
          </label>
          <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-budget`}>
            Monthly budget, USD
            <input id={`${id}-budget`} inputMode="decimal" placeholder="No budget" value={state.budget} aria-invalid={at("limits.monthlyBudgetUsd") || undefined} onChange={(e) => set({ budget: e.target.value })} className={`${fieldClass} mt-1 h-10`} />
          </label>
        </div>
        {runsHere && <p className="text-xs text-ink-2">{STARTUP_OS_WORDS.budgetNotEnforced}</p>}
      </Section>

      <label className="block text-sm text-ink" htmlFor={`${id}-note`}>
        Note
        <input id={`${id}-note`} value={state.note} maxLength={MAX_NOTE_LENGTH} placeholder="Why this version" onChange={(e) => set({ note: e.target.value })} className={`${fieldClass} mt-1 h-10`} />
      </label>

      <ProblemList issues={problems} empty="Ready to test and publish." />

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

/** The Builder tab of an agent built here: what is live, and the draft that may replace it. */
export function BuilderTab({ view, now, runsOn = null }: { view: HarnessView; now: number; runsOn?: RunsOn | null }) {
  const options = useQuery(api.agentBuilder.builder, { project: view.project, agentId: view.agentId });
  const start = useMutation(api.agentHarness.newDraft);
  const [error, setError] = useState<string | null>(null);
  if (options === undefined) return <Skeleton className="h-96 rounded-inner" />;
  const draft = view.draft;
  const published = view.published;
  const begin = async () => {
    setError(null);
    try {
      await start({ project: view.project, agentId: view.agentId, from: published === null ? "default" : "published" });
    } catch (failure) {
      setError(messageOf(failure));
    }
  };
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <p className="text-sm text-ink">
          {published === null
            ? "Not published yet: its project does not run it."
            : `${published.name} is published${published.publishedAt === null ? "" : `, ${atWords(published.publishedAt, now)}`}.`}
        </p>
        {view.ownerOnly && <p className="text-xs text-ink-2">{STARTUP_OS_WORDS.ownerOnly}</p>}
        {runsOn === "claude_mac" ? (
          <>
            <p className="text-xs text-ink-2">{RUNS_ON_LINES.claude_mac}</p>
            <p className="text-xs text-ink-2">{MAC_TOOLS_LINE}</p>
          </>
        ) : (
          options.project.runsHere && <p className="text-xs text-ink-2">{STARTUP_OS_WORDS.howItRuns}</p>
        )}
      </div>
      {draft === null || draft.definition === null ? (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => void begin()} className={primaryButtonClass}>
            {published === null ? "New draft" : `New draft from ${published.name}`}
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
          </div>
          <BuilderEditor key={`${draft.id}:${draft.revision}`} view={view} draft={draft} options={options} now={now} />
          <PublishBlock view={view} draft={draft} />
        </div>
      )}
    </div>
  );
}
