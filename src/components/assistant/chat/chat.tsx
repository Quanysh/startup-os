"use client";

import { useMutation, useQuery } from "convex/react";
import { MessagesSquareIcon, PencilIcon, PlusIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useCompany } from "@/components/company-provider";
import { Panel, fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import {
  CHAT_WORDS,
  HOW_IT_WORKS,
  MAX_CHAT_QUESTION_LENGTH,
  MAX_THREAD_TITLE_LENGTH,
  RUNNER_COMMAND,
  runnerLine,
} from "@/lib/assistant/chat";
import { COMPANIES, DEFAULT_COMPANY } from "@/lib/company";
import { messageOf } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { Conversation } from "./conversation";

type ThreadId = Id<"chatThreads">;
const HOW_ID = "how-the-chat-works";
const small = "h-8 px-3 text-xs";

/**
 * Whether the Mac that answers is there, in a line, with the way to start it
 * when it is not. In the Assistant page's header (owner only, as the page is).
 */
export function RunnerStatus() {
  const now = useNow();
  const runner = useQuery(api.chat.runner, {});
  if (runner === undefined || now === null) {
    return <Skeleton data-testid="runner-loading" className="h-5 w-64 rounded-inner" />;
  }
  const line = runnerLine(runner, now);
  const showHow = () => {
    const how = document.getElementById(HOW_ID);
    if (how instanceof HTMLDetailsElement) how.open = true;
  };
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2" data-testid="runner-status" data-there={line.there}>
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", line.there ? "bg-brand" : "bg-ink-3")} />
      <span>
        {line.text}
        {!line.there && (
          <>
            {" "}
            Start it with <code className="rounded bg-surface px-1 py-0.5 font-mono text-[0.6875rem] text-ink">{RUNNER_COMMAND}</code>{" "}
            (
            <a
              href={`#${HOW_ID}`}
              onClick={showHow}
              className="rounded-sm font-medium text-brand underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              see how
            </a>
            ).
          </>
        )}
      </span>
    </p>
  );
}

