"use client";

import { CheckCircle2Icon, ChevronLeftIcon, ChevronRightIcon, CircleDashedIcon, FileTextIcon, PlusIcon, SendIcon, XCircleIcon } from "lucide-react";
import { POST_STATUS_LABELS, accountLabel, addDays, mondayOf, type PostStatus } from "@convex/lib/linkedin";
import { quietButtonClass } from "@/components/panel";
import { StatusMark, type StatusTone } from "@/components/ui/status-chip";
import { COMPANIES } from "@/lib/company";
import {
  monthWeeks,
  postsByDay,
  shift,
  weekDays,
  type CalendarView,
  type PostRow,
  type View,
} from "@/lib/linkedin/view";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

/** A post's state: a tone, an icon and its word, never a colour alone. */
export const POST_TONE: Record<PostStatus, { tone: StatusTone; icon: LucideIcon }> = {
  idea: { tone: "neutral", icon: CircleDashedIcon },
  draft: { tone: "info", icon: FileTextIcon },
  scheduled: { tone: "warning", icon: SendIcon },
  published: { tone: "success", icon: CheckCircle2Icon },
  dropped: { tone: "neutral", icon: XCircleIcon },
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT_MONTHS = MONTHS.map((month) => month.slice(0, 3));
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const monthName = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
const dayWords = (day: string) => `${SHORT_MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
const timeOf = (at: number) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

function PostButton({ post, onOpen, withStatus }: { post: PostRow; onOpen: (id: string) => void; withStatus: boolean }) {
  const { tone, icon } = POST_TONE[post.status];
  const at = post.publishedAt ?? post.plannedAt;
  return (
    <button
      type="button"
      onClick={() => onOpen(post.id)}
      className="block w-full rounded-inner bg-surface px-2 py-1.5 text-left text-xs outline-none transition hover:bg-line focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <span className="flex items-start gap-1.5">
        <StatusMark tone={tone} icon={icon} className="mt-px size-3.5" />
        <span className="min-w-0 flex-1">
          <span className="sr-only">{POST_STATUS_LABELS[post.status]}: </span>
          <span className="line-clamp-2 font-medium text-ink [overflow-wrap:anywhere]">{post.title}</span>
          <span className="mt-0.5 block truncate text-ink-2">
            {withStatus && `${POST_STATUS_LABELS[post.status]} · `}
            {at !== null && `${timeOf(at)} · `}
            {accountLabel(post, COMPANIES[post.company].name)}
          </span>
        </span>
      </span>
    </button>
  );
}

function DayNumber({ day, today }: { day: string; today: string }) {
  const isToday = day === today;
  return (
    <span
      className={cn(
        "inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-xs",
        isToday ? "bg-brand-fill font-semibold text-on-brand" : "text-ink-2",
      )}
    >
      {Number(day.slice(8, 10))}
      {isToday && <span className="sr-only"> (today)</span>}
    </span>
  );
}

/**
 * The posts of the accounts in view on a week or a month: a published post on
 * the day it went out, any other on the day it is planned. On a phone a month
 * is an agenda of the days that have a post, since seven columns would not fit.
 */
export function Calendar({
  rows,
  view,
  setView,
  anchor,
  today,
  onOpen,
  onNew,
}: {
  rows: readonly PostRow[];
  view: View;
  setView: (next: View) => void;
  /** The day the calendar is centred on. */
  anchor: string;
  today: string;
  onOpen: (id: string) => void;
  onNew: (day: string) => void;
}) {
  const byDay = postsByDay(rows);
  const go = (to: string) => setView({ ...view, day: to === today ? null : to });
  const title =
    view.calendar === "month"
      ? monthName(anchor)
      : `${dayWords(mondayOf(anchor))} – ${dayWords(addDays(mondayOf(anchor), 6))}`;
  const switchTo = (calendar: CalendarView) => setView({ ...view, calendar });

  const add = (day: string) => (
    <button
      type="button"
      onClick={() => onNew(day)}
      aria-label={`Add a post on ${dayWords(day)}`}
      className="inline-flex size-6 items-center justify-center rounded-full text-ink-3 outline-none transition hover:bg-surface hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <PlusIcon aria-hidden className="size-3.5" />
    </button>
  );

  const monthDays = view.calendar === "month" ? monthWeeks(anchor).flat() : [];
  const agenda = monthDays.filter((day) => day.slice(0, 7) === anchor.slice(0, 7) && byDay.has(day));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <button type="button" aria-label={view.calendar === "month" ? "Previous month" : "Previous week"} onClick={() => go(shift(view.calendar, anchor, -1))} className={cn(quietButtonClass, "size-9 px-0")}>
            <ChevronLeftIcon aria-hidden className="size-4" />
          </button>
          <h3 className="min-w-36 text-center text-base" aria-live="polite">
            {title}
          </h3>
          <button type="button" aria-label={view.calendar === "month" ? "Next month" : "Next week"} onClick={() => go(shift(view.calendar, anchor, 1))} className={cn(quietButtonClass, "size-9 px-0")}>
            <ChevronRightIcon aria-hidden className="size-4" />
          </button>
          <button type="button" onClick={() => go(today)} className={cn(quietButtonClass, "h-9")}>
            Today
          </button>
        </div>
        <div role="tablist" aria-label="Calendar" className="inline-flex gap-1 rounded-full bg-surface p-1">
          {(["week", "month"] as const).map((one) => (
            <button
              key={one}
              type="button"
              role="tab"
              aria-selected={view.calendar === one}
              onClick={() => switchTo(one)}
              className={cn(
                "h-8 rounded-full px-3 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                view.calendar === one ? "bg-brand-fill text-on-brand" : "text-ink-2 hover:text-ink",
              )}
            >
              {one === "week" ? "Week" : "Month"}
            </button>
          ))}
        </div>
      </div>

      {view.calendar === "week" ? (
        <div role="tabpanel" aria-label="Week" className="grid gap-2 sm:grid-cols-7">
          {weekDays(anchor).map((day, i) => (
            <section key={day} aria-label={`${WEEKDAYS[i]} ${dayWords(day)}`} className="min-w-0 rounded-inner border border-line p-2">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs font-medium text-ink-2">
                  {WEEKDAYS[i]} <DayNumber day={day} today={today} />
                </span>
                {add(day)}
              </div>
              <div className="mt-2 space-y-1.5">
                {(byDay.get(day) ?? []).map((post) => (
                  <PostButton key={post.id} post={post} onOpen={onOpen} withStatus />
                ))}
                {!byDay.has(day) && <p className="text-xs text-ink-3">Nothing planned</p>}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div role="tabpanel" aria-label="Month">
          <div className="hidden sm:block">
            <div className="grid grid-cols-7 gap-1 pb-1 text-center text-xs font-medium text-ink-2">
              {WEEKDAYS.map((name) => (
                <span key={name}>{name}</span>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {monthDays.map((day) => {
                const inMonth = day.slice(0, 7) === anchor.slice(0, 7);
                return (
                  <section
                    key={day}
                    aria-label={dayWords(day)}
                    className={cn("min-h-24 min-w-0 rounded-inner border border-line p-1.5", !inMonth && "bg-surface/50 opacity-60")}
                  >
                    <div className="flex items-center justify-between">
                      <DayNumber day={day} today={today} />
                      {inMonth && add(day)}
                    </div>
                    <div className="mt-1 space-y-1">
                      {(byDay.get(day) ?? []).map((post) => (
                        <PostButton key={post.id} post={post} onOpen={onOpen} withStatus={false} />
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          </div>
          <div className="space-y-3 sm:hidden">
            {agenda.length === 0 ? (
              <p className="text-sm text-ink-2">No post is planned or published this month.</p>
            ) : (
              agenda.map((day) => (
                <section key={day} aria-label={dayWords(day)} className="rounded-inner border border-line p-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-ink-2">{dayWords(day)}</span>
                    {add(day)}
                  </div>
                  <div className="mt-2 space-y-1.5">
                    {byDay.get(day)!.map((post) => (
                      <PostButton key={post.id} post={post} onOpen={onOpen} withStatus />
                    ))}
                  </div>
                </section>
              ))
            )}
            <button type="button" onClick={() => onNew(today)} className={cn(quietButtonClass, "h-9")}>
              <PlusIcon aria-hidden className="size-4" />
              Add a post
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
