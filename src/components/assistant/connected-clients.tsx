"use client";

import { useMutation, useQuery } from "convex/react";
import { useId, useState, type FormEvent } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import {
  CLIENT_WORDS,
  MAX_CLIENT_NAME,
  TOKEN_NOT_MADE,
  type AgentScope,
} from "@convex/lib/agentRules";
import { PRODUCT } from "@convex/lib/identity";
import { CONSENT_WORDS } from "@convex/lib/oauthRules";
import { CopyButton, codeClass } from "@/components/assistant/copy-button";
import { Panel, fieldClass, outlineButtonClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import {
  ActionsHeader,
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
} from "@/components/ui/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { KindTag } from "@/components/ui/status-chip";
import { ConfirmDialog } from "@/components/work/confirm-dialog";
import { useNow } from "@/hooks/use-now";
import {
  CLAUDE_AI_STEPS,
  GROK_APP_STEPS,
  TOKEN_PLACEHOLDER,
  grokTools,
  mcpAddCommand,
  mcpJson,
} from "@/lib/assistant/snippets";
import { messageOf } from "@/lib/errors";
import { ageLabel } from "@/lib/freshness";
import { cn } from "@/lib/utils";
import { randomNonce } from "@/lib/work/pkce";

/** What the panel is, in two sentences. */
export const CONNECTED_CLIENTS_INTRO =
  `The AI tools that reach ${PRODUCT.name} for you: each with a token you made for it, or a sign-in you approved. Yours alone.`;

/** The two things a client may do, each in a line. */
export const SCOPES: { scope: AgentScope; label: string; line: string }[] = [
  {
    scope: "read",
    label: "Read only",
    line: "It reads the figures, the boards and the lists. It can change nothing.",
  },
  {
    scope: "act",
    label: "Read and act",
    line: "It can also add and change tasks and deals. Whoever it gives a task to is told, as when you do it yourself.",
  },
];

export const scopeLabel = (scope: AgentScope) => SCOPES.find((entry) => entry.scope === scope)!.label;

type Client = NonNullable<ReturnType<typeof useQuery<typeof api.assistant.clients>>>[number];

/** How a client reaches the OS, in a word. */
export const KIND_LABELS: Record<Client["kind"], string> = {
  token: "Token",
  oauth: "Sign-in",
};

/** The Mac's runner, said on its row. */
export const RUNNER_TAG = "Runs on your Mac";

/** "Only bots may use this client" (docs/assistant.md, "Bots"), on the form and on each row. */
export const BOTS_ONLY_LABEL = "Only bots may use this client";
export const BOTS_ONLY_LINE =
  `A call must name one of your bots (Agents › Bots), so a bot holding this client's credential cannot step outside its profile. ${PRODUCT.name}'s own four agents call only through the Mac runner's token.`;
export const BOTS_ONLY_STATE = { on: "Bots only", off: "Anyone" } as const;

/** What the panel says while a token just made is on the screen. */
type Fresh = { name: string; token: string };

/**
 * "Connected clients": every client the owner connected to the agent
 * endpoint (convex/assistant.ts), making a token for a new one, and how to
 * set up Claude Code, a Grok bot (xAI's API) and claude.ai. `mcpUrl` is the
 * endpoint's address, or null when the site's configuration does not give
 * one a token may be sent to.
 *
 * A token just made lives in this component's state and nowhere else: not in
 * storage, not in the address. Leaving the page loses it for good, which is
 * the point; the server keeps only its fingerprint.
 */
export function ConnectedClients({ mcpUrl }: { mcpUrl: string | null }) {
  const clients = useQuery(api.assistant.clients);
  const now = useNow();
  const [fresh, setFresh] = useState<Fresh | null>(null);
  const [revoking, setRevoking] = useState<Client | null>(null);

  const age = (at: number | null) => (at === null ? "Not yet" : now === null ? "" : ageLabel(now, at));
  const runnerTaken = clients?.some((client) => client.runner) ?? false;

  return (
    <Panel aria-labelledby="connected-clients">
      <h2 id="connected-clients" className="text-base">
        Connected clients
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-ink-2">{CONNECTED_CLIENTS_INTRO}</p>

      {clients === undefined ? (
        <Skeleton data-testid="clients-loading" className="mt-4 h-32 rounded-inner" />
      ) : clients.length === 0 ? (
        <p className="mt-4 text-sm text-ink-2" data-testid="clients-empty">
          No client is connected yet.
        </p>
      ) : (
        // On a phone the kind and the day it was made drop out: the name and the scope are what matter.
        <DataTable caption="Your connected clients" className="min-w-[19rem]" boxClassName="mt-3" download={false}>
          <DataHead>
            <DataHeader pinned>Client</DataHeader>
            <DataHeader hideBelow="sm">Kind</DataHeader>
            <DataHeader>Scope</DataHeader>
            <DataHeader>Who may use it</DataHeader>
            <DataHeader hideBelow="sm">Created</DataHeader>
            <DataHeader>Last used</DataHeader>
            <ActionsHeader />
          </DataHead>
          <DataBody>
            {clients.map((client) => (
              <DataRow key={client.id}>
                <DataRowHeader pinned>
                  <span className="inline-flex flex-wrap items-center gap-2">
                    {/* The owner's words, or a name a client gave itself: text, never markup. */}
                    <span>
                      {client.name}
                      {/* The name a client gave itself and where it signed in from, together: "Cursor · via grok.com". */}
                      {client.host !== null && <span className="font-normal text-ink-3"> · via {client.host}</span>}
                    </span>
                    {client.runner && <KindTag tone="teal">{RUNNER_TAG}</KindTag>}
                  </span>
                </DataRowHeader>
                <DataCell hideBelow="sm">{KIND_LABELS[client.kind]}</DataCell>
                <DataCell>
                  <ScopeToggle client={client} />
                </DataCell>
                <DataCell>
                  <BotsOnlyToggle client={client} />
                </DataCell>
                <DataCell hideBelow="sm">{age(client.createdAt)}</DataCell>
                <DataCell>{age(client.lastUsedAt)}</DataCell>
                <DataCell>
                  <button
                    type="button"
                    aria-label={`Revoke ${client.name}`}
                    onClick={() => setRevoking(client)}
                    className={cn(quietButtonClass, "h-8 px-3 hover:text-destructive")}
                  >
                    Revoke
                  </button>
                </DataCell>
              </DataRow>
            ))}
          </DataBody>
        </DataTable>
      )}

      {clients !== undefined && (
        <CreateToken runnerTaken={runnerTaken} onMade={setFresh} fresh={fresh} />
      )}

      <ClientSetup mcpUrl={mcpUrl} token={fresh?.token ?? null} open={fresh !== null} />

      <HandClients />

      {revoking !== null && (
        <RevokeDialog
          client={revoking}
          onDone={(gone) => {
            setRevoking(null);
            // A token just shown for a client that is now revoked leaves the page.
            if (gone && fresh !== null && fresh.name === revoking.name) setFresh(null);
          }}
        />
      )}
    </Panel>
  );
}

/**
 * What a client may do, changed in place: its next call is checked against
 * it, so a client approved Read only needs no reconnecting to act. The Mac
 * runner's token stays read and act (its tools need it): no button there.
 */
function ScopeToggle({ client }: { client: Client }) {
  const setScope = useMutation(api.assistant.setScope);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = client.scope === "act" ? "read" : "act";
  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await setScope({ kind: client.kind, id: client.id, scope: next });
    } catch (failure) {
      setError(messageOf(failure, "That could not be changed. Try again."));
    } finally {
      setBusy(false);
    }
  };
  const words = next === "act" ? "Allow changes" : "Hold to reading";
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span>{scopeLabel(client.scope)}</span>
      {!client.runner && (
        <button
          type="button"
          aria-disabled={busy}
          aria-label={`${words}: ${client.name}`}
          onClick={toggle}
          className={outlineButtonClass}
        >
          {words}
        </button>
      )}
      {error !== null && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}