function HowItWorks() {
  return (
    <details id={HOW_ID} className="mt-5 border-t border-line pt-4 text-sm">
      <summary className="cursor-pointer rounded-sm font-medium text-ink outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        How this works
      </summary>
      <div className="mt-3 max-w-2xl space-y-2 text-ink-2">
        {HOW_IT_WORKS.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </div>
    </details>
  );
}

type Thread = { id: ThreadId; title: string; company: "us" | "kz" };

/** The conversations, newest first. The one open can be renamed, or deleted after a second click. */
function ThreadList({
  threads,
  current,
  onOpen,
  onNew,
  onError,
}: {
  threads: readonly Thread[];
  current: ThreadId | null;
  onOpen: (id: ThreadId | null) => void;
  onNew: () => void;
  onError: (words: string | null) => void;
}) {
  const rename = useMutation(api.chat.rename);
  const remove = useMutation(api.chat.remove);
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view");
  const [title, setTitle] = useState("");
  const titleId = useId();

  const attempt = async (work: () => Promise<unknown>, otherwise: string) => {
    onError(null);
    try {
      await work();
      setMode("view");
    } catch (failure) {
      onError(messageOf(failure, otherwise));
    }
  };
  const save = (event: FormEvent, id: ThreadId) => {
    event.preventDefault();
    void attempt(() => rename({ threadId: id, title }), "That could not be renamed. Try again.");
  };
  const drop = (id: ThreadId) =>
    attempt(async () => {
      await remove({ threadId: id });
      onOpen(null);
    }, "That could not be deleted. Try again.");

  return (
    <nav aria-label="Conversations" className="min-w-0">
      <button type="button" onClick={onNew} className={cn(quietButtonClass, "h-9 w-full justify-start bg-surface px-3 text-ink")}>
        <PlusIcon aria-hidden className="size-4" />
        New conversation
      </button>
      {threads.length > 0 && (
        <ul className="mt-2 max-h-72 space-y-0.5 overflow-y-auto md:max-h-none md:overflow-visible" data-testid="threads">
          {threads.map((thread) => {
            const open = thread.id === current;
            return (
              <li key={thread.id}>
                {open && mode === "rename" ? (
                  <form onSubmit={(event) => save(event, thread.id)} className="space-y-1.5 py-1">
                    <label htmlFor={titleId} className="sr-only">
                      Name of this conversation
                    </label>
                    <input
                      id={titleId}
                      value={title}
                      maxLength={MAX_THREAD_TITLE_LENGTH}
                      onChange={(event) => setTitle(event.target.value)}
                      autoFocus
                      className={cn(fieldClass, "h-9")}
                    />
                    <div className="flex gap-1.5">
                      <button type="submit" className={cn(primaryButtonClass, small)}>
                        Save
                      </button>
                      <button type="button" onClick={() => setMode("view")} className={cn(quietButtonClass, small)}>
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className={cn("group flex items-center gap-0.5 rounded-inner", open && "bg-surface")}>
                    <button
                      type="button"
                      aria-current={open ? "true" : undefined}
                      onClick={() => {
                        setMode("view");
                        onOpen(thread.id);
                      }}
                      className={cn(
                        "min-w-0 flex-1 truncate rounded-inner px-3 py-2 text-left text-sm outline-none hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50",
                        open ? "font-medium text-ink" : "text-ink-2",
                      )}
                    >
                      {thread.title}
                    </button>
                    {open && mode === "view" && (
                      <>
                        <button
                          type="button"
                          aria-label="Rename this conversation"
                          onClick={() => {
                            setTitle(thread.title);
                            setMode("rename");
                          }}
                          className={cn(quietButtonClass, "size-8 shrink-0 px-0")}
                        >
                          <PencilIcon aria-hidden className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label="Delete this conversation"
                          onClick={() => setMode("delete")}
                          className={cn(quietButtonClass, "size-8 shrink-0 px-0")}
                        >
                          <Trash2Icon aria-hidden className="size-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                )}
                {open && mode === "delete" && (
                  <div className="px-3 py-2 text-xs text-ink-2" role="group" aria-label="Delete this conversation?">
                    <p>Delete this conversation and its answers?</p>
                    <div className="mt-1.5 flex gap-1.5">
                      <button type="button" onClick={() => void drop(thread.id)} className={cn(quietButtonClass, small, "bg-surface text-destructive")}>
                        Delete it
                      </button>
                      <button type="button" onClick={() => setMode("view")} className={cn(quietButtonClass, small)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}

/**
 * "Chat": the owner's one place to ask Claude, the main column of the
 * Assistant page. A question is stored and waits for the runner on the
 * owner's Mac, where Claude Code answers it on the owner's own subscription
 * (docs/assistant.md): no model is called from here or from the server. The
 * answer fills in as it is written, through Convex's live queries, and the
 * newest words are kept in view.
 *
 * The conversation open is named in the address (`?thread=`), so a link can
 * lead to one. The conversations are a column from md up and a list to open
 * below it. What Claude wrote is rendered as text
 * (`PlainText`); what it proposes is the Approvals card, and nothing happens
 * without the click.
 */
export function Chat() {
  const company = useCompany() ?? DEFAULT_COMPANY;
  const router = useRouter();
  const params = useSearchParams();
  const current = (params.get("thread") as ThreadId | null) || null;
  const threads = useQuery(api.chat.threads, {});
  // Only an id the list holds is ever asked for: the address is the owner's to type.
  const known = threads?.some((thread) => thread.id === current) ? current : null;
  const listed = useQuery(api.chat.messages, known === null ? "skip" : { threadId: known });
  const send = useMutation(api.chat.send);
  const stop = useMutation(api.chat.stop);
  const now = useNow();
  const fieldId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const listId = useId();
  const scroller = useRef<HTMLDivElement>(null);

  const open = (id: ThreadId | null) => {
    setError(null);
    router.replace(id === null ? "/assistant" : `/assistant?thread=${id}`, { scroll: false });
  };
  const messages = known === null ? [] : (listed?.messages ?? null);
  const pending = messages?.findLast((message) => message.role === "assistant" && (message.status === "queued" || message.status === "working"));
  const answering = pending !== undefined && pending !== null;
  // The newest words in view: on opening a conversation, and as an answer fills in.
  const last = messages?.at(-1);
  const growth = `${known}:${messages?.length ?? 0}:${last?.text.length ?? 0}:${last?.status ?? ""}`;
  useEffect(() => {
    const box = scroller.current;
    if (box !== null) box.scrollTop = box.scrollHeight;
  }, [growth]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const asked = text.trim();
    if (busy || answering) return;
    if (asked === "") {
      setError(CHAT_WORDS.empty);
      return;
    }
    setBusy(true);
    setError(null);
    // Cleared before the save, and given back if the save fails.
    setText("");
    try {
      const sent = await send({ company, text: asked, ...(known === null ? null : { threadId: known }) });
      if (sent.threadId !== known) open(sent.threadId);
    } catch (failure) {
      setText(asked);
      setError(messageOf(failure, "That could not be asked. Try again."));
    } finally {
      setBusy(false);
    }
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter is a new line. Not while a word is being composed.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };
  const halt = async () => {
    if (!pending) return;
    setError(null);
    try {
      await stop({ messageId: pending.id });
    } catch (failure) {
      setError(messageOf(failure, "That could not be stopped. Try again."));
    }
  };

  return (
    <Panel aria-labelledby="chat">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <h2 id="chat" className="text-base">
          Chat
        </h2>
        {/* On a narrow screen the conversations are a list to open; from md up, a column. */}
        <button
          type="button"
          aria-expanded={listOpen}
          aria-controls={listId}
          onClick={() => setListOpen((was) => !was)}
          className={cn(quietButtonClass, "h-8 bg-surface px-3 text-xs text-ink md:hidden")}
        >
          <MessagesSquareIcon aria-hidden className="size-3.5" />
          Conversations{threads !== undefined && threads.length > 0 ? ` (${threads.length})` : ""}
        </button>
      </div>

      <div className="mt-4 grid gap-5 md:h-[min(46rem,calc(100dvh-13rem))] md:min-h-[26rem] md:grid-cols-[15rem_minmax(0,1fr)]">
        <div id={listId} className={cn("min-h-0 md:block md:overflow-y-auto", listOpen ? "block" : "hidden")}>
          {threads === undefined ? (
            <Skeleton data-testid="threads-loading" className="h-24 rounded-inner" />
          ) : (
            <ThreadList
              threads={threads}
              current={known}
              onOpen={(id) => {
                setListOpen(false);
                open(id);
              }}
              onNew={() => {
                setListOpen(false);
                open(null);
                field.current?.focus();
              }}
              onError={setError}
            />
          )}
        </div>

        <div className="flex min-h-[22rem] min-w-0 flex-col md:min-h-0">
          <div ref={scroller} data-testid="chat-scroll" className="min-h-0 flex-1 overflow-y-auto pr-1">
            {messages === null ? (
              <Skeleton data-testid="messages-loading" className="h-32 rounded-inner" />
            ) : messages.length === 0 ? (
              <p className="max-w-2xl text-sm text-ink-2" data-testid="chat-empty">
                Ask about the company in view ({COMPANIES[company].name}): what needs attention, which deals have gone
                quiet, what is due. Claude answers from what the OS holds, and says which page it is on.
              </p>
            ) : (
              <div aria-live="polite">
                <Conversation messages={messages} now={now} />
              </div>
            )}
          </div>

          <form onSubmit={submit} className="mt-4 shrink-0 border-t border-line pt-4">
            <label htmlFor={fieldId} className="sr-only">
              Your question
            </label>
            <textarea
              id={fieldId}
              ref={field}
              value={text}
              rows={2}
              maxLength={MAX_CHAT_QUESTION_LENGTH}
              disabled={answering}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={onKey}
              placeholder={answering ? "Wait for the answer, or stop it." : "Which deals have no next step?"}
              className={cn(fieldClass, "resize-y py-2.5 disabled:opacity-60")}
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-ink-3">Enter sends. Shift+Enter starts a new line.</p>
              {answering ? (
                <button type="button" onClick={() => void halt()} className={cn(quietButtonClass, "h-9 bg-surface px-4 text-ink")}>
                  <SquareIcon aria-hidden className="size-3.5" />
                  Stop
                </button>
              ) : (
                <button type="submit" aria-disabled={busy} className={cn(primaryButtonClass, "h-9 aria-disabled:opacity-60")}>
                  Ask
                </button>
              )}
            </div>
          </form>
          {error !== null && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
      </div>

      <HowItWorks />
    </Panel>
  );
}
