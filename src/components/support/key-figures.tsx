import { CircleCheckIcon, TriangleAlertIcon } from "lucide-react";
import type { SupportFigures } from "@convex/lib/supportMetrics";
import { durationWords, shareWords } from "@/lib/support/words";
import { cn } from "@/lib/utils";

type Figure = {
  label: string;
  value: string;
  /** The line under the figure. */
  sub: string;
  /** Danger: a customer waits on a person. Said in words too, never by the colour alone. */
  danger?: boolean;
  good?: boolean;
};

/** Seconds as words: a reply time. */
const replyWords = (seconds: number | null) => (seconds === null ? "Not known" : durationWords(seconds * 1000));

function figuresOf(figures: SupportFigures): Figure[] {
  const waiting = figures.waiting.length;
  const longest = figures.waiting[0];
  const { median, p90, replied, chats } = figures.firstReply;
  const { resolvedShare, finChats } = figures.fin;
  return [
    {
      label: "Waiting on a person",
      value: String(waiting),
      sub: longest === undefined ? "Nobody waiting" : `Longest ${durationWords(longest.waitedMs)}`,
      danger: waiting > 0,
      good: waiting === 0,
    },
    {
      label: "Open customer chats",
      value: String(figures.openCustomer),
      sub: "Snoozed ones included",
    },
    {
      label: "First reply by a person, median",
      value: replyWords(median),
      sub:
        median === null
          ? chats === 0
            ? "No customer chat in 30 days"
            : "No person has replied in 30 days"
          : `p90 ${replyWords(p90)} · ${replied} of ${chats} chats, 30 days`,
    },
    {
      label: "Resolved by Fin",
      value: shareWords(resolvedShare),
      sub:
        resolvedShare === null
          ? "Fin answered no customer chat in 30 days"
          : `Of ${finChats} ${finChats === 1 ? "chat" : "chats"} Fin answered, 30 days`,
    },
  ];
}

/** The four figures that say how the inbox is doing, the first in the danger tone while anyone waits. */
export function SupportKeyFigures({ figures }: { figures: SupportFigures }) {
  return (
    <ul
      aria-label="Key figures"
      className="grid grid-cols-2 gap-x-6 gap-y-5 rounded-card bg-panel p-5 shadow-soft sm:p-6 lg:grid-cols-4"
    >
      {figuresOf(figures).map((figure) => (
        <li key={figure.label} className="min-w-0">
          <span className="block text-xs text-ink-2">{figure.label}</span>
          <span
            className={cn(
              "mt-1 block text-xl font-semibold tracking-tight",
              figure.value === "Not known" ? "text-ink-3" : "text-ink",
            )}
          >
            {figure.value}
          </span>
          <span
            data-tone={figure.danger ? "danger" : undefined}
            className={cn(
              "mt-0.5 flex items-start gap-1 text-xs",
              figure.danger ? "font-medium text-weak" : "text-ink-2",
            )}
          >
            {figure.danger && <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />}
            {figure.good && <CircleCheckIcon aria-hidden className="mt-px size-3.5 shrink-0 text-good" />}
            <span className="min-w-0 [overflow-wrap:anywhere]">{figure.sub}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
