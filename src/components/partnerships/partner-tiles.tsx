import {
  PARTNER_JUDGED_STAGES,
  PARTNER_QUIET_DAYS,
  PARTNER_STAGES,
  PARTNER_STAGE_LABELS,
  needsYouPartners,
  partnerCounts,
  quietPartners,
  type PartnerCard,
} from "@convex/lib/partnerStages";
import { Note } from "@/components/finance/notes";
import { DerivedTile } from "@/components/metrics/derived-tile";
import { QuietTile } from "@/components/pipeline/quiet-tile";
import { agree, countOf } from "@/components/pipeline/words";

/**
 * Above a company's partners: how many are in each stage, who has gone quiet
 * (contacted, in talks or in agreement with no activity for two weeks) and how
 * many of those also have a next step that was due before today. The numbers
 * are worked out from the board here, so each says what it rests on.
 */
export function PartnerTiles({
  partners,
  now,
  today,
}: {
  partners: readonly PartnerCard[];
  now: number;
  today: string;
}) {
  const counts = partnerCounts(partners);
  const overdue = needsYouPartners(partners, now, today).length;
  return (
    <div className="space-y-4">
      <ul aria-label="Partners by stage" className="flex flex-wrap gap-2">
        {PARTNER_STAGES.map((stage) => (
          <li
            key={stage}
            className="inline-flex items-baseline gap-1.5 rounded-full bg-surface px-3 py-1 text-xs text-ink-2"
          >
            {PARTNER_STAGE_LABELS[stage]}
            <span className="font-num font-medium text-ink">{counts[stage]}</span>
          </li>
        ))}
      </ul>
      <div className="grid gap-4 sm:grid-cols-2">
        <QuietTile
          quiet={quietPartners(partners, now)}
          limitDays={PARTNER_QUIET_DAYS}
          one="partner in conversation"
          many="partners in conversation"
          nobody="No partner is in Contacted, In talks or Agreement."
        />
        <DerivedTile label="Quiet with a next step overdue" value={overdue === 0 ? "None" : String(overdue)}>
          <Note>
            {overdue === 0
              ? `Every quiet partner is either waiting on a date still to come or has none.`
              : `${countOf(overdue, "partner", "partners")} gone quiet ${agree(overdue, "has", "have")} a next step dated before today. They are on Today under "Needs you".`}
          </Note>
          <Note>{`Judged in ${PARTNER_JUDGED_STAGES.map((stage) => PARTNER_STAGE_LABELS[stage]).join(", ")}.`}</Note>
        </DerivedTile>
      </div>
    </div>
  );
}
