// What the partnerships pipeline puts on Today's "Needs you": partners gone
// quiet whose next step has passed its date. One line a company, with a
// count, and no name: the names are on the page it links to.

import { COMPANIES, companyIds } from "../company";
import { PARTNER_QUIET_WORDS, needsYouPartners, type PartnerCard } from "../partnerStages";
import type { AttentionItem } from "./scorecard";

/** `today` is the caller's calendar day ("YYYY-MM-DD"). */
export function partnerAttention(
  partners: readonly PartnerCard[],
  now: number,
  today: string,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const company of companyIds()) {
    const rows = needsYouPartners(
      partners.filter((partner) => partner.company === company),
      now,
      today,
    );
    if (rows.length === 0) continue;
    const name = COMPANIES[company].name;
    items.push({
      id: `quiet-partners:${company}`,
      severity: "stale",
      title: `${rows.length} ${name} ${rows.length === 1 ? "partner has" : "partners have"} gone quiet with a next step overdue`,
      detail: `${PARTNER_QUIET_WORDS[0]!.toUpperCase()}${PARTNER_QUIET_WORDS.slice(1)}, and a next step that was due earlier.`,
      href: "/partnerships",
    });
  }
  return items;
}