/** One click: whether only the owner's bots may use a client. Shows the state, and says what a click does. */
function BotsOnlyToggle({ client }: { client: Client }) {
  const setBotsOnly = useMutation(api.assistant.setBotsOnly);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await setBotsOnly({ kind: client.kind, id: client.id, on: !client.botsOnly });
    } catch (failure) {
      setError(messageOf(failure, "That could not be changed. Try again."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span data-testid={`bots-only-${client.id}`}>{client.botsOnly ? BOTS_ONLY_STATE.on : BOTS_ONLY_STATE.off}</span>
      {client.onlyBot !== null && <span className="text-xs text-ink-3">one bot&apos;s</span>}
      <button
        type="button"
        aria-pressed={client.botsOnly}
        aria-disabled={busy}
        aria-label={`${BOTS_ONLY_LABEL}: ${client.name}`}
        onClick={toggle}
        className={outlineButtonClass}
      >
        {client.botsOnly ? "Let anyone" : "Allow bots only"}
      </button>
      {error !== null && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}

/** Making a token for one more client: its name, what it may do, and whether it is the Mac's runner. */
function CreateToken({
  runnerTaken,
  onMade,
  fresh,
}: {
  runnerTaken: boolean;
  onMade: (fresh: Fresh) => void;
  fresh: Fresh | null;
}) {
  const createToken = useMutation(api.assistant.createToken);
  const ids = { name: useId(), scope: useId(), runner: useId(), runnerLine: useId(), botsOnlyLine: useId() };
  const [name, setName] = useState("");
  const [scope, setScope] = useState<AgentScope>("read");
  const [runner, setRunner] = useState(false);
  // On for a new client, off for the Mac's runner (which runs the four), until the owner says otherwise.
  const [botsOnly, setBotsOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (name.trim() === "") {
      setError(CLIENT_WORDS.nameMissing);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const made = await createToken({
        entropy: randomNonce(),
        scope: runner ? "act" : scope,
        name,
        runner,
        botsOnly,
      });
      onMade({ name: name.trim(), token: made.token });
      setName("");
      setRunner(false);
      setBotsOnly(true);
    } catch (failure) {
      setError(messageOf(failure, TOKEN_NOT_MADE));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6 border-t border-line pt-5">
      {fresh !== null && (
        <div className="mb-6 space-y-3">
          <p className="text-sm font-medium text-ink">
            This is the token for {fresh.name}. You will not see it again.
          </p>
          <code data-testid="fresh-token" className={codeClass}>
            {fresh.token}
          </code>
          <CopyButton text={fresh.token} label="Copy token" />
          <p className="max-w-2xl text-sm text-ink-2">
            It is already in the setup below for Claude Code and for Grok: copy what you need now.{" "}
            {PRODUCT.name} keeps only a fingerprint of it and cannot show it to you later. If you lose it,
            revoke it and make another.
          </p>
        </div>
      )}

      <form onSubmit={submit} noValidate aria-labelledby={`${ids.name}-title`}>
        <h3 id={`${ids.name}-title`} className="text-sm font-medium text-ink">
          Create a token for a client
        </h3>
        <div className="mt-3 max-w-md space-y-1.5">
          <label htmlFor={ids.name} className="text-sm text-ink">
            Name
          </label>
          <input
            id={ids.name}
            value={name}
            maxLength={MAX_CLIENT_NAME}
            onChange={(event) => setName(event.target.value)}
            placeholder="Claude Code on the Mac, Grok bot, …"
            autoComplete="off"
            aria-invalid={error === CLIENT_WORDS.nameMissing ? true : undefined}
            className={cn(fieldClass, "h-10")}
          />
        </div>

        <fieldset className="mt-4" disabled={runner}>
          <legend className="text-sm text-ink">What it may do</legend>
          <div className="mt-2 space-y-2">
            {SCOPES.map((option) => (
              <label key={option.scope} className="flex items-start gap-2.5 text-sm text-ink">
                <input
                  type="radio"
                  name={ids.scope}
                  checked={(runner ? "act" : scope) === option.scope}
                  onChange={() => setScope(option.scope)}
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

        <label className="mt-4 flex items-start gap-2.5 text-sm text-ink">
          <input
            id={ids.runner}
            type="checkbox"
            checked={runner}
            disabled={runnerTaken}
            aria-describedby={ids.runnerLine}
            onChange={(event) => {
              setRunner(event.target.checked);
              setBotsOnly(!event.target.checked);
            }}
            className="mt-0.5 size-4 shrink-0 accent-brand disabled:opacity-60"
          />
          <span>
            <span className="font-medium">It runs the chat and the agents on your Mac.</span>{" "}
            <span id={ids.runnerLine} className="text-ink-2">
              {runnerTaken
                ? "Another client already does this: one at a time."
                : "Only this client may answer the chat and run your four agents. It reads and acts."}
            </span>
          </span>
        </label>

        <label className="mt-4 flex items-start gap-2.5 text-sm text-ink">
          <input
            type="checkbox"
            checked={botsOnly}
            aria-describedby={ids.botsOnlyLine}
            onChange={(event) => setBotsOnly(event.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-brand"
          />
          <span>
            <span className="font-medium">{BOTS_ONLY_LABEL}.</span>{" "}
            <span id={ids.botsOnlyLine} className="text-ink-2">
              {BOTS_ONLY_LINE}
            </span>
          </span>
        </label>

        <div className="mt-4">
          <button
            type="submit"
            aria-disabled={busy}
            className={cn(primaryButtonClass, "aria-disabled:opacity-60")}
          >
            Create token
          </button>
        </div>
        {error !== null && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}

/** Asked before a client is revoked: it cannot be undone. */
function RevokeDialog({ client, onDone }: { client: Client; onDone: (gone: boolean) => void }) {
  const revokeClient = useMutation(api.assistant.revokeClient);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revoke = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await revokeClient({ kind: client.kind, id: client.id });
      onDone(true);
    } catch (failure) {
      setError(messageOf(failure, "That client could not be revoked. Try again."));
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog
      title={`Revoke ${client.name}?`}
      confirmLabel="Revoke"
      busy={busy}
      error={error}
      onConfirm={revoke}
      onKeep={() => onDone(false)}
    >
      It is refused from its next call, until you connect it again. Your other clients go on
      working, and nothing it has already done is undone.
    </ConfirmDialog>
  );
}

/** How to set up each kind of client, with the token just made where it goes. */
function ClientSetup({ mcpUrl, token, open }: { mcpUrl: string | null; token: string | null; open: boolean }) {
  const tokenNote =
    token !== null
      ? "Your new token is in it. Copy it now: after you leave this page it shows a placeholder instead."
      : `It has ${TOKEN_PLACEHOLDER} where the client's token goes.`;
  return (
    <details className="mt-6 border-t border-line pt-4" open={open ? true : undefined}>
      <summary className="cursor-pointer text-sm font-medium text-ink">How to connect a client</summary>
      {mcpUrl === null ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          This site is not configured with the address a client would call, so there is nothing to
          copy yet. Set NEXT_PUBLIC_CONVEX_URL (and NEXT_PUBLIC_OS_URL, if the OS has a public
          address) and build again.
        </p>
      ) : (
        <div className="mt-3 space-y-6">
          <section aria-labelledby="setup-claude-code" className="space-y-2">
            <h3 id="setup-claude-code" className="text-sm font-medium text-ink">
              Claude Code
            </h3>
            <p className="max-w-2xl text-sm text-ink-2" data-testid="snippet-note">
              Save this as <code className="font-mono text-xs text-ink">.mcp.json</code> in the folder
              you run Claude Code from, or add the <code className="font-mono text-xs text-ink">startup-os</code>{" "}
              entry to the one you have. {tokenNote} The file holds the token: keep it out of git.
            </p>
            <CopyButton text={mcpJson({ url: mcpUrl, token })} label="Copy .mcp.json" />
            <pre
              data-testid="mcp-json"
              tabIndex={0}
              aria-label="The .mcp.json for Claude Code"
              className={cn(codeClass, "whitespace-pre")}
            >
              {mcpJson({ url: mcpUrl, token })}
            </pre>
            <p className="max-w-2xl text-sm text-ink-2">
              Or the same as a command. It always shows {TOKEN_PLACEHOLDER}: put the token in by hand,
              so it is never copied onto a command line from here.
            </p>
            <CopyButton text={mcpAddCommand(mcpUrl)} label="Copy command" />
            <pre
              data-testid="mcp-command"
              tabIndex={0}
              aria-label="The claude mcp add command"
              className={cn(codeClass, "whitespace-pre")}
            >
              {mcpAddCommand(mcpUrl)}
            </pre>
          </section>

          <section aria-labelledby="setup-grok" className="space-y-2">
            <h3 id="setup-grok" className="text-sm font-medium text-ink">
              Grok (xAI API)
            </h3>
            <p className="max-w-2xl text-sm text-ink-2">
              Give a request to xAI&apos;s API this remote MCP tool. Make the bot a token of its own
              above, read only unless it should change things. {tokenNote}
            </p>
            <CopyButton text={grokTools({ url: mcpUrl, token })} label="Copy Grok tool" />
            <pre
              data-testid="grok-tools"
              tabIndex={0}
              aria-label="The remote MCP tool for xAI's API"
              className={cn(codeClass, "whitespace-pre")}
            >
              {grokTools({ url: mcpUrl, token })}
            </pre>
          </section>

          <section aria-labelledby="setup-claude-ai" className="space-y-2">
            <h3 id="setup-claude-ai" className="text-sm font-medium text-ink">
              claude.ai (web, phone, routines)
            </h3>
            <p className="max-w-2xl text-sm text-ink-2">
              claude.ai signs in to {PRODUCT.name} instead of taking a token. You approve it on a page of{" "}
              {PRODUCT.name}, and it then appears in the list above.
            </p>
            <ol className="max-w-2xl list-decimal space-y-1 pl-5 text-sm text-ink-2" data-testid="claude-ai-steps">
              {CLAUDE_AI_STEPS.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <CopyButton text={mcpUrl} label="Copy address" />
            <code data-testid="claude-ai-url" className={codeClass}>
              {mcpUrl}
            </code>
          </section>

          <section aria-labelledby="setup-grok-app" className="space-y-2">
            <h3 id="setup-grok-app" className="text-sm font-medium text-ink">
              Grok app
            </h3>
            <p className="max-w-2xl text-sm text-ink-2">
              Grok&apos;s own connectors sign in as claude.ai does, with the same address.
            </p>
            <ol className="max-w-2xl list-decimal space-y-1 pl-5 text-sm text-ink-2" data-testid="grok-app-steps">
              {GROK_APP_STEPS.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </section>

          <p className="max-w-2xl text-xs text-ink-3">
            Each bot has its own limits, on Agents › Bots. Payroll, tokens, team and source settings, and your own
            mail, calendar and meeting notes are never available through it.
          </p>
        </div>
      )}
    </details>
  );
}

/**
 * OAuth clients the owner adds by hand: for a connector screen that asks for
 * a client ID and a client secret rather than registering itself. The secret
 * is shown once, in this component's state alone; the server keeps its
 * SHA-256. Such a client still signs in with PKCE and the owner's approval.
 */
function HandClients() {
  const hand = useQuery(api.oauth.handClients);
  const createClient = useMutation(api.oauth.createClient);
  const ids = { name: useId(), uris: useId() };
  const [name, setName] = useState("");
  const [uris, setUris] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ clientId: string; clientSecret: string } | null>(null);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (name.trim() === "") {
      setError(CONSENT_WORDS.nameMissing);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const lines = uris.split("\n").map((line) => line.trim()).filter((line) => line !== "");
      setMade(await createClient({ name, redirectUris: lines, entropy: randomNonce() }));
      setName("");
      setUris("");
    } catch (failure) {
      setError(messageOf(failure, "That client could not be added. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="mt-6 border-t border-line pt-4" open={made !== null ? true : undefined}>
      <summary className="cursor-pointer text-sm font-medium text-ink">Add an OAuth client by hand</summary>
      <p className="mt-2 max-w-2xl text-sm text-ink-2">
        For a connector that asks for a client ID and a client secret instead of signing up by
        itself. It still asks you to approve it here before it can read anything.
      </p>

      {hand !== undefined && hand.length > 0 && (
        <ul data-testid="hand-clients" className="mt-3 space-y-2">
          {hand.map((client) => (
            <li key={client.id} className="flex flex-wrap items-start justify-between gap-2 rounded-inner bg-surface px-3 py-2">
              <span className="min-w-0 text-sm text-ink">
                <span className="block font-medium break-words">{client.name}</span>
                <code className="block font-mono text-xs break-all text-ink-2">{client.clientId}</code>
                {client.redirectUris.map((uri) => (
                  <span key={uri} className="block text-xs break-all text-ink-3">
                    {uri}
                  </span>
                ))}
              </span>
              <button
                type="button"
                aria-label={`Remove ${client.name}`}
                onClick={() => setRemoving({ id: client.id, name: client.name })}
                className={cn(quietButtonClass, "h-8 px-3 hover:text-destructive")}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {made !== null && (
        <div className="mt-4 space-y-2">
          <p className="text-sm font-medium text-ink">Paste these into the connector. You will not see the secret again.</p>
          <p className="text-xs text-ink-2">Client ID</p>
          <code data-testid="hand-client-id" className={codeClass}>
            {made.clientId}
          </code>
          <CopyButton text={made.clientId} label="Copy client ID" />
          <p className="text-xs text-ink-2">Client secret</p>
          <code data-testid="hand-secret" className={codeClass}>
            {made.clientSecret}
          </code>
          <CopyButton text={made.clientSecret} label="Copy client secret" />
        </div>
      )}

      <form onSubmit={submit} noValidate className="mt-4 max-w-md space-y-3">
        <div className="space-y-1.5">
          <label htmlFor={ids.name} className="text-sm text-ink">
            Client name
          </label>
          <input
            id={ids.name}
            value={name}
            maxLength={MAX_CLIENT_NAME}
            onChange={(event) => setName(event.target.value)}
            placeholder="Grok app"
            autoComplete="off"
            className={cn(fieldClass, "h-10")}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor={ids.uris} className="text-sm text-ink">
            Redirect URIs
          </label>
          <textarea
            id={ids.uris}
            value={uris}
            rows={2}
            onChange={(event) => setUris(event.target.value)}
            placeholder="https://… (one a line, as the connector shows it)"
            className={cn(fieldClass, "py-2")}
          />
        </div>
        <button type="submit" aria-disabled={busy} className={cn(primaryButtonClass, "aria-disabled:opacity-60")}>
          Add client
        </button>
        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </form>

      {removing !== null && <RemoveHandClient client={removing} onDone={() => setRemoving(null)} />}
    </details>
  );
}

function RemoveHandClient({ client, onDone }: { client: { id: string; name: string }; onDone: () => void }) {
  const removeClient = useMutation(api.oauth.removeClient);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await removeClient({ id: client.id as Id<"oauthClients"> });
      onDone();
    } catch (failure) {
      setError(messageOf(failure, "That client could not be removed. Try again."));
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog
      title={`Remove ${client.name}?`}
      confirmLabel="Remove"
      busy={busy}
      error={error}
      onConfirm={remove}
      onKeep={onDone}
    >
      Its client ID and secret stop working. Its sign-ins end with it, and it is refused from its
      next call.
    </ConfirmDialog>
  );
}
