"use client";

import type { FunctionReturnType } from "convex/server";
import { CircleDashedIcon, Loader2Icon } from "lucide-react";
import { useRef, useState, type ComponentProps, type ReactNode } from "react";
import type { api } from "@convex/_generated/api";
import type { Currency } from "@convex/lib/metricRegistry";
import { KIND_LABELS, PAYER_LABELS, type Payer, type PayrollKind } from "@convex/lib/payroll";
import { quietButtonClass } from "@/components/panel";
import { KindTag, StatusChip, type KindTone } from "@/components/ui/status-chip";
import { messageOf } from "@/lib/errors";
import { formatMinor } from "@/lib/format";
import { cn } from "@/lib/utils";

export type Person = FunctionReturnType<typeof api.payroll.listPeople>[number];
export type Line = FunctionReturnType<typeof api.payroll.listLines>[number];
export type Run = NonNullable<FunctionReturnType<typeof api.payroll.getRun>>;
export type RunRow = Run["rows"][number];
export type RunSummary = FunctionReturnType<typeof api.payroll.listRuns>[number];

export const CURRENCY_NAMES: Record<Currency, string> = { USD: "US dollars", KZT: "tenge" };

/**
 * One request at a time, with its failure kept to show. `run` answers whether
 * the work went through, and does nothing while another call is in flight.
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref as well as the state: two clicks can land before the first render.
  const flying = useRef(false);
  const run = async (work: () => Promise<unknown>, fallback?: string): Promise<boolean> => {
    if (flying.current) return false;
    flying.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
      return true;
    } catch (failure) {
      setError(messageOf(failure, fallback));
      return false;
    } finally {
      flying.current = false;
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

/** A mutation's failure, said where it happened. */
export function Failure({ error, className }: { error: string | null; className?: string }) {
  if (error === null) return null;
  return (
    <p role="alert" className={cn("text-sm text-destructive", className)}>
      {error}
    </p>
  );
}

/** An exact amount, in tabular figures. */
export function Money({ minor, currency }: { minor: number; currency: Currency }) {
  return <span className="font-num">{formatMinor(minor, currency)}</span>;
}

/** A line whose rate nobody has typed yet: said in words, never shown as 0%. */
export function RateNotSet() {
  return (
    <StatusChip tone="warning" icon={CircleDashedIcon}>
      Rate not set
    </StatusChip>
  );
}

// Kinds wear a hue, never a status colour. Who pays a line wears the hue of
// its column group in the month's table: teal is what comes out of a person's
// pay, violet what the company pays on top.
const KIND_TONE: Record<PayrollKind, KindTone> = { employee: "plum", contractor: "sand" };
const PAYER_TONE: Record<Payer, KindTone> = { employee: "teal", company: "violet" };

/** Employee or contractor. */
export function PersonKind({ kind, className }: { kind: PayrollKind; className?: string }) {
  return (
    <KindTag tone={KIND_TONE[kind]} className={className}>
      {KIND_LABELS[kind]}
    </KindTag>
  );
}

/** Who pays a line: withheld from pay, or paid by the company. */
export function PaidBy({ payer }: { payer: Payer }) {
  return <KindTag tone={PAYER_TONE[payer]}>{PAYER_LABELS[payer]}</KindTag>;
}

/** A month's state: a draft is in hand, a paid month is done. */
export function RunStatus({ status, children }: { status: "draft" | "paid"; children: ReactNode }) {
  return <StatusChip tone={status === "paid" ? "success" : "info"}>{children}</StatusChip>;
}

/**
 * "incomplete", after a status or a label. The word is as it always was (the
 * capital is drawn, not typed), so the cell still reads "Draft, incomplete".
 */
export function Incomplete({ className }: { className?: string }) {
  return (
    <StatusChip tone="warning" className={cn("capitalize", className)}>
      incomplete
    </StatusChip>
  );
}

export const dangerButtonClass =
  "inline-flex h-10 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium text-destructive outline-none transition hover:bg-destructive/10 focus-visible:ring-3 focus-visible:ring-ring/50 aria-disabled:opacity-60";

/**
 * A button for something that takes a request. `aria-disabled`, not
 * `disabled`: a natively disabled button drops focus mid-request.
 */
export function ActionButton({
  busy = false,
  blocked = false,
  icon,
  className = quietButtonClass,
  children,
  ...props
}: Omit<ComponentProps<"button">, "disabled"> & {
  busy?: boolean;
  /** Cannot be used right now, for a reason said beside it. */
  blocked?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-disabled={busy || blocked}
      className={cn(className, "aria-disabled:opacity-60")}
      {...props}
    >
      {busy ? <Loader2Icon aria-hidden className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

/** "Are you sure" for what cannot be undone: the words, the deed and the way back. */
export function Confirm({
  question,
  confirm,
  cancel,
  busy,
  onConfirm,
  onCancel,
}: {
  question: string;
  confirm: string;
  cancel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="rounded-inner bg-surface p-4">
      <p className="text-sm text-ink">{question}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <ActionButton busy={busy} onClick={onConfirm} className={dangerButtonClass}>
          {confirm}
        </ActionButton>
        <button type="button" onClick={onCancel} className={quietButtonClass}>
          {cancel}
        </button>
      </div>
    </div>
  );
}
