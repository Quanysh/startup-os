import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * The two marks a table cell may wear, and the only place their colours are
 * chosen (the values are tokens in `src/styles/globals.css`).
 *
 * A `StatusChip` says how something is doing. Its tone is the meaning, never
 * the look: success, warning, danger, info or neutral, each a tinted ground
 * with words and an icon in the matching ink. It always has words, so the
 * colour is never the only sign.
 *
 * A `KindTag` says what something is. It is quieter on purpose (a paler
 * ground, a dot, regular weight), so in a row that holds both the state is
 * read first.
 */

export const STATUS_TONES = ["success", "warning", "danger", "info", "neutral"] as const;
export type StatusTone = (typeof STATUS_TONES)[number];

const STATUS: Record<StatusTone, { icon: LucideIcon; solid: string; outline: string }> = {
  success: {
    icon: CircleCheckIcon,
    solid: "bg-success-soft text-success-ink",
    outline: "border-success-ink/35 text-success-ink",
  },
  warning: {
    icon: TriangleAlertIcon,
    solid: "bg-warning-soft text-warning-ink",
    outline: "border-warning-ink/35 text-warning-ink",
  },
  danger: {
    icon: CircleAlertIcon,
    solid: "bg-danger-soft text-danger-ink",
    outline: "border-danger-ink/35 text-danger-ink",
  },
  info: {
    icon: CircleDotIcon,
    solid: "bg-info-soft text-info-ink",
    outline: "border-info-ink/35 text-info-ink",
  },
  neutral: {
    icon: CircleDashedIcon,
    solid: "bg-neutral-soft text-neutral-ink",
    outline: "border-neutral-ink/35 text-neutral-ink",
  },
};

/** The text colour of a tone, for a figure or a line that is not a chip. */
export const STATUS_INK: Record<StatusTone, string> = {
  success: "text-success-ink",
  warning: "text-warning-ink",
  danger: "text-danger-ink",
  info: "text-info-ink",
  neutral: "text-neutral-ink",
};

export function StatusChip({
  tone,
  icon,
  variant = "solid",
  className,
  children,
  ...props
}: ComponentProps<"span"> & {
  tone: StatusTone;
  /** The tone's own icon unless another says it better (a calendar, a key). */
  icon?: LucideIcon;
  /**
   * `outline` is the same tone with no ground: for a second, lesser state in
   * a row that already has a filled one (a clinic's status beside its health).
   */
  variant?: "solid" | "outline";
}) {
  const { icon: ToneIcon, solid, outline } = STATUS[tone];
  const Icon = icon ?? ToneIcon;
  return (
    <span
      data-slot="status-chip"
      data-tone={tone}
      data-variant={variant}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full border border-transparent py-0.5 pr-2 pl-1.5 align-middle font-sans text-xs font-medium whitespace-nowrap",
        variant === "solid" ? solid : outline,
        className,
      )}
      {...props}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {children}
    </span>
  );
}

/**
 * A tone's icon alone, in the tone's ink: for a state that is already said in
 * a sentence beside it. Decorative: the sentence carries the meaning.
 */
export function StatusMark({
  tone,
  icon,
  className,
}: {
  tone: StatusTone;
  icon?: LucideIcon;
  className?: string;
}) {
  const Icon = icon ?? STATUS[tone].icon;
  return (
    <Icon
      aria-hidden
      data-slot="status-mark"
      data-tone={tone}
      className={cn("size-4 shrink-0", STATUS_INK[tone], className)}
    />
  );
}

export const KIND_TONES = ["teal", "violet", "plum", "sand", "slate"] as const;
export type KindTone = (typeof KIND_TONES)[number];

const KIND: Record<KindTone, { ground: string; dot: string }> = {
  teal: { ground: "bg-kind-teal-soft text-kind-teal-ink", dot: "bg-kind-teal" },
  violet: { ground: "bg-kind-violet-soft text-kind-violet-ink", dot: "bg-kind-violet" },
  plum: { ground: "bg-kind-plum-soft text-kind-plum-ink", dot: "bg-kind-plum" },
  sand: { ground: "bg-kind-sand-soft text-kind-sand-ink", dot: "bg-kind-sand" },
  slate: { ground: "bg-kind-slate-soft text-kind-slate-ink", dot: "bg-kind-slate" },
};

export function KindTag({
  tone,
  className,
  children,
  ...props
}: ComponentProps<"span"> & { tone: KindTone }) {
  const { ground, dot } = KIND[tone];
  return (
    <span
      data-slot="kind-tag"
      data-tone={tone}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 align-middle font-sans text-xs font-normal whitespace-nowrap",
        ground,
        className,
      )}
      {...props}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dot)} />
      {children}
    </span>
  );
}
