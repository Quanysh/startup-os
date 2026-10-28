"use client";

import type { FunctionReturnType } from "convex/server";
import Link from "next/link";
import { Fragment } from "react";
import type { api } from "@convex/_generated/api";
import { DecidedRow } from "@/components/approvals/decided";
import { useInbox } from "@/components/approvals/inbox";
import { ApprovalCard } from "@/components/approvals/row";
import { Skeleton } from "@/components/ui/skeleton";
import { KindTag } from "@/components/ui/status-chip";
import { stepChips, textParts } from "@/lib/assistant/chat";
import { cn } from "@/lib/utils";

type Listed = NonNullable<FunctionReturnType<typeof api.chat.messages>>;
export type ChatMessage = Listed["messages"][number];

/**
 * Text a model or the owner wrote, shown as text with its lines kept: markup
 * in it appears as the characters it is. A path from the closed list of the
 * app's own pages, standing as a word, is made a link (`textParts`); nothing
 * else of the text ever is.
 */
export function PlainText({ text, className }: { text: string; className?: string }) {
  return (
    <p className={cn("text-sm whitespace-pre-wrap [overflow-wrap:anywhere]", className)}>
      {textParts(text).map((part, index) =>
        "page" in part ? (
          <Link
            key={index}
            href={part.page}
            className="rounded-sm font-medium text-brand underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {part.page}
          </Link>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </p>
  );
}

/** What Claude read to answer, as chips: tool names put into words, never what a tool returned. */
function Steps({ steps }: { steps: readonly string[] }) {
  const chips = stepChips(steps);
  if (chips.length === 0) return null;
  return (
    <ul aria-label="What Claude read" className="flex flex-wrap gap-1.5" data-testid="steps">
      {chips.map((chip) => (
        <li key={chip.label}>
          <KindTag tone="slate">
            {chip.label}
            {chip.times > 1 && ` ×${chip.times}`}
          </KindTag>
        </li>
      ))}
    </ul>
  );
}

type Card = ChatMessage["proposals"][number];

/**
 * A proposal this answer made, as /approvals shows it: while it is open, the
 * inbox's own row (`assistant.inbox`: who, urgency, goal, a possible
 * duplicate, what changes) with the same Edit, Approve and Reject; once
 * decided, the "Decided" row.
 */
function ProposalOfAnswer({ card, now, waiting }: { card: Card; now: number | null; waiting: ReturnType<typeof useInbox> }) {
  if (card.status !== "open") {
    return (
      <li className="rounded-inner border border-line px-4">
        <ul>
          <DecidedRow row={{ ...card, tool: null, toolName: null, arguments: null }} now={now} />
        </ul>
      </li>
    );
  }
  const row = waiting?.find((one) => one.id === card.id);
  if (row === undefined || now === null) {
    return (
      <li>
        <Skeleton className="h-24 rounded-inner" data-testid="proposal-loading" />
      </li>
    );
  }
  return <ApprovalCard row={row} now={now} />;
}

function Answer({ message, now }: { message: ChatMessage; now: number | null }) {
  const waiting = message.status === "queued";
  const working = message.status === "working";
  // The one inbox read, asked only when this answer made a proposal.
  const inbox = useInbox(message.proposals.some((card) => card.status === "open"));
  return (
    <li className="border-l-2 border-line pl-4" data-testid="answer" data-status={message.status}>
      <span className="sr-only">Claude: </span>
      {(waiting || working) && (
        <p className="flex items-center gap-2 text-xs text-ink-2" role="status">
          <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-brand" />
          {waiting ? "Waiting for your Mac to pick this up." : "Claude is answering."}
        </p>
      )}
      {message.text !== "" && (
        <PlainText text={message.text} className={cn("text-ink", (waiting || working) && "mt-2")} />
      )}
      {message.failure !== null && (
        <p className={cn("text-sm text-ink-2", message.text !== "" && "mt-2")} data-testid="failure">
          {message.failure}
        </p>
      )}
      {message.steps.length > 0 && (
        <div className="mt-2.5">
          <Steps steps={message.steps} />
        </div>
      )}
      {message.proposals.length > 0 && (
        <ul className="mt-3 space-y-3" aria-label="Proposals from this answer">
          {message.proposals.map((card) => (
            <ProposalOfAnswer key={card.id} card={card} now={now} waiting={inbox} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** One conversation, oldest first: the owner's questions and Claude's answers. */
export function Conversation({ messages, now }: { messages: readonly ChatMessage[]; now: number | null }) {
  return (
    <ol className="space-y-5" data-testid="conversation">
      {messages.map((message) =>
        message.role === "user" ? (
          <li key={message.id} className="flex justify-end" data-testid="question">
            <div className="max-w-[85%] rounded-inner bg-surface px-3.5 py-2.5">
              <span className="sr-only">You: </span>
              <PlainText text={message.text} className="text-ink" />
            </div>
          </li>
        ) : (
          <Answer key={message.id} message={message} now={now} />
        ),
      )}
    </ol>
  );
}
