"use client";

import { useMutation } from "convex/react";
import { useId, useState, type FormEvent } from "react";
import { api } from "@convex/_generated/api";
import { providerLabel } from "@convex/lib/agentControl";
import { DEFAULT_BUILDER_MODEL, defaultModelFor } from "@convex/lib/agentBuilder";
import { STARTUP_OS_MODELS, STARTUP_OS_POLICY, STARTUP_OS_PROJECT, STARTUP_OS_WORDS } from "@convex/lib/agentStartupOs";
import { PRODUCT } from "@convex/lib/identity";
import { fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import { messageOf } from "@/lib/errors";

export type CreateProject = { slug: string; name: string; holdsPatientData: boolean; allowedProviders: string[] };

const STARTUP_OS_OPTION: CreateProject = {
  slug: STARTUP_OS_PROJECT,
  name: STARTUP_OS_WORDS.runsHere,
  holdsPatientData: false,
  allowedProviders: STARTUP_OS_POLICY.allowedProviders,
};

/** The model a new agent starts on in a project: the default where it may use it, else none. */
const startModel = (project: CreateProject) => {
  const preset = defaultModelFor(project);
  return { provider: preset?.provider ?? project.allowedProviders[0] ?? "", model: preset?.model ?? "" };
};

/**
 * "Create agent": a new agent built here, from scratch, in a connected
 * project or in Startup OS itself. Its id, name and description, what it takes
 * (variables, or a conversation) and the model it starts on. It is saved as a
 * draft; everything else is set on its Builder tab, then it is tested and
 * published.
 */
export function CreateAgent({
  projects,
  initial,
  onCreated,
  onCancel,
}: {
  projects: readonly CreateProject[];
  initial: string | null;
  onCreated: (project: string, agentId: string) => void;
  onCancel: () => void;
}) {
  const create = useMutation(api.agentBuilder.create);
  const id = useId();
  const all = [...projects.filter((p) => p.slug !== STARTUP_OS_PROJECT), STARTUP_OS_OPTION];
  const first = all.find((p) => p.slug === initial) ?? all[0]!;
  const [project, setProject] = useState(first.slug);
  const [agentId, setAgentId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<"text" | "messages">("text");
  const [model, setModel] = useState(() => startModel(first));
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const chosen = all.find((p) => p.slug === project) ?? first;
  const suggestions =
    project === STARTUP_OS_PROJECT
      ? (STARTUP_OS_MODELS[model.provider] ?? [])
      : model.provider === DEFAULT_BUILDER_MODEL.provider
        ? [DEFAULT_BUILDER_MODEL.model]
        : [];

  const pick = (slug: string) => {
    setProject(slug);
    setModel(startModel(all.find((p) => p.slug === slug) ?? first));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setState({ busy: true, error: null });
    try {
      const made = await create({
        project,
        agentId: agentId.trim(),
        name,
        description,
        mode,
        model: model.model.trim() === "" ? null : { provider: model.provider, model: model.model.trim() },
      });
      setState({ busy: false, error: null });
      onCreated(made.project, made.agentId);
    } catch (failure) {
      setState({ busy: false, error: messageOf(failure) });
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 md:grid-cols-3">
        <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-project`}>
          Runs in
          <select id={`${id}-project`} value={project} onChange={(event) => pick(event.target.value)} className={`${fieldClass} mt-1 h-10`}>
            {all.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-id`}>
          Agent id
          <input
            id={`${id}-id`}
            required
            maxLength={64}
            placeholder="triage.requests"
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
            className={`${fieldClass} mt-1 h-10 font-mono`}
          />
        </label>
        <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-name`}>
          Name
          <input
            id={`${id}-name`}
            required
            maxLength={60}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={`${fieldClass} mt-1 h-10`}
          />
        </label>
      </div>
      <label className="block text-sm text-ink" htmlFor={`${id}-description`}>
        What it does
        <textarea
          id={`${id}-description`}
          required
          rows={2}
          maxLength={500}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className={`${fieldClass} mt-1 py-2`}
        />
      </label>
      <fieldset className="space-y-2">
        <legend className="text-sm text-ink">What it takes</legend>
        <label className="flex items-start gap-2 text-sm text-ink">
          <input type="radio" name={`${id}-mode`} checked={mode === "text"} onChange={() => setMode("text")} className="mt-0.5 size-4 accent-brand" />
          <span>
            Variables, filled into a message
            <span className="block text-xs text-ink-2">For an API call, a schedule or another agent.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm text-ink">
          <input type="radio" name={`${id}-mode`} checked={mode === "messages"} onChange={() => setMode("messages")} className="mt-0.5 size-4 accent-brand" />
          <span>
            A conversation
            <span className="block text-xs text-ink-2">For a chat box in the app.</span>
          </span>
        </label>
      </fieldset>
      <div className="grid gap-4 md:grid-cols-3">
        <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-provider`}>
          Provider
          <select
            id={`${id}-provider`}
            value={model.provider}
            onChange={(event) => setModel({ provider: event.target.value, model: "" })}
            className={`${fieldClass} mt-1 h-10`}
          >
            {chosen.allowedProviders.map((provider) => (
              <option key={provider} value={provider}>
                {providerLabel(provider)}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0 text-sm text-ink md:col-span-2" htmlFor={`${id}-model`}>
          Model
          <input
            id={`${id}-model`}
            list={`${id}-models`}
            maxLength={80}
            placeholder={chosen.holdsPatientData ? "Choose a Vertex AI model" : "Choose later"}
            value={model.model}
            onChange={(event) => setModel({ ...model, model: event.target.value })}
            className={`${fieldClass} mt-1 h-10 font-mono`}
          />
          <datalist id={`${id}-models`}>
            {suggestions.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
      </div>
      {chosen.holdsPatientData && (
        <p className="text-xs text-ink-2">This project holds patient data: its agents run on Vertex AI only, and no model is chosen for you.</p>
      )}
      {project === STARTUP_OS_PROJECT && (
        <p className="text-xs text-ink-2">
          It runs in {PRODUCT.name}, on {PRODUCT.name}&apos;s own tools, never with patient data. Running it comes in a later change: it can be
          built and published now.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={state.busy} className={primaryButtonClass}>
          {state.busy ? "Creating…" : "Create draft"}
        </button>
        <button type="button" onClick={onCancel} className={quietButtonClass}>
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
