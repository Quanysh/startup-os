// What the home page's "Needs attention" list says about obligations.

import { DUE_SOON_DAYS } from "../limits";
import type { ObligationRow } from "../obligationShape";
import { daysBetween } from "./dates";
import { dayLabel } from "./format";
import type { AttentionItem } from "./scorecard";
import { complianceSummary } from "./complianceDue";

const href = "/compliance";
const obligations = (n: number) => (n === 1 ? "1 obligation" : `${n} obligations`);

/**
 * Counts and dates only. An obligation's title is free text the owner typed
 * and may name a clinic ("Renew …'s contract"), so no title is shown on the
 * home page: the items are named on /compliance.
 *
 * `soonDays` narrows "due soon" for a page that looks less far ahead (Today:
 * 14 days). It can only narrow: never past the summary's own window.
 */
export function complianceAttention(
  rows: readonly ObligationRow[],
  today: string,
  now: number,
  soonDays: number = DUE_SOON_DAYS,
): AttentionItem[] {
  const summary = complianceSummary(rows, today);
  const { overdue, unconfirmed } = summary;
  const dueSoon = summary.dueSoon.filter((o) => daysBetween(today, o.due!) <= soonDays);
  const items: AttentionItem[] = [];
  const day = (o: ObligationRow) => dayLabel(o.due!, now);

  const oldest = overdue[0];
  if (oldest) {
    items.push({
      id: "obligations:overdue",
      severity: "overdue",
      title: `${obligations(overdue.length)} overdue`,
      detail:
        overdue.length === 1 ? `It was due ${day(oldest)}.` : `The oldest was due ${day(oldest)}.`,
      href,
    });
  }

  const next = dueSoon[0];
  if (next) {
    items.push({
      id: "obligations:due",
      severity: "due",
      title: `${obligations(dueSoon.length)} due in the next ${soonDays} days`,
      detail: dueSoon.length === 1 ? `It is due ${day(next)}.` : `The next is due ${day(next)}.`,
      href,
    });
  }

  if (unconfirmed.length > 0) {
    items.push({
      id: "obligations:unconfirmed",
      severity: "empty",
      title:
        unconfirmed.length === 1
          ? "1 obligation has a date to confirm"
          : `${unconfirmed.length} obligations have a date to confirm`,
      detail: "An unconfirmed date is not counted as due.",
      href,
    });
  }
  return items;
}
