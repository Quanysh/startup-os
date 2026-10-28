import { ClockAlertIcon } from "lucide-react";
import {
  PARTNER_JUDGED_STAGES,
  PARTNER_QUIET_DAYS,
  PARTNER_TYPE_LABELS,
  type PartnerCard,
} from "@convex/lib/partnerStages";
import { dayLabel } from "@/lib/format";
import { quietness } from "@/lib/pipeline/derive";
import { nextStepState, valueText } from "@/lib/partnerships/view";

/**
 * A partner as it appears on the board: the name, which opens the editor, with
 * its expected value beside it; under them, only what is worth a line. That is
 * the kind of partner, who there we talk to, what happens next and by when, and
 * a silence that has gone on too long.
 */
export function PartnerCardView({
  partner,
  now,
  today,
  onOpen,
}: {
  partner: PartnerCard;
  /** null while rendering on the server: no partner is judged yet. */
  now: number | null;
  today: string | null;
  onOpen: (id: string) => void;
}) {
  const value = valueText(partner);
  const quiet =
    now !== null && (PARTNER_JUDGED_STAGES as readonly string[]).includes(partner.stage)
      ? quietness(partner, now, PARTNER_QUIET_DAYS)
      : null;
  const state = today === null ? "none" : nextStepState(partner, today);
  const who = [partner.contact, partner.contactRole].filter(Boolean).join(", ");
  return (
    <>
      <div className="flex items-baseline justify-between gap-2 pr-5">
        <button
          type="button"
          onClick={() => onOpen(partner.id)}
          title={partner.name}
          className="line-clamp-2 min-w-0 rounded text-left text-sm leading-snug font-medium text-ink outline-none hover:text-brand focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {partner.name}
        </button>
        {value !== null && <span className="shrink-0 font-num text-xs text-ink-2">{value}</span>}
      </div>
      <p className="mt-0.5 truncate text-xs text-ink-2">{PARTNER_TYPE_LABELS[partner.type]}</p>
      {who !== "" && <p className="truncate text-xs text-ink-2">{who}</p>}

      {partner.nextStep !== null ? (
        <p className="mt-1 line-clamp-2 text-xs text-ink-2">
          <span className="text-ink-3">Next: </span>
          {partner.nextStep}
          {partner.nextStepOn !== null && now !== null && (
            <span className={state === "overdue" ? "font-medium text-ink" : "text-ink-3"}>
              {` · ${state === "overdue" ? "was due " : "by "}${dayLabel(partner.nextStepOn, now)}`}
            </span>
          )}
        </p>
      ) : (
        quiet !== null && <p className="mt-1 text-xs text-ink-3">No next step</p>
      )}

      {quiet?.kind === "quiet" && (
        <p className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-ink">
          <ClockAlertIcon aria-hidden className="size-3 text-watch" />
          {`Quiet ${quiet.days} days`}
        </p>
      )}
      {quiet?.kind === "undated" && <p className="mt-1 text-[11px] text-ink-3">No activity date</p>}
      {partner.editedBy !== null && (
        <p className="mt-1 truncate text-[11px] text-ink-3">{`Last changed by ${partner.editedBy}`}</p>
      )}
    </>
  );
}
