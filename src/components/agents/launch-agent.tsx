"use client";

import { useMutation, useQuery } from "convex/react";
import { useId, useState, type FormEvent } from "react";
import { api } from "@convex/_generated/api";
import { AGENT_ID_PATTERN, type ModelPair } from "@convex/lib/agentControl";
import { LAUNCH_WORDS, providerList } from "@convex/lib/agentProjects";
import { fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { pairWords } from "@/lib/agents/view";
import { messageOf } from "@/lib/errors";

const OTHER = "__other__";
const keyOf = (pair: ModelPair) => `${pair.provider}|${pair.model}`;
const pairOf = (key: string): ModelPair => {
  const [provider, ...rest] = key.split("|");
  return { provider: provider!, model: rest.join("|") };
};

type Pair = ModelPair & { patientData: boolean };

/** The fields of one project's launch, once its options have come. */
function LaunchFields({
  project,
  options,
  onLaunched,
  onCancel,
}: {
  project: string;
  options: {
    holdsPatientData: boolean;
    allowedProviders: string[];
    catalog: { agentId: string; name: string; phi: boolean; launched: boolean }[];
    pairs: Pair[];
  };
  onLaunched: (agentId: string) => void;
  onCancel: () => void;
}) {
  const launch = useMutation(api.agentControl.launch);
  const id = useId();
  const free = options.catalog.filter((entry) => !entry.launched);
  const [choice, setChoice] = useState(free[0]?.agentId ?? OTHER);
  const [typed, setTyped] = useState("");
  const [name, setName] = useState(free[0]?.name ?? "");
  const [enabled, setEnabled] = useState(true);
  const [budget, setBudget] = useState("");
  const [pin, setPin] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });

  const entry = options.catalog.find((row) => row.agentId === choice) ?? null;
  const agentId = choice === OTHER ? typed.trim() : choice;
  // An agent that handles patient data gets providers for patient data only, in any project.
  const pairs = options.pairs.filter((pair) => pair.patientData || !(entry?.phi ?? false));
  const [primary, setPrimary] = useState(pairs[0] === undefined ? "" : keyOf(pairs[0]));
  const [fallback, setFallback] = useState("");
  const primaryKey = pairs.some((pair) => keyOf(pair) === primary) ? primary : pairs[0] === undefined ? "" : keyOf(pairs[0]);

  const pick = (next: string) => {
    setChoice(next);
    const found = options.catalog.find((row) => row.agentId === next);
    setName(found?.name ?? "");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (state.busy || primaryKey === "") return;
    if (!AGENT_ID_PATTERN.test(agentId)) {
      setState({ busy: false, error: LAUNCH_WORDS.agentId });
      return;
    }
    const amount = budget.trim() === "" ? null : Number(budget.trim());
    setState({ busy: true, error: null });
    try {
      await launch({
        project,
        agentId,
        ...(name.trim() === "" ? {} : { name: name.trim() }),
        enabled,
        ...pairOf(primaryKey),
        fallback: fallback === "" || fallback === primaryKey ? null : pairOf(fallback),
        monthlyBudgetUsd: amount,
        promptVersionPin: pin.trim() === "" ? null : pin.trim(),
      });
      setState({ busy: false, error: null });
      onLaunched(agentId);
    } catch (failure) {
      setState({ busy: false, error: messageOf(failure) });
    }
  };

  return (
    <form onSubmit={submit} aria-label="Launch an agent" className="space-y-4">
      <p className="max-w-3xl text-xs text-ink-2">
        {options.holdsPatientData
          ? `This project holds patient data: its agents may run on ${providerList(options.allowedProviders)} only.`
          : `This project may use ${providerList(options.allowedProviders)}. An agent that handles patient data gets providers for patient data only.`}
      </p>
      <div className="grid gap-4 md:grid-cols-3">
        <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-agent`}>
          Agent
          <select id={`${id}-agent`} value={choice} onChange={(event) => pick(event.target.value)} className={`${fieldClass} mt-1 h-10`}>
            {free.map((row) => (
              <option key={row.agentId} value={row.agentId}>
                {`${row.name} (${row.agentId})${row.phi ? ", patient data" : ""}`}
              </option>
            ))}
            <option value={OTHER}>Another id its code will report…</option>
          </select>
        </label>
        {choice === OTHER && (
          <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-id`}>
            Agent id
            <input
              id={`${id}-id`}
              required
              maxLength={64}
              placeholder="note-coding.select"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              className={`${fieldClass} mt-1 h-10 font-mono`}
            />
          </label>
        )}
        <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-name`}>
          Name
          <input
            id={`${id}-name`}
            maxLength={60}
            placeholder="Optional"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={`${fieldClass} mt-1 h-10`}
          />
        </label>
      </div>
      {choice === OTHER && (
        <p className="text-xs text-ink-2">Waiting for the project to report it: it runs once the project&apos;s code has an agent by that id.</p>
      )}
      {pairs.length === 0 ? (
        <p className="text-sm text-ink-2">
          No model this agent may use has been reported up by this project yet. Its next report brings them.
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-model`}>
            Model
            <select id={`${id}-model`} value={primaryKey} onChange={(event) => setPrimary(event.target.value)} className={`${fieldClass} mt-1 h-10`}>
              {pairs.map((pair) => (
                <option key={keyOf(pair)} value={keyOf(pair)}>
                  {`${pairWords(pair)}${pair.patientData ? "" : " (not for patient data)"}`}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-fallback`}>
            Fallback
            <select id={`${id}-fallback`} value={fallback} onChange={(event) => setFallback(event.target.value)} className={`${fieldClass} mt-1 h-10`}>
              <option value="">No fallback</option>
              {pairs
                .filter((pair) => keyOf(pair) !== primaryKey)
                .map((pair) => (
                  <option key={keyOf(pair)} value={keyOf(pair)}>
                    {`${pairWords(pair)}${pair.patientData ? "" : " (not for patient data)"}`}
                  </option>
                ))}
            </select>
          </label>
          <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-budget`}>
            Monthly budget, USD
            <input
              id={`${id}-budget`}
              inputMode="decimal"
              placeholder="No budget"
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
              className={`${fieldClass} mt-1 h-10`}
            />
          </label>
          <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-pin`}>
            Prompt version pin
            <input
              id={`${id}-pin`}
              maxLength={40}
              placeholder="Optional"
              value={pin}
              onChange={(event) => setPin(event.target.value)}
              className={`${fieldClass} mt-1 h-10 font-mono`}
            />
          </label>
          <label className="flex items-center gap-2.5 self-end pb-2 text-sm text-ink">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="size-4 shrink-0 accent-brand" />
            Switched on
          </label>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={state.busy || pairs.length === 0} className={primaryButtonClass}>
          {state.busy ? "Launching…" : "Launch"}
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
      <p className="text-xs text-ink-2">A launch is a new config version: pending until the project says it applied it.</p>
    </form>
  );
}

/**
 * "Launch agent": pick a project, then an agent it says it can run (or an
 * id its code will report), its name, model and fallback among what the
 * project may use and last saw up, a budget and its switch.
 */
export function LaunchAgent({
  projects,
  initial,
  onLaunched,
  onCancel,
}: {
  projects: readonly { slug: string; name: string }[];
  initial: string | null;
  onLaunched: (project: string, agentId: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [project, setProject] = useState(
    initial !== null && projects.some((p) => p.slug === initial) ? initial : (projects[0]?.slug ?? ""),
  );
  const options = useQuery(api.agentProjects.launchOptions, project === "" ? "skip" : { project });
  if (projects.length === 0) {
    return <p className="text-sm text-ink-2">Connect a project first: an agent is launched into one.</p>;
  }
  return (
    <div className="space-y-4">
      <label className="block max-w-sm text-sm text-ink" htmlFor={`${id}-project`}>
        Project
        <select id={`${id}-project`} value={project} onChange={(event) => setProject(event.target.value)} className={`${fieldClass} mt-1 h-10`}>
          {projects.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {options === undefined ? (
        <Skeleton className="h-40 rounded-inner" />
      ) : options === null ? (
        <p className="text-sm text-ink-2">There is no project by that id.</p>
      ) : (
        <LaunchFields
          key={project}
          project={project}
          options={options}
          onLaunched={(agentId) => onLaunched(project, agentId)}
          onCancel={onCancel}
        />
      )}
    </div>
  );
}
