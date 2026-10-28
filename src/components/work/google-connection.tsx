"use client";

import { useMutation, useQuery } from "convex/react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import { PRODUCT } from "@convex/lib/identity";
import { Panel, primaryButtonClass, quietButtonClass } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/work/confirm-dialog";
import { useNow } from "@/hooks/use-now";
import { messageOf } from "@/lib/errors";
import { ageLabel } from "@/lib/freshness";
import { cn } from "@/lib/utils";
import { challengeOf, randomNonce } from "@/lib/work/pkce";

/** What the callback reported, by the one word it put in the address. */
export const GOOGLE_RESULTS: Record<string, string> = {
  connected: "Google is connected. The first read is running.",
  declined: "Google was not connected: the request was declined.",
  expired: "That connect attempt expired. Start again.",
  no_refresh_token:
    `Google did not return a lasting grant. Remove ${PRODUCT.name} under Google Account → Security → Third-party access, then connect again.`,
  missing_scope:
    "Google was connected without mail or calendar access, so nothing was stored. Connect again and leave both boxes ticked.",
  wrong_account: "That was not the owner's Google account, so nothing was stored.",
  failed: "Google could not be connected. Try again.",
};

/**
 * The outcome of a connect attempt, from `?google=`. Any value that is not one
 * of the seven words shows nothing: the address bar is not a place to put text
 * on this page. Reads the search params, so it needs a Suspense boundary.
 *
 * "connected" is the one word that claims something, and anyone can send a
 * link that ends in it: it is shown only while the deployment itself says
 * Google is connected.
 */
export function GoogleResult() {
  const word = useSearchParams().get("google") ?? "";
  const connection = useQuery(api.google.connection);
  const believed = word !== "connected" || connection?.connected === true;
  const text =
    believed && Object.hasOwn(GOOGLE_RESULTS, word) ? GOOGLE_RESULTS[word] : undefined;
  return (
    <p role="status" className="text-sm text-ink">
      {text}
    </p>
  );
}

const AUTH_PREFIX = "https://accounts.google.com/";

export function GoogleConnection({
  navigate = (url: string) => window.location.assign(url),
}: {
  /** Where "Connect Google" sends the browser. A prop so a test can watch it. */
  navigate?: (url: string) => void;
}) {
  const connection = useQuery(api.google.connection);
  const begin = useMutation(api.google.begin);
  const disconnect = useMutation(api.google.disconnect);
  const now = useNow();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [disconnected, setDisconnected] = useState(false);

  const connect = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setDisconnected(false);
    try {
      const state = randomNonce();
      const verifier = randomNonce();
      const challenge = await challengeOf(verifier);
      const url = await begin({ state, verifier, challenge });
      // The browser leaves for Google's own sign-in page and nowhere else.
      if (!url.startsWith(AUTH_PREFIX)) throw new Error("unexpected destination");
      navigate(url);
    } catch (failure) {
      setError(messageOf(failure, "Google could not be reached. Try again."));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await disconnect({});
      setConfirming(false);
      setDisconnected(true);
    } catch (failure) {
      setError(messageOf(failure, "Google could not be disconnected. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel aria-labelledby="google-connection">
      <h2 id="google-connection" className="text-base">
        Google
      </h2>
      {connection === undefined ? (
        <Skeleton data-testid="google-loading" className="mt-4 h-16 rounded-inner" />
      ) : connection.connected ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-ink">
            Connected{now !== null && connection.connectedAt !== null
              ? ` ${ageLabel(now, connection.connectedAt)}`
              : ""}
            .
          </p>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
            className={cn(quietButtonClass, "-ml-4 hover:text-destructive")}
          >
            Disconnect and delete
          </button>
        </div>
      ) : connection.missingEnv.length > 0 ? (
        <p className="mt-3 text-sm text-ink-2">
          Google cannot be connected yet. Set{" "}
          {connection.missingEnv.map((name, i) => (
            <span key={name}>
              {i > 0 && ", "}
              <code className="rounded bg-surface px-1 py-0.5 font-mono text-[11px] text-ink">
                {name}
              </code>
            </span>
          ))}{" "}
          in the Convex dashboard.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-ink">Not connected.</p>
          <p className="max-w-2xl text-sm text-ink-2">
            {PRODUCT.name} will ask to see message headers (sender, subject, date, labels) and your
            calendar&apos;s events. It cannot read message bodies, send mail or change anything.
          </p>
          {/* aria-disabled, not disabled: a natively disabled button drops focus. */}
          <button
            type="button"
            aria-disabled={busy}
            onClick={connect}
            className={cn(primaryButtonClass, "aria-disabled:opacity-60")}
          >
            Connect Google
          </button>
        </div>
      )}

      {disconnected && connection?.connected === false && (
        <p role="status" className="mt-3 text-sm text-ink-2">
          Disconnected. To be sure, also remove {PRODUCT.name} under Google Account → Security →
          Third-party access.
        </p>
      )}
      {error && !confirming && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {confirming && (
        <ConfirmDialog
          title="Disconnect Google?"
          confirmLabel="Disconnect and delete"
          busy={busy}
          error={error}
          onConfirm={remove}
          onKeep={() => {
            setConfirming(false);
            setError(null);
          }}
        >
          This deletes the inbox list and meetings stored here and asks Google to revoke access.
        </ConfirmDialog>
      )}
    </Panel>
  );
}
