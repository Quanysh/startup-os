"use client";

import { useMutation, useQuery } from "convex/react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "@convex/_generated/api";
import {
  SUGGESTED_RUN,
  TOKEN_PLACEHOLDER,
  TOOL_NAMES,
  connectPrompt,
} from "@convex/lib/connectPrompt";
import { PRODUCT } from "@convex/lib/identity";
import type { MirrorSource } from "@convex/lib/mirrorRules";
import { Panel, primaryButtonClass, quietButtonClass } from "@/components/panel";
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
import { ConfirmDialog } from "@/components/work/confirm-dialog";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { messageOf } from "@/lib/errors";
import { ageLabel } from "@/lib/freshness";
import { cn } from "@/lib/utils";
import { randomNonce } from "@/lib/work/pkce";


/** What the page says it is, in two sentences. Also the empty state on Today. */
export const CONNECT_INTRO =
  "Your own Claude can read your Gmail, Google Calendar, Fireflies and Linear through its connectors and send a short list from each to this page, once a day. Only you see them here: not the owner, and not your teammates.";

/** What is read and what never is, tool by tool. */
export const WHAT_IS_READ: { tool: string; read: string; never: string }[] = [
  {
    tool: "Gmail",
    read: "The sender, subject and time of mail that looks like it needs a reply.",
    never: "Never a message body.",
  },
  {
    tool: "Google Calendar",
    read: "Meeting titles, times and attendees.",
    never: "Never descriptions or links.",
  },
  {
    tool: "Fireflies",
    read: "Meeting summaries and action items.",
    never: "Never transcripts.",
  },
  {
    tool: "Linear",
    read: "The issues assigned to you.",
    never: "Never descriptions or comments. The team's shared board is not changed.",
  },
];

type Asking = { kind: "replace" } | { kind: "revoke" } | { kind: "forget"; source: MirrorSource };

/** A button that copies text and says so, or says that it could not. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" onClick={copy} className={cn(quietButtonClass, "h-9 bg-surface px-3 text-ink")}>
        {state === "copied" ? (
          <CheckIcon aria-hidden className="size-4" />
        ) : (
          <CopyIcon aria-hidden className="size-4" />
        )}
        {label}
      </button>
      <span role="status" className="text-xs text-ink-2">
        {state === "copied" && "Copied."}
        {state === "failed" && "Could not copy. Select the text and copy it by hand."}
      </span>
    </span>
  );
}

export function WhatIsRead() {
  return (
    <ul className="mt-3 space-y-1.5 text-sm text-ink-2">
      {WHAT_IS_READ.map(({ tool, read, never }) => (
        <li key={tool}>
          <span className="font-medium text-ink">{tool}.</span> {read} {never}
        </li>
      ))}
    </ul>
  );
}

/**
 * "Connect your Claude": a teammate's token, the prompt for their Claude
 * scheduled task, and what has arrived. `ingestUrl` is the deployment's
 * ingest endpoint, or null when the site's configuration does not give one.
 */
