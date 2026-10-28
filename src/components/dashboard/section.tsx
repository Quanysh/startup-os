"use client";

import { ArrowRightIcon, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { createContext, useContext, useId, type ComponentProps, type ReactNode } from "react";
import { GatedLink } from "@/components/gated-link";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const PANEL = "rounded-card bg-panel p-5 shadow-soft sm:p-6";

/** The level of a block's heading: 2 on a page of its own, 3 inside a section of a page. */
export const SectionLevel = createContext<2 | 3 | 4>(2);

/** The heading of a panel inside a block: one level under the block, h2 on a page of its own. */
export function PanelHeading(props: ComponentProps<"h2">) {
  const Heading = `h${useContext(SectionLevel)}` as const;
  return <Heading {...props} />;
}

/**
 * One block of the dashboard: a labelled region whose heading leads to the
 * page it summarises. `framed` draws it as one panel, for a section of small
 * figures; unframed, its children bring panels of their own.
 *
 * A viewer who cannot open the page reads the heading with no link.
 */
export function DashboardSection({
  title,
  href,
  framed = true,
  className,
  children,
}: {
  title: string;
  href: string;
  framed?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  // Under Today's "The company" each block is a part of that section.
  const level = useContext(SectionLevel);
  const Heading = `h${level}` as const;
  return (
    <section
      aria-labelledby={headingId}
      className={cn("@container min-w-0", framed && PANEL, className)}
    >
      <Heading id={headingId} className={cn("text-base", !framed && "px-1")}>
        <GatedLink
          href={href}
          otherwise={title}
          className="group inline-flex items-center gap-1.5 rounded-sm outline-none hover:text-brand focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {title}
          <ArrowRightIcon
            aria-hidden
            className="size-3.5 text-ink-3 transition-transform group-hover:translate-x-0.5 group-hover:text-brand"
          />
        </GatedLink>
      </Heading>
      <div className={framed ? "mt-4" : "mt-3"}>
        {/* What a block holds is a level under its heading. */}
        <SectionLevel.Provider value={level === 2 ? 3 : 4}>{children}</SectionLevel.Provider>
      </div>
    </section>
  );
}

/** What a section shows until its own reads have arrived. */
export function SectionSkeleton({ className }: { className?: string }) {
  return (
    <div aria-busy>
      <Skeleton className={cn("h-28 w-full rounded-inner", className)} />
    </div>
  );
}

/** The most an empty block gets: one quiet line. */
export function QuietLine({ children }: { children: ReactNode }) {
  return <p className="text-sm text-ink-2">{children}</p>;
}

/**
 * A count with a word under it, and an icon where the count is a state. The
 * number wears ink; the icon carries the colour and is never the only sign.
 * With `href` the whole figure leads to where it is dealt with.
 */
export function Count({
  label,
  value,
  icon: Icon,
  tone,
  href,
}: {
  label: string;
  /** null is a count that is not known: it reads "Not known", never 0. */
  value: number | null;
  icon?: LucideIcon;
  /** The icon's colour class, e.g. "text-weak". */
  tone?: string;
  href?: string;
}) {
  const body = (
    <>
      <span
        className={cn(
          "block text-2xl font-semibold tracking-tight",
          value === null ? "text-ink-3" : "text-ink",
        )}
      >
        {value === null ? "Not known" : value.toLocaleString("en-US")}
      </span>{" "}
      {/* On a phone a long word ("Unconfirmed") goes under its icon rather than out of its column. */}
      <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-ink-2">
        {Icon && <Icon aria-hidden className={cn("size-3.5 shrink-0", tone)} />}
        {label}
      </span>
    </>
  );
  return (
    <li className="min-w-0">
      {href === undefined ? (
        body
      ) : (
        <Link
          href={href}
          className="-m-2 block rounded-inner p-2 outline-none hover:bg-surface focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {body}
        </Link>
      )}
    </li>
  );
}

/** A row of counts: three across, or as `className` says. */
export function Counts({ className, children }: { className?: string; children: ReactNode }) {
  return <ul className={cn("grid grid-cols-3 gap-x-3 gap-y-5 sm:gap-x-4", className)}>{children}</ul>;
}
