// What the Engineering page, the dashboard and the attention list work out
// from GitHub's figures and its repository list. Nothing here is stored, and
// nothing here reads a clock: a function that depends on "now" takes it as an
// argument.
//
// The figures are per company (the registry's "us" and "kz" scopes) and never
// per person. The pull requests themselves, with their owners, are the
// Engineering page's flow (src/lib/engineering/), not a figure.

import { stuckWords } from "@convex/lib/attention/engineering";
import type { CompanyId } from "@convex/lib/company";
import { periodStart } from "@convex/lib/periods";
import type { RepoMain } from "@convex/lib/sharedRecords";
import type { StatusTone } from "@/components/ui/status-chip";
import { weeklyCounts } from "./apollo";
import type { Tile } from "./scorecard";

// The levels and the attention lines are read by the owner's agent too, so
// they live where Convex can import them (convex/lib/attention/engineering.ts).
export {
  STUCK_HREF,
  engineeringAttention,
  levelOf,
  stuckWords,
  type Level,
  type PullsInView,
} from "@convex/lib/attention/engineering";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** A repository as `workTools.engineering` returns it. */
export type RepoRow = {
  repoId: string;
  org: string;
  name: string;
  company: CompanyId;
  mergedLastWeek: number;
  open: number;
  stuck: number;
  main: RepoMain;
  /** The UTC day code last landed, "YYYY-MM-DD". */
  pushedAt: string;
};
/** What `workTools.engineering` returns: the caller's companies' repositories and when the list was read. */
export type EngineeringList = { readAt: number | null; rows: RepoRow[] };

/**
 * The dashboard's one line about a company's engineering, or null with
 * nothing to say. Only what is known is said. "Merged" is last week's own
 * count; "stuck" is `stuckCount` over the pull request list (the Engineering
 * page's five rules), null for a viewer not sent the list or a list never
 * read. State table (first matching row wins):
 *   neither known   → null
 *   merged only     → "N pull requests merged last week."
 *   stuck only      → "M pull requests stuck."
 *   both            → "N pull requests merged last week, M pull requests stuck."
 */
export function engineeringLine(
  tiles: readonly Tile[],
  stuck: number | null,
  scope: CompanyId,
  now: number,
): string | null {
  const series = tiles.find((tile) => tile.key === "prs_merged" && tile.scope === scope)?.series ?? [];
  const merged = weeklyCounts(series, periodStart("week", now)).lastWeek;
  const requests = (n: number) => `${n} pull ${plural(n, "request", "requests")}`;
  if (merged === null) return stuck === null ? null : `${stuckWords(stuck)}.`;
  const shipped = `${requests(merged.value)} merged last week`;
  return stuck === null ? `${shipped}.` : `${shipped}, ${stuckWords(stuck)}.`;
}

/**
 * How a default branch's latest build reads in the table. First matching row wins:
 *   passing → Passing   (success)
 *   failing → Failing   (danger)
 *   pending → Running   (info)
 *   none    → No checks (neutral)
 */
export function mainStatus(main: RepoMain): { label: string; tone: StatusTone } {
  if (main === "passing") return { label: "Passing", tone: "success" };
  if (main === "failing") return { label: "Failing", tone: "danger" };
  if (main === "pending") return { label: "Running", tone: "info" };
  return { label: "No checks", tone: "neutral" };
}

/** The tint of a repository's row: a failing main, then waiting pull requests, else none. */
export function repoTone(row: Pick<RepoRow, "main" | "stuck">): "danger" | "warning" | undefined {
  if (row.main === "failing") return "danger";
  return row.stuck > 0 ? "warning" : undefined;
}

/** What needs a look first: a failing main, then the most waiting, then the newest push, then by name. */
export function sortRepos(rows: readonly RepoRow[]): RepoRow[] {
  return [...rows].sort(
    (a, b) =>
      Number(b.main === "failing") - Number(a.main === "failing") ||
      b.stuck - a.stuck ||
      b.pushedAt.localeCompare(a.pushedAt) ||
      a.name.localeCompare(b.name),
  );
}
