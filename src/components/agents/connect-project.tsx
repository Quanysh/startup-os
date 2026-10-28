"use client";

import { useMutation } from "convex/react";
import { useId, useState, type FormEvent } from "react";
import { api } from "@convex/_generated/api";
import { KNOWN_PROVIDERS, PROVIDER_INFO, providerLabel } from "@convex/lib/agentControl";
import {
  AGENTS_TOKEN_ENV,
  AGENTS_URL_ENV,
  PROJECT_WORDS,
  REGIONS,
  SUGGESTED_PROJECTS,
  providersFor,
  setupText,
  type Region,
} from "@convex/lib/agentProjects";
import { PRODUCT } from "@convex/lib/identity";
import { CopyButton } from "@/components/assistant/copy-button";
import { fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import { REGION_WORDS } from "@/lib/agents/view";
import { messageOf } from "@/lib/errors";
import { randomNonce } from "@/lib/work/pkce";

/** A project's id from its name: "Startup Atlas" → "startup-atlas". */
export const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 40);

const codeClass =
  "block overflow-x-auto rounded-inner bg-surface px-3 py-2 font-mono text-xs text-ink outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * A project's token, the one time it can be read, and the two variables the
 * package reads. It lives in the page's state and nowhere else: leaving the
 * page loses it, and the server keeps only its fingerprint.
 */
export function TokenReveal({
  name,
  token,
  siteUrl,
  onDone,
}: {
  name: string;
  token: string;
  siteUrl: string | null;
  onDone: () => void;
}) {
  const setup = setupText(siteUrl, token);
  return (
    <div role="status" className="space-y-3">
      <p className="text-sm font-medium text-ink">{`${name}'s token. You will not see it again.`}</p>
      <code data-testid="project-token" className={codeClass}>
        {token}
      </code>
      <CopyButton text={token} label="Copy token" />
      <p className="max-w-2xl text-sm text-ink-2">
        {`Set these two in the project's environment (its secrets, never in git). The package reads ${AGENTS_URL_ENV} and ${AGENTS_TOKEN_ENV}; ${PRODUCT.name} keeps only a fingerprint of the token, so if it is lost, rotate it.`}
      </p>
      {siteUrl === null && (
        <p role="alert" className="text-sm text-destructive">
          This site is not configured with its deployment&apos;s address (NEXT_PUBLIC_CONVEX_URL), so the URL is a placeholder.
        </p>
      )}
      <pre data-testid="project-setup" className={codeClass}>
        {setup}
      </pre>
      <div className="flex flex-wrap items-center gap-2">
        <CopyButton text={setup} label="Copy setup" />
        <button type="button" onClick={onDone} className={quietButtonClass}>
          Done
        </button>
      </div>
    </div>
  );
}

/**
 * "Connect a project": its name and id, where it is, whether it holds
 * patient data, and the providers it may use. A project that holds patient
 * data fails closed and may use providers for patient data only. Gives the
 * token once, through `onConnected`.
 */
export function ConnectProject({
  taken,
  onConnected,
  onCancel,
}: {
  taken: readonly string[];
  onConnected: (made: { name: string; slug: string; token: string }) => void;
  onCancel: () => void;
}) {
  const connect = useMutation(api.agentProjects.connect);
  const id = useId();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTyped, setSlugTyped] = useState(false);
  const [region, setRegion] = useState<Region>("US");
  // The safe default: a project holds patient data until said otherwise.
  const [patients, setPatients] = useState(true);
  const [providers, setProviders] = useState<string[]>(providersFor(true));
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });

  const allowed = providersFor(patients);
  const setPatientData = (next: boolean) => {
    setPatients(next);
    setProviders(providersFor(next));
  };
  const fill = (suggested: (typeof SUGGESTED_PROJECTS)[number]) => {
    setName(suggested.name);
    setSlug(suggested.slug);
    setSlugTyped(true);
    setRegion(suggested.region);
    setPatientData(suggested.holdsPatientData);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (state.busy) return;
    if (taken.includes(slug)) {
      setState({ busy: false, error: PROJECT_WORDS.taken });
      return;
    }
    setState({ busy: true, error: null });
    try {
      const made = await connect({
        name: name.trim(),
        slug,
        region,
        holdsPatientData: patients,
        allowedProviders: providers.filter((p) => (allowed as readonly string[]).includes(p)),
        entropy: randomNonce(),
      });
      setState({ busy: false, error: null });
      onConnected({ name: name.trim(), slug: made.slug, token: made.token });
    } catch (failure) {
      setState({ busy: false, error: messageOf(failure, PROJECT_WORDS.tokenNotMade) });
    }
  };

  const suggestions = SUGGESTED_PROJECTS.filter((p) => !taken.includes(p.slug));
  return (
    <form onSubmit={submit} aria-label="Connect a project" className="space-y-4">
      {suggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-2">Fill in:</span>
          {suggestions.map((suggested) => (
            <button
              key={suggested.slug}
              type="button"
              onClick={() => fill(suggested)}
              className="rounded-full bg-surface px-3 py-1 text-xs text-ink outline-none hover:bg-line focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {suggested.name}
            </button>
          ))}
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-3">
        <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-name`}>
          Name
          <input
            id={`${id}-name`}
            required
            maxLength={60}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (!slugTyped) setSlug(slugOf(event.target.value));
            }}
            className={`${fieldClass} mt-1 h-10`}
          />
        </label>
        <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-slug`}>
          Id
          <input
            id={`${id}-slug`}
            required
            maxLength={40}
            pattern="[a-z][a-z0-9\-]{1,39}"
            value={slug}
            onChange={(event) => {
              setSlug(event.target.value);
              setSlugTyped(true);
            }}
            className={`${fieldClass} mt-1 h-10 font-mono`}
          />
        </label>
        <label className="min-w-0 text-sm text-ink" htmlFor={`${id}-region`}>
          Region
          <select
            id={`${id}-region`}
            value={region}
            onChange={(event) => setRegion(event.target.value as Region)}
            className={`${fieldClass} mt-1 h-10`}
          >
            {REGIONS.map((option) => (
              <option key={option} value={option}>
                {REGION_WORDS[option]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex items-start gap-2.5 text-sm text-ink">
        <input
          type="checkbox"
          checked={patients}
          onChange={(event) => setPatientData(event.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-brand"
        />
        <span>
          <span className="font-medium">Holds patient data.</span>{" "}
          <span className="text-ink-2">
            Its agents fail closed when they cannot reach {PRODUCT.name}, and may use providers for real patient data only.
          </span>
        </span>
      </label>
      <fieldset>
        <legend className="text-sm font-medium text-ink">Providers it may use</legend>
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
          {KNOWN_PROVIDERS.map((provider) => {
            const may = allowed.includes(provider);
            return (
              <label key={provider} className="flex items-center gap-2 text-sm text-ink aria-disabled:text-ink-3" aria-disabled={!may}>
                <input
                  type="checkbox"
                  disabled={!may}
                  checked={may && providers.includes(provider)}
                  onChange={(event) =>
                    setProviders((list) =>
                      event.target.checked ? [...list, provider] : list.filter((p) => p !== provider),
                    )
                  }
                  className="size-4 shrink-0 accent-brand"
                />
                {providerLabel(provider)}
                {!PROVIDER_INFO[provider].patientData && <span className="text-xs text-ink-2">(not for patient data)</span>}
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={state.busy} className={primaryButtonClass}>
          {state.busy ? "Connecting…" : "Connect and show its token"}
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
