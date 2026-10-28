// Which pull requests are one person's: the ones they opened, which of those
// are stuck, and the ones somebody else opened where they are asked to
// review. Pure: from the rows `workTools.pullRequests` already sent (the
// caller's companies' and no others), the person's own GitHub username and
// "now". Where a pull request stands and whether it is stuck are `placeOf`'s
// to say (./flow.ts): nothing is decided twice.
//
// Open work and what is blocked, for the person themselves. Never anything
// merged, never a count of what someone did, never one person beside another.

import type { CompanyId } from "@convex/lib/company";
import { sameGithub } from "@convex/lib/roleRules";
import { OPEN_STAGES, placeOf, type Placed, type PullRow } from "./flow";

export const GITHUB_SET_YOURS = "Add your GitHub username on the Team page to see only yours.";
export const GITHUB_ASK_OWNER =
  "Ask the owner to add your GitHub username on the Team page to see only yours.";
/** What is said where no GitHub username is on record for the viewer. */
export const githubPrompt = (isOwner: boolean) => (isOwner ? GITHUB_SET_YOURS : GITHUB_ASK_OWNER);

export type MyPull = {
  pull: PullRow;
  placed: Placed;
  /** Why it is stuck, in words; null when it is not. */
  words: string | null;
};

export type MyPulls = {
  /** Whether a GitHub username is on record: without one, nothing here is "mine". */
  known: boolean;
  /** Open pull requests: the person's own, or the companies' when `known` is false. */
  open: MyPull[];
  /** The stuck ones among `open`, longest in their stage first. */
  stuck: MyPull[];
  /** Open ones somebody else opened that ask this person to review. Empty when `known` is false. */
  reviews: MyPull[];
};

const isOpen = (placed: Placed) => (OPEN_STAGES as readonly string[]).includes(placed.stage);

export function pullsForMe(
  rows: readonly PullRow[],
  view: { login: string | null; companies: readonly CompanyId[]; now: number },
): MyPulls {
  const open: MyPull[] = [];
  for (const pull of rows) {
    if (!view.companies.includes(pull.company)) continue;
    const placed = placeOf(pull, view.now);
    if (placed === null || !isOpen(placed)) continue;
    open.push({ pull, placed, words: placed.stuck[0]?.words ?? null });
  }
  const { login } = view;
  const by = (row: MyPull) =>
    login !== null && row.pull.authorLogin !== undefined && sameGithub(row.pull.authorLogin, login);
  const own = login === null ? open : open.filter(by);
  return {
    known: login !== null,
    open: own,
    stuck: own.filter((row) => row.words !== null).sort((a, b) => b.placed.ageMs - a.placed.ageMs),
    reviews:
      login === null
        ? []
        : open.filter(
            (row) =>
              !by(row) &&
              !row.pull.draft &&
              row.pull.reviewers.some((reviewer) => sameGithub(reviewer, login)),
          ),
  };
}
