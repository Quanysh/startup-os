import type { ReactNode } from "react";
import { CountUp } from "@/components/finance/motion";
import { cn } from "@/lib/utils";
import { useTileFrame } from "./tile-frame";

/**
 * A number worked out from others (runway, burn multiple). Nothing wrote it,
 * so it has no source or freshness line of its own: what it rests on, and why
 * it may be absent, is said in the notes under it.
 *
 * In the Finance hero (`HeroTiles`) the same tile is drawn larger, says "Not
 * known yet" where it has no figure, counts its figure up once (`count`), and
 * may carry the figure in a second currency, its trend and its source.
 */
export function DerivedTile({
  label,
  value,
  exact,
  badge,
  count,
  alongside,
  trend,
  source,
  children,
}: {
  label: string;
  /** null renders "No value yet" in the muted ink ("Not known yet" in the hero). */
  value: string | null;
  /** The full figure, as the value's tooltip. */
  exact?: string;
  /** Shown as a small pill beside the label, e.g. "partial". */
  badge?: string;
  /** In the hero, the number behind `value` and how it reads, so it can count up. */
  count?: {
    value: number;
    format: (value: number) => string;
    /** Said after the figure, smaller and quieter: "/ mo". */
    unit?: string;
  };
  /** In the hero, a line under the figure: the figure in another currency, or when cash runs out. */
  alongside?: ReactNode;
  /** In the hero, the change against last month. */
  trend?: ReactNode;
  /** In the hero, where the figure comes from: "Mercury · Oct 14". */
  source?: ReactNode;
  /** Notes, reasons and a benchmark chip. */
  children?: ReactNode;
}) {
  // Inside a dashboard section the tile is drawn flat, and a size smaller.
  const { flat, hero, frame } = useTileFrame();

  if (hero) {
    return (
      <article className="flex min-w-0 flex-col">
        <header className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-medium text-ink-2">{label}</h3>
          {badge !== undefined && (
            <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-[11px] font-medium text-ink">
              {badge}
            </span>
          )}
        </header>
        {value === null ? (
          <p className="mt-2 text-3xl font-semibold tracking-tight text-ink-3 sm:text-4xl">Not known yet</p>
        ) : (
          <p className="mt-1.5 text-4xl font-semibold tracking-tight whitespace-nowrap text-ink sm:text-5xl" title={count ? undefined : exact}>
            {count ? (
              <>
                <CountUp id={`hero:${label}`} value={count.value} format={count.format} title={exact} />
                {count.unit !== undefined && (
                  <>
                    {" "}
                    <span className="text-xl font-medium tracking-normal text-ink-3 sm:text-2xl">{count.unit}</span>
                  </>
                )}
              </>
            ) : (
              value
            )}
          </p>
        )}
        {alongside !== undefined && <p className="mt-1.5 text-sm text-ink-2">{alongside}</p>}
        {trend !== undefined && <div className="mt-3 min-h-5">{trend}</div>}
        {source !== undefined && <p className="mt-1.5 text-[11px] text-ink-3">{source}</p>}
        {children !== undefined && (
          <div className="mt-3 space-y-1.5 text-xs leading-relaxed break-words text-ink-2">{children}</div>
        )}
      </article>
    );
  }

  return (
    <article className={cn("flex min-w-0 flex-col", frame)}>
      <header className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-medium text-ink-2">{label}</h3>
        {badge !== undefined && (
          <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-[11px] font-medium text-ink">
            {badge}
          </span>
        )}
      </header>

      {value === null ? (
        flat ? (
          // Inside a summary a missing figure is a quiet dash: the note under
          // it says why, and a grey headline read as broken.
          <p className="mt-1 text-2xl font-semibold text-ink-3">
            <span aria-hidden>—</span>
            <span className="sr-only">No value yet</span>
          </p>
        ) : (
          <p className="mt-3 text-2xl font-semibold text-ink-3">No value yet</p>
        )
      ) : (
        <p
          className={cn(
            "font-semibold tracking-tight text-ink",
            flat ? "mt-1 text-2xl" : "mt-2 text-3xl",
          )}
          title={exact}
        >
          {value}
        </p>
      )}

      {children !== undefined && (
        <div className="mt-3 space-y-1.5 text-xs leading-relaxed break-words text-ink-2">
          {children}
        </div>
      )}
    </article>
  );
}
