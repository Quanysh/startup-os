"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { MailGroup } from "@convex/lib/mirrorRules";
import { Panel } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { SetupLink, useFreshness } from "@/components/work/personal-source";
import { useNow } from "@/hooks/use-now";
import { ageLabel } from "@/lib/freshness";

type Thread = NonNullable<
  ReturnType<typeof useQuery<typeof api.workTools.needsReply>>
>["threads"][number];

const GROUPS: { id: MailGroup; label: string }[] = [
  { id: "investor", label: "Investors" },
  { id: "customer", label: "Customers" },
  { id: "other", label: "Other" },
];

/** Gmail's thread ids are hexadecimal. Anything else is shown but never linked. */
const THREAD_ID = /^[0-9a-f]{1,32}$/;

function Row({ thread, now }: { thread: Thread; now: number | null }) {
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink" title={thread.fromAddress}>
          {thread.fromName || thread.fromAddress}
        </span>
        <span className="block truncate text-sm text-ink-2">{thread.subject}</span>
      </span>
      {now !== null && (
        <span className="shrink-0 text-xs text-ink-3">{ageLabel(now, thread.lastMessageAt)}</span>
      )}
    </>
  );
  const rowClass = "-mx-2 flex items-baseline gap-3 rounded-inner px-2 py-2";
  if (!THREAD_ID.test(thread.threadId)) return <span className={rowClass}>{body}</span>;
  return (
    <a
      href={`https://mail.google.com/mail/#inbox/${thread.threadId}`}
      target="_blank"
      rel="noreferrer noopener"
      className={`${rowClass} outline-none hover:bg-surface focus-visible:ring-3 focus-visible:ring-ring/50`}
    >
      {body}
    </a>
  );
}

/** The viewer's own inbox threads waiting on them: sender, subject and age. Never a body. */
export function NeedsReplyPanel() {
  const data = useQuery(api.workTools.needsReply);
  const now = useNow();
  const freshness = useFreshness();

  return (
    <Panel aria-labelledby="needs-reply">
      <h3 id="needs-reply" className="text-sm font-medium text-ink">
        Mail to reply to
      </h3>
      {data === undefined ? (
        <Skeleton data-testid="needs-reply-loading" className="mt-4 h-32 rounded-inner" />
      ) : data.source.lastOkAt === null ? (
        <p className="mt-3 text-sm text-ink-2">
          Gmail has not been read yet. <SetupLink />
        </p>
      ) : (
        <>
          {data.threads.length === 0 ? (
            <p className="mt-3 text-sm text-ink">No mail is waiting on a reply.</p>
          ) : (
            <div className="mt-3 space-y-4">
              {GROUPS.map(({ id, label }) => {
                // Already oldest first, as the query returns them.
                const threads = data.threads.filter((thread) => thread.group === id);
                if (threads.length === 0) return null;
                return (
                  <section key={id} aria-labelledby={`needs-reply-${id}`}>
                    <h4 id={`needs-reply-${id}`} className="text-xs font-medium text-ink-2">
                      {label} ({threads.length})
                    </h4>
                    <ul className="mt-1">
                      {threads.map((thread) => (
                        <li key={thread.threadId}>
                          <Row thread={thread} now={now} />
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          )}
          {data.source.state !== "ok" && (
            <p className="mt-4 text-xs text-ink-2">
              The last read failed, so this list may be out of date.
            </p>
          )}
          <p className="mt-4 text-xs text-ink-3">
            {freshness(now === null ? null : ageLabel(now, data.source.lastOkAt))} Senders and
            subjects only; archive or reply in Gmail to clear a thread.
          </p>
        </>
      )}
    </Panel>
  );
}
