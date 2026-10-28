"use client";

import { useMutation, useQuery } from "convex/react";
import { ShieldCheckIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useId, useState } from "react";
import { api } from "@convex/_generated/api";
import type { AgentScope } from "@convex/lib/agentRules";
import { PRODUCT } from "@convex/lib/identity";
import { CONSENT_WORDS } from "@convex/lib/oauthRules";
import { SCOPES, scopeLabel } from "@/components/assistant/connected-clients";
import { primaryButtonClass, quietButtonClass } from "@/components/panel";
import { ProductLogo } from "@/components/brand-logo";
import { ThemeSwitch } from "@/components/theme-provider";
import { Skeleton } from "@/components/ui/skeleton";
import { messageOf } from "@/lib/errors";
import { leaveTo } from "@/lib/os/navigate";
import { cn } from "@/lib/utils";
import { randomNonce } from "@/lib/work/pkce";

/**
 * OAuth's consent page (convex/oauth.ts): a client that signs in to the agent
 * endpoint (claude.ai, the Grok app, …) sends the owner here with its
 * request. The owner sees which client it is and where the browser will be
 * sent, chooses what it may do, and approves or denies. Approving makes a
 * code the client exchanges for its tokens; the client then appears among the
 * connected clients on Settings › Connections, where it is revoked.
 *
 * The owner's alone, for now: a teammate is told so, and the request is never
 * even described to them (`oauth.describe` is owner-only too). A signed-out
 * visitor was sent to sign in first, and back here after (src/proxy.ts).
 * What the client sent is passed to the server as it is; every check is the
 * server's. A client's name is text it chose: rendered as text.
 */
export default function AuthorizePage() {
  return (
    <main className="wash-brand relative flex min-h-dvh items-center justify-center px-4 py-10">
      <ThemeSwitch className="absolute top-4 right-4" />
      <div className="w-full max-w-md rounded-card bg-panel p-6 shadow-soft sm:p-8">
        <ProductLogo />
        <Suspense fallback={<Skeleton className="mt-8 h-48 rounded-inner" />}>
          <Consent />
        </Suspense>
      </div>
    </main>
  );
}

/** The request as the server's functions take it, from the address the client sent. */
function requestOf(params: URLSearchParams) {
  const optional = (name: string) => params.get(name) ?? undefined;
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  if (clientId === null || redirectUri === null) return null;
  return {
    clientId,
    redirectUri,
    responseType: optional("response_type"),
    codeChallenge: optional("code_challenge"),
    codeChallengeMethod: optional("code_challenge_method"),
    scope: optional("scope"),
    resource: optional("resource"),
    state: optional("state"),
  };
}

function Refusal({ words }: { words: string }) {
  return (
    <p role="alert" className="mt-8 text-sm text-destructive">
      {words}
    </p>
  );
}

function Consent() {
  const params = useSearchParams();
  const request = requestOf(params);
  const viewer = useQuery(api.viewer.me);
  const owner = viewer != null && viewer.isOwner;
  const described = useQuery(api.oauth.describe, owner && request !== null ? request : "skip");
  const approve = useMutation(api.oauth.approve);
  const scopeName = useId();
  const [granted, setGranted] = useState<AgentScope>("read");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (viewer === undefined) return <Skeleton data-testid="consent-loading" className="mt-8 h-48 rounded-inner" />;
  if (viewer === null || !viewer.isOwner) return <Refusal words={CONSENT_WORDS.ownerOnly} />;
  if (request === null) return <Refusal words={CONSENT_WORDS.badRequest} />;
  if (described === undefined) return <Skeleton data-testid="consent-loading" className="mt-8 h-48 rounded-inner" />;
  if (described.status === "invalid") return <Refusal words={described.words} />;
  if (described.status === "error") {
    return (
      <>
        <Refusal words={CONSENT_WORDS.badRequest} />
        <button
          type="button"
          onClick={() => leaveTo(described.redirect)}
          className={cn(quietButtonClass, "mt-4 bg-surface text-ink")}
        >
          Back to the client
        </button>
      </>
    );
  }

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { redirect } = await approve({ ...request, granted, entropy: randomNonce() });
      leaveTo(redirect);
    } catch (failure) {
      setError(messageOf(failure, CONSENT_WORDS.approveFailed));
      setBusy(false);
    }
  };

  return (
    <>
      <h1 className="mt-8 text-2xl break-words">Connect {described.clientName} to {PRODUCT.name}?</h1>
      <p className="mt-3 text-sm text-ink-2">
        It will read {PRODUCT.name} as you, through its MCP endpoint, until you revoke it on Settings ›
        Connections. When you approve, your browser goes back to{" "}
        <span className="font-medium break-all text-ink">{described.redirectHost}</span>.
      </p>
      {described.asked !== null && (
        <p className="mt-2 text-sm text-ink-2">It asked to {scopeLabel(described.asked).toLowerCase()}.</p>
      )}

      <fieldset className="mt-6">
        <legend className="text-sm font-medium text-ink">What it may do</legend>
        <div className="mt-2 space-y-2">
          {SCOPES.map((option) => (
            <label key={option.scope} className="flex items-start gap-2.5 text-sm text-ink">
              <input
                type="radio"
                name={scopeName}
                checked={granted === option.scope}
                onChange={() => setGranted(option.scope)}
                className="mt-0.5 size-4 shrink-0 accent-brand"
              />
              <span>
                <span className="font-medium">{option.label}.</span>{" "}
                <span className="text-ink-2">{option.line}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <p className="mt-5 flex items-start gap-2 text-xs leading-relaxed text-ink-3">
        <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        Payroll, tokens, the team and source settings, and your own mail, calendar and meeting
        notes are never available to it. Approve only a client you just connected yourself.
      </p>

      <div className="mt-6 flex flex-wrap gap-2">
        <button
          type="button"
          aria-disabled={busy}
          onClick={submit}
          className={cn(primaryButtonClass, "aria-disabled:opacity-60")}
        >
          Approve
        </button>
        <button
          type="button"
          onClick={() => leaveTo(described.denyUrl)}
          className={cn(quietButtonClass, "bg-surface text-ink")}
        >
          Deny
        </button>
      </div>
      {error !== null && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  );
}
