"use client";

// The pieces every pipeline table is made of: the select-all box, a header
// that sorts, a chip that is also a select, the last-activity cell and the
// notes cell. The sales table (`src/components/sales/deal-table.tsx`) and the
// investor table (`src/components/fundraising/investor-table.tsx`) both draw
// with them, so a fix to one is a fix to both.

import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ClockAlertIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Blank, DataHeader } from "@/components/ui/data-table";
import { StatusChip, type StatusTone } from "@/components/ui/status-chip";
import { localIsoDate } from "@/lib/dates";
import { formatPeriod } from "@/lib/format";
import { ariaSort, lastActivityLabel, nextSort, type Sort } from "@/lib/pipeline/table-sort";
import { cn } from "@/lib/utils";

/** Every row shown, or none: checked when all are, mixed when some are. */
export function SelectAll({
  label,
  all,
  some,
  disabled,
  onToggle,
}: {
  /** "Select every deal shown". */
  label: string;
  all: boolean;
  some: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) box.current.indeterminate = some;
  }, [some]);
  return (
    <input
      ref={box}
      type="checkbox"
      aria-label={label}
      checked={all}
      disabled={disabled}
      onChange={onToggle}
      className="size-3.5 shrink-0 accent-brand"
    />
  );
}

export function SortButton<K extends string>({
  sort,
  column,
  onSort,
  children,
}: {
  sort: Sort<K>;
  column: K;
  onSort: (next: Sort<K>) => void;
  children: string;
}) {
  const state = ariaSort(sort, column);
  const Icon =
    state === "ascending" ? ArrowUpIcon : state === "descending" ? ArrowDownIcon : ArrowUpDownIcon;
  return (
    <button
      type="button"
      onClick={() => onSort(nextSort(sort, column))}
      className={cn(
        "inline-flex items-center gap-1 rounded-sm outline-none hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50",
        state !== "none" && "text-ink",
      )}
    >
      {children}
      <Icon aria-hidden className={cn("size-3.5 shrink-0", state === "none" && "opacity-50")} />
    </button>
  );
}

/** A column's name as the button that sorts by it. The header cell carries `aria-sort`. */
export function SortHeader<K extends string>({
  sort,
  column,
  onSort,
  numeric,
  narrow,
  children,
}: {
  sort: Sort<K>;
  column: K;
  onSort: (next: Sort<K>) => void;
  numeric?: boolean;
  /** A column of a chip or a word: no floor width. */
  narrow?: boolean;
  children: string;
}) {
  return (
    <DataHeader aria-sort={ariaSort(sort, column)} numeric={numeric} narrow={narrow}>
      <SortButton sort={sort} column={column} onSort={onSort}>
        {children}
      </SortButton>
    </DataHeader>
  );
}

/**
 * A chip that is also a select: the chip shows the value, and a native select
 * laid over it, invisible, takes the change. The select is what a keyboard or
 * a screen reader meets; the chip's ring shows its focus.
 */
export function ChipSelect({
  label,
  value,
  options,
  tone,
  icon,
  variant,
  text,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  tone: StatusTone;
  icon?: LucideIcon;
  variant?: "solid" | "outline";
  text: string;
  onChange: (value: string) => void;
}) {
  return (
    <span className="relative inline-flex rounded-full focus-within:ring-3 focus-within:ring-ring/50">
      {/* The download writes the menu's choice ("No priority", not "Set"), so the chip is left out of it. */}
      <StatusChip aria-hidden data-export-skip="" tone={tone} icon={icon} variant={variant} className="pr-1.5">
        {text}
        <ChevronDownIcon className="size-3 opacity-70" />
      </StatusChip>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="absolute inset-0 w-full cursor-pointer appearance-none rounded-full opacity-0"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  );
}

/** When a card last moved: "3 days ago", or a chip once it has gone quiet. */
export function ActivityCell({
  at,
  now,
  quietDays,
}: {
  at: number | null;
  now: number | null;
  quietDays: number | null;
}) {
  if (at === null) return <Blank>No date</Blank>;
  const day = formatPeriod("day", localIsoDate(at));
  if (quietDays !== null) {
    return (
      <StatusChip tone="warning" icon={ClockAlertIcon} title={day}>
        {`Quiet ${quietDays} days`}
      </StatusChip>
    );
  }
  return (
    <span className="font-num text-ink-2" title={now === null ? undefined : day}>
      {now === null ? day : lastActivityLabel(at, now)}
    </span>
  );
}

/** Two lines of the notes; a click (or a hover, through its title) shows them all. */
export function NotesCell({ notes }: { notes: string | null }) {
  const [open, setOpen] = useState(false);
  if (notes === null) return <Blank />;
  return (
    <button
      type="button"
      aria-expanded={open}
      title={notes}
      onClick={() => setOpen((was) => !was)}
      className={cn(
        "block rounded-sm text-left text-ink-2 outline-none hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50",
        open ? "max-w-[24rem] whitespace-pre-wrap" : "line-clamp-2 max-w-[16rem]",
      )}
    >
      {notes}
    </button>
  );
}
