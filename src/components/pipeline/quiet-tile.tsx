import { Note } from "@/components/finance/notes";
import { DerivedTile } from "@/components/metrics/derived-tile";
import { formatValue } from "@/lib/format";
import type { QuietCards } from "@/lib/pipeline/derive";
import { agree, countOf } from "./words";

/**
 * How many cards have had no activity for too long. A card with no activity
 * date is never called quiet or active: it is counted apart, and when no card
 * has a date the tile gives no number at all rather than a reassuring "None".
 */
export function QuietTile({
  quiet,
  limitDays,
  one,
  many,
  nobody,
}: {
  quiet: QuietCards;
  limitDays: number;
  /** What a card is called here: "open deal", "investor in conversation". */
  one: string;
  many: string;
  /** Said when there is nothing to judge: "There are no open deals." */
  nobody: string;
}) {
  const label = "Gone quiet";
  const { of, undated } = quiet;
  const n = quiet.quiet.length;

  if (of === 0) {
    return (
      <DerivedTile label={label} value="None">
        <Note>{nobody}</Note>
      </DerivedTile>
    );
  }
  if (undated === of) {
    return (
      <DerivedTile label={label} value={null}>
        <Note caution>
          {of === 1
            ? `The one ${one} has no activity date, so it cannot be judged.`
            : `None of the ${of} ${many} has an activity date, so none can be judged.`}
        </Note>
      </DerivedTile>
    );
  }

  const unjudged = undated > 0 && (
    <Note caution>
      {`${countOf(undated, one, many)} ${agree(undated, "has", "have")} no activity date and cannot be judged.`}
    </Note>
  );
  if (n === 0) {
    return (
      <DerivedTile label={label} value="None">
        <Note>
          {undated > 0
            ? `Every ${one} with an activity date had activity in the last ${limitDays} days.`
            : `Every ${one} had activity in the last ${limitDays} days.`}
        </Note>
        {unjudged}
      </DerivedTile>
    );
  }
  return (
    <DerivedTile label={label} value={formatValue(n, "count")}>
      <Note>{`No activity for more than ${limitDays} days. Longest: ${quiet.quiet[0]!.days} days.`}</Note>
      {unjudged}
    </DerivedTile>
  );
}
