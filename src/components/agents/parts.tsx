"use client";

import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  ClockAlertIcon,
  ClockIcon,
  PencilLineIcon,
  type LucideIcon,
} from "lucide-react";
import type { ChangeStatus } from "@convex/lib/agentControl";
import { RUNS_ON_WORDS, type RunsOn } from "@convex/lib/osAgents";
import { KindTag, StatusChip, type StatusTone } from "@/components/ui/status-chip";
import { STATUS_WORDS } from "@/lib/agents/view";
import type { FreshnessState } from "@/lib/source-freshness";
import { cn } from "@/lib/utils";

/** Where one of Startup OS's agents runs, as a chip: "Claude on the Mac" or "Gemini in Startup OS". */
export function RunsOnChip({ runsOn }: { runsOn: RunsOn }) {
  return (
    <KindTag tone={runsOn === "claude_mac" ? "plum" : "teal"} data-runs-on={runsOn}>
      {RUNS_ON_WORDS[runsOn]}
    </KindTag>
  );
}

/** A freshness state as a chip: the page header's tones and icons. */
const STATE_CHIP: Record<FreshnessState, { tone: StatusTone; icon: LucideIcon }> = {
  fresh: { tone: "success", icon: CircleCheckIcon },
  late: { tone: "warning", icon: ClockIcon },
  stale: { tone: "danger", icon: ClockAlertIcon },
  failed: { tone: "danger", icon: CircleAlertIcon },
  never: { tone: "neutral", icon: CircleDashedIcon },
  typed: { tone: "neutral", icon: PencilLineIcon },
};

export function StateChip({ state, children }: { state: FreshnessState; children: string }) {
  const chip = STATE_CHIP[state];
  return (
    <StatusChip tone={chip.tone} icon={chip.icon} className="shrink-0">
      {children}
    </StatusChip>
  );
}

const CHANGE_TONE: Record<ChangeStatus, StatusTone> = {
  pending: "info",
  applied: "success",
  failed: "danger",
};

export function ChangeChip({ status, title }: { status: ChangeStatus; title?: string }) {
  return (
    <StatusChip tone={CHANGE_TONE[status]} title={title} className="shrink-0">
      {STATUS_WORDS[status]}
    </StatusChip>
  );
}

/** Whether real patient data may go to a provider: said in words, never by colour alone. */
export function PatientDataTag({ allowed }: { allowed: boolean }) {
  return (
    <KindTag tone={allowed ? "teal" : "sand"}>
      {allowed ? "For real patient data" : "Not for real patient data"}
    </KindTag>
  );
}

/** A model, as a quiet chip: "gemini-2.5-pro · Vertex AI". */
export function ModelChip({ model, provider }: { model: string; provider: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md bg-surface px-1.5 py-0.5 text-xs text-ink">
      <span className="truncate">{model}</span>
      <span className="text-ink-2">· {provider}</span>
    </span>
  );
}

/** An on/off switch. */
export function Toggle({
  on,
  label,
  disabled,
  onChange,
}: {
  on: boolean;
  label: string;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      data-export-skip=""
      className={cn(
        "inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-line p-0.5 outline-none transition focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60",
        on ? "justify-end bg-brand-fill" : "justify-start bg-surface",
      )}
    >
      <span aria-hidden className={cn("size-4.5 rounded-full shadow-soft-sm", on ? "bg-on-brand" : "bg-ink-3")} />
      <span className="sr-only">{on ? "On" : "Off"}</span>
    </button>
  );
}

/**
 * Month to date against a budget: a short track filled to the share spent,
 * in the first chart colour, and the weak status colour with words once it
 * is over. Drawn for the eye; the figures are written beside it.
 */
export function BudgetBar({ share }: { share: number }) {
  const over = share > 1;
  return (
    <div aria-hidden className="mt-1 h-1.5 w-20 overflow-hidden rounded-full bg-surface">
      <div
        className={cn("h-full rounded-full", over ? "bg-weak" : "bg-[var(--chart-1)]")}
        style={{ width: `${Math.min(share, 1) * 100}%` }}
      />
    </div>
  );
}
