import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleHelpIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import { StatusChip, type StatusTone } from "@/components/ui/status-chip";
import { HEALTH_LABELS, type HealthLevel } from "@/lib/customers/health";
import { cn } from "@/lib/utils";

// A status colour always comes with an icon and a label, and the label wears
// ink. "Unknown" and "Not assessed" are not statuses and get no colour.
// `chip` is the same verdict as a table's status chip: one map, so the badge
// in the drawer and the chip in the list cannot disagree.
const LEVEL: Record<HealthLevel, { icon: LucideIcon; tone: string; chip: StatusTone }> = {
  at_risk: { icon: CircleAlertIcon, tone: "text-weak", chip: "danger" },
  watch: { icon: TriangleAlertIcon, tone: "text-watch", chip: "warning" },
  good: { icon: CircleCheckIcon, tone: "text-good", chip: "success" },
  unknown: { icon: CircleHelpIcon, tone: "text-ink-3", chip: "neutral" },
  not_assessed: { icon: CircleDashedIcon, tone: "text-ink-3", chip: "neutral" },
};

/** A clinic's health in the list: a status chip, with the level's own icon. */
export function HealthChip({ level }: { level: HealthLevel }) {
  const { icon, chip } = LEVEL[level];
  return (
    <StatusChip tone={chip} icon={icon} data-health={level}>
      {HEALTH_LABELS[level]}
    </StatusChip>
  );
}

export function HealthBadge({ level, className }: { level: HealthLevel; className?: string }) {
  const { icon: Icon, tone } = LEVEL[level];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm text-ink", className)}>
      <Icon aria-hidden className={cn("size-4 shrink-0", tone)} />
      {HEALTH_LABELS[level]}
    </span>
  );
}
