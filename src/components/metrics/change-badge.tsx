import { ArrowDownRightIcon, ArrowUpRightIcon, MinusIcon } from "lucide-react";
import { formatChange } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Change against the previous period. The arrow carries good-or-bad in colour
 * (direction × whether up is good); the number itself stays in ink.
 */
export function ChangeBadge({
  ratio,
  better,
  versus,
  className,
}: {
  ratio: number;
  better: "up" | "down";
  /** The period compared against, e.g. "Sep". */
  versus: string;
  className?: string;
}) {
  const flat = ratio === 0;
  const good = better === "up" ? ratio > 0 : ratio < 0;
  const Icon = flat ? MinusIcon : ratio > 0 ? ArrowUpRightIcon : ArrowDownRightIcon;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs text-ink-2", className)}>
      <Icon
        aria-hidden
        className={cn("size-3.5", flat ? "text-ink-3" : good ? "text-good" : "text-weak")}
      />
      <span className="font-num font-medium text-ink">{formatChange(ratio)}</span>
      <span>vs {versus}</span>
      <span className="sr-only">
        {flat ? "(no change)" : good ? "(an improvement)" : "(a decline)"}
      </span>
    </span>
  );
}
