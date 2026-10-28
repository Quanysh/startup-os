// The small parts the four summary tiles share: a note, a link inside one,
// and the two judgements more than one tile makes.

import { InfoIcon } from "lucide-react";
import type { ReactNode } from "react";
import { GatedLink } from "@/components/gated-link";
import { COMPANIES } from "@/lib/company";
import { recordFigureHref, sourceLabel } from "@/lib/metrics/scorecard";

// Whether a balance is old is judged in the finance math, so a tile and the
// investor update cannot disagree. Re-exported for the tiles that import it here.
export { cashPartIsOld } from "@/lib/metrics/finance";

/** Where a Kazakhstan bank balance is typed in: Finance's "Record a figure" panel. */
export const ENTER_KZ_CASH = recordFigureHref("cash", "kz");
/** Where investor money received in the US is recorded. */
export const ENTER_US_FINANCING = recordFigureHref("financing_in", "us");
/** Where investor money received in Kazakhstan is recorded. */
export const ENTER_KZ_FINANCING = recordFigureHref("financing_in", "kz");

/**
 * One line under a tile's value. Always its own paragraph, so that each
 * thing the owner is told can be read, and tested, whole.
 *
 * A caution (something that makes the number above less sure) carries an
 * icon: the amber is never the only sign.
 */
export function Note({ caution = false, children }: { caution?: boolean; children: ReactNode }) {
  if (!caution) return <p>{children}</p>;
  return (
    <p className="flex items-start gap-1.5">
      <InfoIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-watch" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/**
 * A link inside a note. The entry forms are the owner's: anyone else reads
 * the link's words as plain text, or `otherwise` in their place.
 */
export function NoteLink({
  href,
  otherwise,
  children,
}: {
  href: string;
  otherwise?: ReactNode;
  children: ReactNode;
}) {
  return (
    <GatedLink
      href={href}
      otherwise={otherwise}
      className="rounded-sm font-medium text-brand underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {children}
    </GatedLink>
  );
}

/**
 * What the Finance hero adds to a summary tile (`HeroTiles`): the change
 * against last month, and the figure in the company's own currency first
 * (Globex's tenge, with dollars alongside). A tile given this also says
 * where its figure comes from, and one market's balance is said once, as
 * the figure, not again in a note.
 */
export type HeroExtras = {
  trend?: ReactNode;
  /** The company's own currency first: tenge for Globex, dollars alongside. */
  own?: boolean;
  /** Runway only: when cash runs out at today's burn ("Runs out in May 2028"). */
  runOut?: string;
};

/** Where a stored figure comes from, as the hero's small print says it. */
export function sourceWords(source: string): string {
  return source === "manual" ? "Typed in" : sourceLabel(source, "label");
}

/** What a viewer who cannot type Kazakhstan's balance in reads where the owner is offered the form. */
export const OWNER_ENTERS_KZ_CASH = "The owner enters Kazakhstan's balance.";

/**
 * Startup, as a viewer of Globex's figures may hear of it: by name for a
 * viewer on Startup as well, "the parent company" for one on Globex alone,
 * who is never told the other company's name.
 */
export const parentWords = (companies: readonly string[]) =>
  companies.includes("us") ? COMPANIES.us.name : "the parent company";
/** Globex, likewise: "the subsidiary" for a viewer on Startup alone (as Where the money goes says it). */
export const subsidiaryWords = (companies: readonly string[]) =>
  companies.includes("kz") ? COMPANIES.kz.name : "the subsidiary";
