import { ArrowDownRightIcon, ArrowUpRightIcon, EqualApproximatelyIcon, SparklesIcon } from "lucide-react";
import { StatusChip } from "@/components/ui/status-chip";
import type { Change } from "@/lib/metrics/kz-detail";

const CHIP: Record<Change["tone"], { tone: "success" | "danger" | "neutral" | "info"; icon: typeof EqualApproximatelyIcon; label: string }> = {
  good: { tone: "success", icon: ArrowUpRightIcon, label: "better than the week before" },
  bad: { tone: "danger", icon: ArrowDownRightIcon, label: "worse than the week before" },
  flat: { tone: "neutral", icon: EqualApproximatelyIcon, label: "about the same as the week before" },
  new: { tone: "info", icon: SparklesIcon, label: "new this week" },
};

/** The move as a coloured chip: green when it is good news, red when it is not, with words. */
export function Delta({ change }: { change: Change | null }) {
  if (change === null) return null;
  const chip = CHIP[change.tone];
  // The arrow points the way the figure moved; the colour says whether that is good.
  const icon = change.tone === "good" || change.tone === "bad" ? (change.words.startsWith("+") ? ArrowUpRightIcon : ArrowDownRightIcon) : chip.icon;
  return (
    <StatusChip tone={chip.tone} icon={icon} title={chip.label} data-export-skip="">
      {change.words}
      <span className="sr-only"> ({chip.label})</span>
    </StatusChip>
  );
}
