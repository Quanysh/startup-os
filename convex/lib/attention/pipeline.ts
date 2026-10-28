// What the pipelines put on the home page's "Needs attention" list: deals
// that have gone quiet, and investors in conversation with nothing planned.
//
// One line per kind, with a count, never one line per company: the list is
// for deciding where to look, and the names are on the board it links to.

import type { AttentionItem } from "./scorecard";
import {
  DEAL_STALE_DAYS,
  INVESTOR_STALE_DAYS,
  investorSummary,
  quietDeals,
  type PipelineBoard,
  type QuietCards,
} from "./pipelineDerive";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function quietDetail(quiet: QuietCards, limitDays: number): string {
  const longest = quiet.quiet[0]!.days;
  return `No activity for more than ${limitDays} days. Longest: ${longest} days.`;
}

/**
 * A board that has not loaded yet is passed as undefined and adds nothing:
 * the list must not flash "nothing to do" and then fill in.
 */
export function pipelineAttention(
  boards: {
    usDeals: PipelineBoard | undefined;
    kzDeals: PipelineBoard | undefined;
    investors: PipelineBoard | undefined;
  },
  now: number,
): AttentionItem[] {
  const items: AttentionItem[] = [];

  const markets = [
    ["us", "US", boards.usDeals],
    ["kz", "Kazakhstan", boards.kzDeals],
  ] as const;
  for (const [id, label, board] of markets) {
    if (board === undefined) continue;
    const quiet = quietDeals(board, now);
    const n = quiet.quiet.length;
    if (n === 0) continue;
    items.push({
      id: `quiet-deals:${id}`,
      severity: "stale",
      title: `${n} ${label} ${plural(n, "deal has", "deals have")} gone quiet`,
      detail: quietDetail(quiet, DEAL_STALE_DAYS),
      href: "/sales",
    });
  }

  if (boards.investors !== undefined) {
    const summary = investorSummary(boards.investors, now);
    const quiet = summary.quiet.quiet.length;
    if (quiet > 0) {
      items.push({
        id: "quiet-investors",
        severity: "stale",
        title: `${quiet} ${plural(quiet, "investor has", "investors have")} gone quiet`,
        detail: quietDetail(summary.quiet, INVESTOR_STALE_DAYS),
        href: "/fundraising",
      });
    }
    const idle = summary.noNextStep.length;
    if (idle > 0) {
      items.push({
        id: "investors-no-next-step",
        severity: "empty",
        title: `${idle} ${plural(idle, "investor", "investors")} in conversation ${plural(idle, "has", "have")} no next step`,
        detail: "Give each a next step, or move it to Passed.",
        href: "/fundraising",
      });
    }
  }

  return items;
}