export function ConnectView({ ingestUrl }: { ingestUrl: string | null }) {
  const status = useQuery(api.connect.status);
  const createToken = useMutation(api.connect.createToken);
  const revokeToken = useMutation(api.connect.revokeToken);
  const forget = useMutation(api.connect.forget);
  const viewer = useViewer();
  const now = useNow();

  // The token just made. Held in this page's memory only: leaving the page,
  // or reloading it, loses it for good, which is the point.
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The examples in the prompt are dated around today (UTC), so the text
  // changes once a day, not with every tick of the clock.
  const today = now === null ? null : new Date(now).toISOString().slice(0, 10);
  const prompt = useMemo(
    () =>
      ingestUrl === null || today === null
        ? null
        : connectPrompt({ ingestUrl, token: fresh, email: viewer.email, today }),
    [ingestUrl, today, fresh, viewer.email],
  );

  const run = async (work: () => Promise<void>, fallback: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
      setAsking(null);
    } catch (failure) {
      setError(messageOf(failure, fallback));
    } finally {
      setBusy(false);
    }
  };
  const make = () =>
    run(async () => {
      const { token } = await createToken({ entropy: randomNonce() });
      setFresh(token);
    }, "That token could not be made. Try again.");
  const revoke = () =>
    run(async () => {
      await revokeToken({});
      setFresh(null);
    }, "That token could not be revoked. Try again.");
  const forgetTool = (source: MirrorSource) =>
    run(async () => {
      await forget({ source });
    }, "Those could not be deleted. Try again.");

  const age = (at: number) => (now === null ? "" : ` ${ageLabel(now, at)}`);

  return (
    <div className="space-y-6">
      {/* A part of Settings › Connections, under its "Send your tools" heading. */}
      <p className="max-w-2xl text-sm text-ink-2">{CONNECT_INTRO}</p>

      <Panel aria-labelledby="connect-what">
        <h2 id="connect-what" className="text-base">
          What is read, and what is not
        </h2>
        <WhatIsRead />
        <p className="mt-3 text-sm text-ink-2">
          Claude only reads: it sends, changes and deletes nothing in those tools.
        </p>
      </Panel>

      {status === undefined ? (
        <Skeleton data-testid="connect-loading" className="h-40 rounded-card" />
      ) : status.owner ? (
        <Panel aria-labelledby="connect-owner">
          <h2 id="connect-owner" className="text-base">
            You are the owner
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-ink-2">
            Your own mail, calendar, meeting notes and the Linear board are connected with Google
            and the switches on this page, not with a personal token. A personal token is for the
            teammates you give Today to.
          </p>
        </Panel>
      ) : (
        <>
          <Panel aria-labelledby="connect-token">
            <h2 id="connect-token" className="text-base">
              1. Create your token
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-ink-2">
              The token lets your Claude send your lists here, and nothing else: it cannot read
              anything from {PRODUCT.name}.
            </p>

            {fresh !== null ? (
              <div className="mt-4 space-y-3">
                <p className="text-sm font-medium text-ink">
                  This is your token. You will not see this again.
                </p>
                <code
                  data-testid="fresh-token"
                  className="block overflow-x-auto rounded-inner bg-surface px-3 py-2 font-mono text-xs text-ink"
                >
                  {fresh}
                </code>
                <CopyButton text={fresh} label="Copy token" />
                <p className="max-w-2xl text-sm text-ink-2">
                  It is already in the prompt in step 2: copy that prompt now. {PRODUCT.name} keeps only
                  a fingerprint of the token and cannot show it to you later. If you lose it, make
                  a new one.
                </p>
              </div>
            ) : status.token === null ? (
              <p className="mt-4 text-sm text-ink-2">You have no token yet.</p>
            ) : (
              <p className="mt-4 text-sm text-ink-2" data-testid="token-state">
                You have a token, created{age(status.token.createdAt)}.{" "}
                {status.token.lastUsedAt === null
                  ? "It has not been used yet."
                  : `Last used${age(status.token.lastUsedAt)}.`}
              </p>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              {status.token === null ? (
                <button
                  type="button"
                  aria-disabled={busy}
                  onClick={make}
                  className={cn(primaryButtonClass, "aria-disabled:opacity-60")}
                >
                  Create your token
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setAsking({ kind: "replace" });
                    }}
                    className={cn(quietButtonClass, "bg-surface text-ink")}
                  >
                    Replace
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setAsking({ kind: "revoke" });
                    }}
                    className={cn(quietButtonClass, "hover:text-destructive")}
                  >
                    Revoke
                  </button>
                </>
              )}
            </div>
            {error !== null && asking === null && (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {error}
              </p>
            )}
          </Panel>

          <Panel aria-labelledby="connect-prompt">
            <h2 id="connect-prompt" className="text-base">
              2. Give your Claude its daily task
            </h2>
            <ol className="mt-2 max-w-2xl list-decimal space-y-1 pl-5 text-sm text-ink-2">
              <li>
                In Claude, connect your own Gmail, Google Calendar, Fireflies and Linear (the ones
                you use).
              </li>
              <li>
                In the Claude desktop app open Scheduled, make a new task, and paste the prompt
                below.
              </li>
              <li>
                Set it to run {SUGGESTED_RUN}. One run covers all four tools; this page is updated
                once a day.
              </li>
              <li>Click “Run now” once, so the connector approvals are stored.</li>
            </ol>
            <p className="mt-2 max-w-2xl text-sm text-ink-2">
              A task runs only while the Claude app is open. A day it does not run changes nothing
              here: yesterday’s lists stay.
            </p>

            {ingestUrl === null ? (
              <p role="alert" className="mt-4 text-sm text-destructive">
                This site is not configured with the address your Claude would send to, so there is
                no prompt to copy yet. Ask the owner to set it.
              </p>
            ) : prompt === null ? (
              <Skeleton data-testid="prompt-loading" className="mt-4 h-40 rounded-inner" />
            ) : (
              <div className="mt-4 space-y-3">
                <p className="text-sm text-ink-2" data-testid="prompt-note">
                  {fresh !== null
                    ? "Your token is in this prompt. Copy it now: after you leave this page the prompt shows a placeholder instead."
                    : `This prompt has ${TOKEN_PLACEHOLDER} where your token goes. Put your token there, or use Replace in step 1 to get a prompt with a new token already in it.`}
                </p>
                <CopyButton text={prompt} label="Copy prompt" />
                <pre
                  data-testid="prompt"
                  tabIndex={0}
                  aria-label="The prompt for your Claude task"
                  className="max-h-96 overflow-auto rounded-inner bg-surface p-3 font-mono text-xs whitespace-pre-wrap text-ink outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {prompt}
                </pre>
              </div>
            )}
          </Panel>

          <Panel aria-labelledby="connect-arrived">
            <h2 id="connect-arrived" className="text-base">
              3. What has arrived
            </h2>
            <DataTable caption="What has arrived, by tool" className="min-w-[26rem]" boxClassName="mt-2">
              <DataHead>
                <DataHeader pinned>Tool</DataHeader>
                <DataHeader>Last received</DataHeader>
                <DataHeader numeric>Held</DataHeader>
                <ActionsHeader />
              </DataHead>
              <DataBody>
                {status.tools.map((tool) => (
                  <DataRow key={tool.source}>
                    <DataRowHeader pinned>{TOOL_NAMES[tool.source]}</DataRowHeader>
                    <DataCell data-testid={`received-${tool.source}`}>
                      {tool.lastOkAt === null ? (
                        <Blank>Nothing yet</Blank>
                      ) : now === null ? (
                        ""
                      ) : (
                        ageLabel(now, tool.lastOkAt)
                      )}
                    </DataCell>
                    <DataCell numeric>{tool.held}</DataCell>
                    <DataCell actions>
                      {tool.held > 0 && (
                        <button
                          type="button"
                          aria-label={`Forget these: ${TOOL_NAMES[tool.source]}`}
                          onClick={() => {
                            setError(null);
                            setAsking({ kind: "forget", source: tool.source });
                          }}
                          className={cn(rowActionClass, "hover:text-destructive")}
                        >
                          Forget these
                        </button>
                      )}
                    </DataCell>
                  </DataRow>
                ))}
              </DataBody>
            </DataTable>
            <p className="mt-3 max-w-2xl text-xs text-ink-3">
              Updated once a day by your Claude task. A tool that receives nothing for 30 days is
              emptied; meeting notes are kept 90 days after the meeting.
            </p>
          </Panel>
        </>
      )}

      {asking?.kind === "replace" && (
        <ConfirmDialog
          title="Replace your token?"
          confirmLabel="Replace"
          busy={busy}
          error={error}
          onConfirm={make}
          onKeep={() => {
            setAsking(null);
            setError(null);
          }}
        >
          The token you have now stops working at once, and your Claude task will be refused until
          you paste the new prompt into it. What has already arrived stays.
        </ConfirmDialog>
      )}
      {asking?.kind === "revoke" && (
        <ConfirmDialog
          title="Revoke your token?"
          confirmLabel="Revoke"
          busy={busy}
          error={error}
          onConfirm={revoke}
          onKeep={() => {
            setAsking(null);
            setError(null);
          }}
        >
          Your Claude task will be refused from now on. What has already arrived stays until you
          forget it in step 3, or until it is 30 days old.
        </ConfirmDialog>
      )}
      {asking?.kind === "forget" && (
        <ConfirmDialog
          title={`Forget what arrived from ${TOOL_NAMES[asking.source]}?`}
          confirmLabel="Forget these"
          busy={busy}
          error={error}
          onConfirm={() => forgetTool(asking.source)}
          onKeep={() => {
            setAsking(null);
            setError(null);
          }}
        >
          This deletes your {TOOL_NAMES[asking.source]} items from {PRODUCT.name}. Nothing in{" "}
          {TOOL_NAMES[asking.source]} itself changes, and the next run of your Claude task sends
          them again.
        </ConfirmDialog>
      )}
    </div>
  );
}
