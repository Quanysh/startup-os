"use client";

import { useMutation, useQuery } from "convex/react";
import { BellIcon, BotIcon, MessagesSquareIcon, SendIcon, SparklesIcon, UserIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@convex/_generated/api";
import { MAX_NOTIFICATIONS, NOTIFICATION_PAGE } from "@convex/lib/limits";
import { initialsOf } from "@/components/tasks/assignee";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { KindTag } from "@/components/ui/status-chip";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { COMPANIES } from "@/lib/company";
import { messageOf } from "@/lib/errors";
import { ageLabel } from "@/lib/freshness";
import { badgeText, bellLabel, sentenceOf, type Notification } from "@/lib/notifications";
import { cn } from "@/lib/utils";

const ring = "outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/** Who did it, for the eye: a person's initials, or a mark for nobody in particular. */
function ActorChip({ actor }: { actor: Notification["actor"] }) {
  const base = "flex size-8 shrink-0 items-center justify-center rounded-full";
  if (actor.type === "user" && actor.name !== null) {
    return (
      <span
        aria-hidden
        data-initials
        className={cn(base, "bg-brand/12 text-[11px] font-semibold tracking-wide text-brand")}
      >
        {initialsOf(actor.name)}
      </span>
    );
  }
  const Icon =
    actor.type === "user"
      ? UserIcon
      : actor.type === "agent"
        ? SparklesIcon
        : actor.type === "bot"
          ? BotIcon
          : actor.source === "standup"
          ? MessagesSquareIcon
          : SendIcon;
  return (
    <span aria-hidden className={cn(base, "bg-surface text-ink-3")}>
      <Icon className="size-4" />
    </span>
  );
}

/** What "Show all" on Today sends: the bell that is on screen opens its panel. */
export const OPEN_NOTIFICATIONS_EVENT = "startup-os:open-notifications";
export const openNotificationPanel = () => window.dispatchEvent(new Event(OPEN_NOTIFICATIONS_EVENT));

/**
 * Opening a notification: it is marked read, and it leads to its task when
 * there is one the viewer may open on the board. Shared by the bell's panel
 * and Today's list, so both do exactly the same.
 */
export function useOpenNotification({
  onLeave,
  onError,
}: {
  onLeave?: () => void;
  onError: (words: string | null) => void;
}) {
  const markRead = useMutation(api.notifications.markRead);
  const router = useRouter();
  const viewer = useViewer();
  // Where a row leads: its task on the board, its decision on /memory, or /handoffs.
  const target = (row: Notification): string | null =>
    row.taskId !== null && viewer.can("board")
      ? `/board?task=${row.taskId}`
      : row.decisionId !== null && viewer.can("memory")
        ? `/memory?decision=${row.decisionId}`
        : row.handoff && viewer.can("board")
          ? "/handoffs?status=open"
          : null;
  const leads = (row: Notification) => target(row) !== null;
  const open = (row: Notification) => {
    onError(null);
    const going = leads(row);
    if (!row.read) {
      // Opening the task does not wait on this, and a row that has gone in
      // the meantime is no reason to keep someone from their task.
      markRead({ id: row.id }).catch((failure) => {
        if (!going) onError(messageOf(failure));
      });
    }
    if (!going) return;
    onLeave?.();
    router.push(target(row)!);
  };
  return { open, leads };
}

/**
 * One notification. The sentence is built here from what the server sent as
 * data, and every part of it is rendered as text. The row is a button while
 * pressing it does something: it is unread, or it leads to its task.
 */
export function NotificationRow({
  row,
  now,
  showCompany,
  leads,
  onOpen,
}: {
  row: Notification;
  now: number | null;
  showCompany: boolean;
  /** Whether pressing it goes to the task. */
  leads: boolean;
  onOpen: (row: Notification) => void;
}) {
  const { who, lead, title, tail } = sentenceOf(row, now ?? row.createdAt);
  const body = (
    <>
      <ActorChip actor={row.actor} />
      <span className="min-w-0 flex-1">
        <span className="block text-sm leading-snug text-ink-2 [overflow-wrap:anywhere]">
          {!row.read && <span className="sr-only">Unread </span>}
          <span className="text-ink">{who}</span> {lead}{" "}
          <span className="font-medium text-ink">{title}</span>
          {tail}
        </span>
        {typeof row.summary === "string" && row.summary !== "" && (
          <span className="mt-1 line-clamp-2 block text-xs text-ink-2 [overflow-wrap:anywhere]">{row.summary}</span>
        )}
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
          {showCompany && row.company !== null && (
            <KindTag tone="slate" className="text-[11px]">
              {COMPANIES[row.company].name}
            </KindTag>
          )}
          {now !== null && <span className="font-num">{ageLabel(now, row.createdAt)}</span>}
        </span>
      </span>
      {/* The dot keeps its place on a read row, so the text does not shift when one is read. */}
      <span
        aria-hidden
        className={cn("mt-1.5 size-2 shrink-0 rounded-full", row.read ? "bg-transparent" : "bg-brand")}
      />
    </>
  );
  const shape = "flex w-full items-start gap-3 rounded-inner px-3 py-2.5 text-left";
  return (
    <li data-unread={row.read ? undefined : "true"} className={cn("rounded-inner", !row.read && "bg-brand/5")}>
      {leads || !row.read ? (
        <button
          type="button"
          onClick={() => onOpen(row)}
          className={cn(shape, ring, "transition hover:bg-surface")}
        >
          {body}
        </button>
      ) : (
        <div className={shape}>{body}</div>
      )}
    </li>
  );
}

/**
 * The bell in the app's top bar and the panel it opens: what the viewer has
 * been told about the board, newest first. Both queries are live, so the
 * badge and the list change by themselves. The list is only asked for while
 * the panel is open.
 */
export function NotificationBell({ place = "bar" }: { place?: "bar" | "side" }) {
  const side = place === "side";
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(NOTIFICATION_PAGE);
  const [error, setError] = useState<string | null>(null);
  const unread = useQuery(api.notifications.unreadCount);
  const page = useQuery(api.notifications.mine, open ? { count } : "skip");
  // While the next page loads the query is briefly undefined: keep what was
  // on screen rather than flash it away.
  const [kept, setKept] = useState(page);
  if (page !== undefined && page !== kept) setKept(page);
  const shown = page ?? kept;

  const markAllRead = useMutation(api.notifications.markAllRead);
  const viewer = useViewer();
  const now = useNow();
  const badge = badgeText(unread ?? 0);

  const change = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setCount(NOTIFICATION_PAGE);
      setError(null);
    }
  };
  const { open: onOpen, leads } = useOpenNotification({ onLeave: () => change(false), onError: setError });

  // Today's "Show all": of the two bells (the sidebar's from md up, the top
  // bar's below it), the one on screen opens.
  useEffect(() => {
    const listen = () => {
      const wide = window.matchMedia?.("(min-width: 48rem)").matches ?? true;
      if (wide === side) setOpen(true);
    };
    window.addEventListener(OPEN_NOTIFICATIONS_EVENT, listen);
    return () => window.removeEventListener(OPEN_NOTIFICATIONS_EVENT, listen);
  }, [side]);

  return (
    <Sheet open={open} onOpenChange={change}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label={bellLabel(unread)}
          className={cn(
            "relative inline-flex h-9 items-center gap-2 rounded-full border px-3 text-sm font-medium transition",
            side ? "w-full justify-start" : "justify-center",
            // Unread: filled in the brand colour so it cannot be missed.
            badge !== null
              ? "border-brand-fill bg-brand-fill text-on-brand shadow-soft hover:bg-brand-fill/90"
              : "border-line bg-panel text-ink-2 hover:bg-surface hover:text-ink data-[state=open]:bg-surface data-[state=open]:text-ink",
            ring,
          )}
        >
          <BellIcon aria-hidden className="size-[18px]" />
          <span aria-hidden className={side ? undefined : "hidden sm:inline"}>
            Notifications
          </span>
          {badge !== null && (
            <span
              aria-hidden
              data-badge
              className={cn(
                "flex h-5 min-w-5 items-center justify-center rounded-full bg-on-brand px-1.5 font-num text-xs leading-none font-semibold text-brand-fill",
                side && "ml-auto",
              )}
            >
              {badge}
            </span>
          )}
        </button>
      </SheetTrigger>
      {/* A sheet on a phone; from the md breakpoint the same dialog is a card
          under the bell. */}
      <SheetContent
        side={side ? "left" : "right"}
        overlayClassName="md:bg-transparent md:supports-backdrop-filter:backdrop-blur-none"
        className={cn(
          "gap-0 bg-panel md:rounded-card md:border md:border-line md:shadow-soft",
          side
            ? // Beside the sidebar, level with the button that opened it.
              "data-[side=left]:w-full data-[side=left]:sm:max-w-md md:data-[side=left]:inset-y-auto md:data-[side=left]:top-24 md:data-[side=left]:left-[16.5rem] md:data-[side=left]:h-auto md:data-[side=left]:max-h-[min(44rem,calc(100dvh-7rem))] md:data-[side=left]:w-[27rem]"
            : "data-[side=right]:w-full data-[side=right]:sm:max-w-md md:data-[side=right]:inset-y-auto md:data-[side=right]:top-12 md:data-[side=right]:right-4 md:data-[side=right]:h-auto md:data-[side=right]:max-h-[min(44rem,calc(100dvh-4rem))] md:data-[side=right]:w-[27rem]",
        )}
      >
        <SheetHeader className="flex-row items-center gap-3 border-b border-line py-3 pr-12 pl-4">
          <SheetTitle className="text-base text-ink">Notifications</SheetTitle>
          <SheetDescription className="sr-only">
            Who gave you a task, who mentioned you, and what happened to your tasks.
          </SheetDescription>
          {shown?.rows.some((row) => !row.read) && (
            <button
              type="button"
              onClick={() => {
                setError(null);
                markAllRead({}).catch((failure) => setError(messageOf(failure)));
              }}
              className={cn(
                "ml-auto rounded-full px-2.5 py-1 text-xs font-medium text-brand transition hover:bg-brand/10",
                ring,
              )}
            >
              Mark all as read
            </button>
          )}
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {error && (
            <p role="alert" className="px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          {shown === undefined ? (
            <div className="space-y-2 p-2" aria-busy>
              <Skeleton className="h-12 rounded-inner" />
              <Skeleton className="h-12 rounded-inner" />
              <Skeleton className="h-12 rounded-inner" />
            </div>
          ) : shown.rows.length === 0 ? (
            <p className="mx-auto max-w-xs px-4 py-10 text-center text-sm text-ink-2">
              Nothing yet. When someone gives you a task or mentions you, it shows here.
            </p>
          ) : (
            <>
              <ul className="space-y-1">
                {shown.rows.map((row) => (
                  <NotificationRow
                    key={row.id}
                    row={row}
                    now={now}
                    showCompany={viewer.companies.length > 1}
                    leads={leads(row)}
                    onOpen={onOpen}
                  />
                ))}
              </ul>
              {shown.more && (
                <div className="p-2 pt-3 text-center">
                  <button
                    type="button"
                    onClick={() =>
                      setCount((had) => Math.min(had + NOTIFICATION_PAGE, MAX_NOTIFICATIONS))
                    }
                    className={cn(
                      "rounded-full bg-surface px-4 py-1.5 text-xs font-medium text-ink-2 transition hover:text-ink",
                      ring,
                    )}
                  >
                    Show more
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
