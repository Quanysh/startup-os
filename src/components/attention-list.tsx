import {
  CalendarClockIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  ClockAlertIcon,
  TriangleAlertIcon,
} from "lucide-react";
import Link from "next/link";
import { useViewer } from "@/hooks/use-viewer";
import type { AttentionItem } from "@/lib/metrics/scorecard";
import { canOpen } from "@/lib/nav";
import { cn } from "@/lib/utils";

const SEVERITY = {
  error: { icon: CircleAlertIcon, tone: "text-weak", label: "Failed" },
  overdue: { icon: CircleAlertIcon, tone: "text-weak", label: "Overdue" },
  risk: { icon: TriangleAlertIcon, tone: "text-weak", label: "At risk" },
  due: { icon: CalendarClockIcon, tone: "text-watch", label: "Due soon" },
  stale: { icon: ClockAlertIcon, tone: "text-watch", label: "Stale" },
  empty: { icon: CircleDashedIcon, tone: "text-ink-3", label: "Missing" },
} as const;

/**
 * The rows themselves: one line each, worst first as given. Used by the list
 * below and by Today's "needs you" groups, so an item reads the same in both.
 */
export function AttentionRows({
  items,
  compact = false,
  className,
}: {
  items: readonly AttentionItem[];
  compact?: boolean;
  className?: string;
}) {
  const { areas } = useViewer();
  return (
    <ul
      className={cn(
        className,
        // Two columns cannot share one set of dividers: each row draws its own.
        compact
          ? "grid gap-x-10 lg:grid-cols-2 [&>li]:border-b [&>li]:border-line"
          : "divide-y divide-line",
      )}
    >
      {items.map((item) => {
        const { icon: Icon, tone, label } = SEVERITY[item.severity];
        const words = (
          <>
            <Icon aria-hidden className={cn("size-4 shrink-0", tone)} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-ink">
                <span className="sr-only">{label}: </span>
                {item.title}
              </span>
              <span className="block truncate text-xs text-ink-2">{item.detail}</span>
            </span>
          </>
        );
        return (
          <li key={item.id}>
            {canOpen(areas, item.href) ? (
              <Link
                href={item.href}
                className={cn(
                  "group flex items-center gap-3 rounded-inner outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  compact ? "py-2.5" : "py-3",
                )}
              >
                {words}
                <ChevronRightIcon
                  aria-hidden
                  className="size-4 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5"
                />
              </Link>
            ) : (
              <div className={cn("flex items-center gap-3", compact ? "py-2.5" : "py-3")}>
                {words}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The short list of things to act on, worst first. Each item leads to the
 * page where it is dealt with; a viewer who cannot open that page (a failed
 * source is fixed on the owner's sources page) is told of it all the same,
 * in words that lead nowhere.
 *
 * `compact` is the dashboard's: with nothing to act on it is one quiet line
 * and no panel, and a long list runs in two columns on a wide screen.
 */
export function AttentionList({
  items,
  compact = false,
}: {
  items: readonly AttentionItem[];
  compact?: boolean;
}) {
  if (compact && items.length === 0) {
    return (
      <section
        aria-labelledby="attention"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1"
      >
        <h2 id="attention" className="text-sm font-medium text-ink-2">
          Needs attention
        </h2>
        <p className="flex items-center gap-1.5 text-sm text-ink-2">
          <CircleCheckIcon aria-hidden className="size-4 text-good" />
          Nothing right now.
        </p>
      </section>
    );
  }
  return (
    <section aria-labelledby="attention" className="rounded-card bg-panel p-5 shadow-soft sm:p-6">
      <h2 id="attention" className="text-base">
        Needs attention
      </h2>

      {items.length === 0 ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-ink-2">
          <CircleCheckIcon aria-hidden className="size-4 text-good" />
          Nothing right now.
        </p>
      ) : (
        <AttentionRows items={items} compact={compact} className="mt-2" />
      )}
    </section>
  );
}
