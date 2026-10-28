"use client";

import { CircleCheckIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { openNotificationPanel, useOpenNotification } from "@/components/notifications/notification-bell";
import { AnimatedBorder } from "@/components/ui/animated-border";
import { Skeleton } from "@/components/ui/skeleton";
import { useViewer } from "@/hooks/use-viewer";
import { canOpen } from "@/lib/nav";
import { NEEDS_ANCHOR } from "@/lib/today/opening";
import type { Need, NeedTone } from "@/lib/today/needs";
import { cn } from "@/lib/utils";
import type { NeedsData } from "./use-needs";

/** How many rows show before "Show all". */
export const NEEDS_SHOWN = 8;

const MARK: Record<NeedTone, { dot: string; words: string }> = {
  danger: { dot: "bg-weak", words: "Urgent" },
  watch: { dot: "bg-watch", words: "Soon" },
  brand: { dot: "bg-brand", words: "Waiting on you" },
  quiet: { dot: "bg-ink-3", words: "To fill in" },
};

const actionClass =
  "shrink-0 rounded-sm text-sm font-medium text-brand underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

/** A row's one action: a page of the OS the viewer can open, a pull request on GitHub, or nothing. */
function Action({ need, onNotification }: { need: Need; onNotification: (id: string) => void }) {
  const { areas } = useViewer();
  if (need.href === null) return null;
  if (need.kind === "notification") {
    // Opening it marks it read, as the bell's panel does.
    return (
      <button type="button" onClick={() => onNotification(need.ref)} className={actionClass}>
        {need.action}
        <span className="sr-only">: {need.title}</span>
      </button>
    );
  }
  if (/^https?:\/\//.test(need.href)) {
    return (
      <a href={need.href} target="_blank" rel="noreferrer noopener" className={actionClass}>
        {need.action}
        <span className="sr-only">: {need.title}</span>
      </a>
    );
  }
  // A failed source is fixed on a page some viewers do not have: they are told of it all the same.
  if (!canOpen(areas, need.href)) return null;
  return (
    <Link href={need.href} className={actionClass}>
      {need.action}
      <span className="sr-only">: {need.title}</span>
    </Link>
  );
}

function Row({ need, onNotification }: { need: Need; onNotification: (id: string) => void }) {
  const mark = MARK[need.tone];
  return (
    <li data-need={need.kind} className="flex items-start gap-3 py-3">
      <span aria-hidden className={cn("mt-2 size-2 shrink-0 rounded-full", mark.dot)} />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink [overflow-wrap:anywhere]">
          <span className="sr-only">{mark.words}: </span>
          {need.title}
        </p>
        <p className="mt-0.5 text-xs text-ink-2 [overflow-wrap:anywhere]">{need.why}</p>
      </div>
      <Action need={need} onNotification={onNotification} />
    </li>
  );
}

/**
 * "Needs you": one list, most urgent first, of everything waiting on the
 * viewer (src/lib/today/needs.ts). Each row says what it is, why it is
 * urgent and where it is acted on. The first eight show; the rest are a
 * press away. With nothing, one calm line.
 */
export function NeedsYou({ needs }: { needs: NeedsData | undefined }) {
  const [all, setAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { open } = useOpenNotification({ onError: setError });
  const onNotification = (id: string) => {
    const row = needs?.notifications.get(id);
    if (row !== undefined) open(row);
  };
  const rows = needs?.rows ?? [];
  const shown = all ? rows : rows.slice(0, NEEDS_SHOWN);

  return (
    <section id={NEEDS_ANCHOR} aria-labelledby="needs-you-heading" className="scroll-mt-6">
      <h2 id="needs-you-heading" className="flex items-baseline gap-2 text-base">
        Needs you
        {needs !== undefined && rows.length > 0 && (
          <span className="font-num text-sm font-normal text-ink-2">{rows.length}</span>
        )}
      </h2>
      {error !== null && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {needs === undefined ? (
        <Skeleton data-testid="needs-loading" className="mt-3 h-32 w-full rounded-card" />
      ) : rows.length === 0 ? (
        <p className="mt-2 flex items-center gap-2 text-sm text-ink-2">
          <CircleCheckIcon aria-hidden className="size-4 shrink-0 text-good" />
          Nothing needs you.
        </p>
      ) : (
        // A light goes round what needs the viewer; still under reduced motion.
        <AnimatedBorder className="mt-3" contentClassName="px-5 py-1">
          <ul className="divide-y divide-line">
            {shown.map((need) => (
              <Row key={need.id} need={need} onNotification={onNotification} />
            ))}
          </ul>
          {(rows.length > NEEDS_SHOWN || needs.moreUnread > 0) && (
            <div className="flex flex-wrap gap-x-5 gap-y-2 border-t border-line py-3">
              {rows.length > NEEDS_SHOWN && (
                <button type="button" onClick={() => setAll(!all)} className={actionClass}>
                  {all ? "Show fewer" : `Show all ${rows.length}`}
                </button>
              )}
              {needs.moreUnread > 0 && (
                <button type="button" onClick={openNotificationPanel} className={actionClass}>
                  {needs.moreUnread === 1 ? "1 more notification" : `${needs.moreUnread} more notifications`}
                </button>
              )}
            </div>
          )}
        </AnimatedBorder>
      )}
    </section>
  );
}
