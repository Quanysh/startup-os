// The Support page's words for its figures (convex/lib/supportMetrics.ts).

import type { SupportFailure } from "@convex/lib/support";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** How long, in the two largest units: "4 h 12 min", "2 d 5 h". */
export function durationWords(ms: number): string {
  if (ms < MIN) return "under a minute";
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.floor((ms % HOUR) / MIN);
  if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`;
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  return `${minutes} min`;
}

/** A share as a whole percent, or "Not known" where there is none. */
export function shareWords(share: number | null): string {
  return share === null ? "Not known" : `${Math.round(share * 100)}%`;
}

/** Where in Globex a chat began, as a path. */
export function pageAreaWords(area: string | null): string {
  return area === null ? "Not known" : `/${area}`;
}

/**
 * What the page says about a refused push: never the message the run stored
 * (that stays on Settings › Sources). Not configured has a panel of its own;
 * null where there is nothing to say.
 */
export function failureSentence(failure: SupportFailure | null): string | null {
  return failure === "refused"
    ? "The last push from the daily Intercom task was refused, so what is below is from the last good push. Settings › Sources says why."
    : null;
}
