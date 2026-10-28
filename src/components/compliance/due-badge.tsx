import {
  CalendarClockIcon,
  CalendarIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  CircleHelpIcon,
  CircleDotIcon,
  MinusIcon,
  type LucideIcon,
} from "lucide-react";
import type { ObligationStatus } from "@convex/lib/obligationShape";
import { OBLIGATION_STATUS_LABELS } from "@convex/lib/obligationShape";
import { StatusChip, type StatusTone } from "@/components/ui/status-chip";
import type { DueState } from "@/lib/compliance/due";

// Only a confirmed date is coloured: overdue and due soon. An unconfirmed
// date, a missing one and a finished item wear the neutral chip, and "Done"
// is a plain tick: nothing on this page is a green all-clear, so no state
// here is ever `success`.
const STATE: Record<DueState, { icon: LucideIcon; tone: Exclude<StatusTone, "success"> }> = {
  overdue: { icon: CircleAlertIcon, tone: "danger" },
  due_soon: { icon: CalendarClockIcon, tone: "warning" },
  upcoming: { icon: CalendarIcon, tone: "neutral" },
  unconfirmed: { icon: CircleHelpIcon, tone: "neutral" },
  no_date: { icon: CircleDashedIcon, tone: "neutral" },
  done: { icon: CheckIcon, tone: "neutral" },
  not_applicable: { icon: MinusIcon, tone: "neutral" },
};

/** An obligation's due line: a chip in the tone of its state, with an icon and the words. */
export function DueBadge({ state, text }: { state: DueState; text: string }) {
  const { icon, tone } = STATE[state];
  return (
    <StatusChip data-due={state} tone={tone} icon={icon}>
      {text}
    </StatusChip>
  );
}

// How far along an item is. Outlined, so the due chip beside it is read
// first. Work in hand is `info`; a finished item is a plain tick, never green.
const PROGRESS: Record<
  ObligationStatus,
  { icon: LucideIcon; tone: Exclude<StatusTone, "success"> }
> = {
  open: { icon: CircleDashedIcon, tone: "neutral" },
  in_progress: { icon: CircleDotIcon, tone: "info" },
  done: { icon: CheckIcon, tone: "neutral" },
  not_applicable: { icon: MinusIcon, tone: "neutral" },
};

/** An obligation's own status: open, in progress, done or not applicable. */
export function ProgressChip({ status }: { status: ObligationStatus }) {
  const { icon, tone } = PROGRESS[status];
  return (
    <StatusChip variant="outline" tone={tone} icon={icon}>
      {OBLIGATION_STATUS_LABELS[status]}
    </StatusChip>
  );
}
