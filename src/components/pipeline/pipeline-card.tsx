import { ClockAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { formatValue } from "@/lib/format";
import type { BoardCard, Quietness } from "@/lib/pipeline/derive";

/**
 * A deal or an investor as it appears on a board: the name, which opens the
 * editor, with the amount beside it; under them, only what is worth a line.
 * That is the contact, what happens next, a silence that has gone on too long,
 * and for an unsorted card the stage as its source names it.
 *
 * What every card on a board would say alike is said once, by the board: where
 * a mirrored board comes from, and that its source gives no activity dates.
 */
export function PipelineCardView({
  card,
  quiet,
  currency,
  amountSuffix = "",
  onOpen,
  footer,
}: {
  card: BoardCard;
  /** Whether it has gone quiet; null for a card that is not judged (a closed one). */
  quiet: Quietness | null;
  currency: string;
  /** "/mo" for a deal's monthly fee. */
  amountSuffix?: string;
  onOpen: (id: string) => void;
  /** Under everything else: what the page adds (the fundraising sync chips). */
  footer?: ReactNode;
}) {
  const nextStep = (card.nextStep ?? "").trim();
  // A mirrored card's next step is the owner's own note. Saying it is missing
  // on every card of a long mirrored column is noise; the attention list
  // counts them. A card kept here is asked for one.
  const askForNextStep = quiet !== null && !card.mirrored;
  return (
    <>
      <div className="flex items-baseline justify-between gap-2 pr-5">
        <button
          type="button"
          onClick={() => onOpen(card.id)}
          title={card.name}
          className="line-clamp-2 min-w-0 rounded text-left text-sm leading-snug font-medium text-ink outline-none hover:text-brand focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {card.name}
        </button>
        {card.amount !== null && (
          <span className="shrink-0 font-num text-xs text-ink-2">
            {formatValue(card.amount, "currency", currency)}
            {amountSuffix}
          </span>
        )}
      </div>

      {card.contact && <p className="mt-0.5 truncate text-xs text-ink-2">{card.contact}</p>}

      {nextStep !== "" ? (
        <p className="mt-1 line-clamp-2 text-xs text-ink-2">
          <span className="text-ink-3">Next: </span>
          {nextStep}
        </p>
      ) : (
        askForNextStep && <p className="mt-1 text-xs text-ink-3">No next step</p>
      )}

      {quiet?.kind === "quiet" && (
        <p className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-ink">
          <ClockAlertIcon aria-hidden className="size-3 text-watch" />
          {`Quiet ${quiet.days} days`}
        </p>
      )}
      {quiet?.kind === "undated" && !card.mirrored && (
        <p className="mt-1 text-[11px] text-ink-3">No activity date</p>
      )}
      {card.stage === "unmapped" && card.sourceStage && (
        <p className="mt-1 text-[11px] text-ink-2" title="The stage as its source names it">
          <span className="text-ink-3">Stage there: </span>
          {card.sourceStage}
        </p>
      )}
      {footer}
    </>
  );
}
