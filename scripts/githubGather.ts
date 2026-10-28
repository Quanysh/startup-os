// The logic of `pnpm gather:github`: read each tracked repository's pull
// requests and its default branch's build from GitHub, work out the counts,
// list the pull requests that are open or were lately merged or closed, build
// the three envelopes, check them with the endpoint's own rules, and post
// them only with --send. Everything it touches is passed in, so it is tested
// without `gh`, a network or a clock. gather-github.ts is the thin wrapper.
//
// WHAT IS READ. Metadata only. For the counts: a pull request's state,
// whether it is a draft, when it was opened and merged, whether its author is
// a bot, and when its last reviews were submitted; a repository's name,
// whether it is archived or a fork, when it was last pushed to, and its
// default branch's check result.
//
// For the list (the owner asked for it: the Engineering page shows who owns
// each pull request and where it stands), and only for the pull requests
// that are open or were merged or closed in the last 14 days: its number and
// title, its author's login and name, its dates, GitHub's review decision,
// how many reviewers are asked and the logins of up to five of them, and its
// head commit's check result.
//
// Never: code, a diff, a description, a comment or a review's text, a file
// list, a branch name, a commit message or a size. The queries below do not
// ask for them, and the parsers name only the fields above, so anything else
// is dropped. Nothing is counted per person.
//
// HOW. Only through `gh api graphql`, run as a child process by the wrapper:
// `gh` holds the credential, and this never reads, takes or prints one. Every
// query is a read. Every list is paged to its end.
//
// ALL OR NOTHING. If any call fails, times out, or answers in a shape this
// does not expect, nothing is sent and the run exits 1 in fixed words: a
// short read would overwrite good numbers with smaller ones.
//
// THE DEFINITIONS (all on pull requests not opened by a bot):
//   merged   state MERGED, counted in the UTC week (Monday to Monday) of `mergedAt`.
//   opened   any state, counted in the UTC week of `createdAt`.
//   open     state OPEN right now, drafts included.
//   stuck    state OPEN, not a draft, and more than three full days (72 hours)
//            since the later of `createdAt` and the newest review's
//            `submittedAt`. A review of any kind counts, an unsubmitted
//            (pending) one does not.
//   failing  a tracked repository whose default branch's latest commit has
//            `statusCheckRollup.state` FAILURE or ERROR.
//
// THE LIST (also without bots' pull requests): every open one, and each one
// merged or closed in the last 14 days. At most 600 rows, and no more than
// one request to the endpoint may hold: open ones are kept first (oldest
// first), then the most recently closed, and the summary says how many were
// left out. A pull request's stage, and whether it is stuck, are not worked
// out here: they depend on the time of reading (src/lib/engineering/flow.ts).

import { z } from "zod";
import { ingestTokenEnv } from "../convex/connectors/manifest";
import { COMPANIES, companyIds, type CompanyId } from "../convex/lib/company";
import {
  MAX_INGEST_BYTES,
  type IngestIssue,
  type RecordsEnvelope,
  type SnapshotEnvelope,
  type SnapshotRow,
} from "../convex/lib/ingestSchema";
import {
  MAX_PR_REVIEWERS,
  MAX_PR_TITLE_LENGTH,
  MAX_PULL_REQUESTS,
  PR_CLOSED_SHOWN_DAYS,
  PR_STUCK_AFTER_DAYS,
} from "../convex/lib/limits";
import { CAPS, cleanRemote } from "../convex/lib/mirrorRules";
import { periodStart } from "../convex/lib/periods";
import {
  LOGIN,
  SHARED_CAPS,
  pullUrl,
  type PushedSharedRow,
  type RepoMain,
  type ReviewDecision,
} from "../convex/lib/sharedRecords";
import { closedWeeks } from "../convex/lib/weeks";
import { GITHUB_REPOS, trackingOf, type RepoConfig, type SkipReason } from "./githubRepos";
import { ingestTokenProblem, ingestUrlProblem } from "./ingestUrl";
import { postEnvelope } from "./postEnvelope";
import { checkEnvelope } from "./pushEnvelope";

export const USAGE = "Usage: pnpm gather:github [--send]";

/** How many finished weeks of merged and opened counts each run sends. */
export const WEEKS = 13;
/** An open pull request has waited too long after this many full days. The page quotes the same number. */
export const STUCK_AFTER_DAYS = PR_STUCK_AFTER_DAYS;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A list longer than this many pages is a loop, not a list. */
const MAX_PAGES = 500;
/** How many of a pull request's newest reviews are read for the time of the last one. */
const REVIEWS_READ = 10;

/**
 * One call to `gh`, as arguments: never a shell string. `ok: false` is any
 * failure at all (a non-zero exit, a timeout, `gh` missing); what `gh` said
 * about it is not passed on, and so is never printed.
 */
export type Gh = (args: readonly string[]) => Promise<{ ok: true; stdout: string } | { ok: false }>;

export type GatherDeps = {
  gh: Gh;
  fetch: typeof fetch;
  print: (line: string) => void;
  printError: (line: string) => void;
  now: () => Date;
};

/** A merged or closed pull request is listed for this many days. The page quotes the same number. */
export const CLOSED_LISTED_DAYS = PR_CLOSED_SHOWN_DAYS;
/** What one list may weigh as JSON: the endpoint's limit, less room for the envelope around it. */
export const LIST_BYTES = MAX_INGEST_BYTES - 1024;

// ── The four queries ────────────────────────────────────────────────────────
// Exactly what is asked of GitHub. A field not written here is not fetched.

/**
 * An organisation's repositories, 50 to a page: each row carries its default
 * branch's check rollup, which GitHub works out per repository, so a smaller
 * page keeps one call well inside GitHub's own time limit.
 */
export const REPOS_QUERY = `query($org: String!, $after: String) {
  organization(login: $org) {
    repositories(first: 50, after: $after, orderBy: {field: NAME, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        isArchived
        isFork
        pushedAt
        defaultBranchRef { target { ... on Commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

/** One repository's pull requests, every state, 100 to a page. */
export const PULLS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 100, after: $after, orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        state
        isDraft
        createdAt
        mergedAt
        author { __typename }
        reviews(last: ${REVIEWS_READ}) { nodes { submittedAt } }
      }
    }
  }
}`;

/**
 * What is asked about a pull request that is listed. No `url` (it is rebuilt
 * from the repository and the number), no `body`, no branch, no file, no
 * comment, and of a commit only its check result. An author is asked for a
 * login and, where it is a person, a name; a requested reviewer for a login
 * where it is a person (a team is counted, never named).
 */
const LISTED_FIELDS = `number
        title
        state
        isDraft
        createdAt
        updatedAt
        mergedAt
        closedAt
        reviewDecision
        author { __typename login ... on User { name } }
        reviews(last: ${REVIEWS_READ}) { nodes { submittedAt } }
        latestOpinionatedReviews(first: 20) { nodes { state } }
        reviewRequests(first: ${MAX_PR_REVIEWERS}) { totalCount nodes { requestedReviewer { __typename ... on User { login } } } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

/** One repository's open pull requests, oldest first, 50 to a page (each row carries a check rollup). */
export const OPEN_PULLS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 50, after: $after, states: [OPEN], orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ${LISTED_FIELDS}
      }
    }
  }
}`;

/**
 * One repository's merged and closed pull requests, the most recently touched
 * first, so the read can stop at the first page that reaches further back
 * than the list does: closing one touches it, so none closed since then has
 * an older `updatedAt`.
 */
export const CLOSED_PULLS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 50, after: $after, states: [MERGED, CLOSED], orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ${LISTED_FIELDS}
      }
    }
  }
}`;

// ── Shapes of the answers ───────────────────────────────────────────────────
// Each names only the fields that are used. Zod drops the rest at the door.

const instant = z.iso.datetime({ offset: true });
const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });

const repoNode = z.object({
  name: z.string().min(1).max(100),
  isArchived: z.boolean(),
  isFork: z.boolean(),
  pushedAt: instant.nullable(),
  defaultBranchRef: z
    .object({
      target: z
        .object({
          statusCheckRollup: z.object({ state: z.string().max(40) }).nullable().optional(),
        })
        .nullable(),
    })
    .nullable(),
});
const reposPage = z.object({
  data: z.object({
    organization: z.object({
      repositories: z.object({ pageInfo, nodes: z.array(repoNode) }),
    }),
  }),
});

const pullNode = z.object({
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  isDraft: z.boolean(),
  createdAt: instant,
  mergedAt: instant.nullable(),
  // Null for a deleted account. Only its type is asked for: bot or not.
  author: z.object({ __typename: z.string().max(40) }).nullable(),
  reviews: z.object({ nodes: z.array(z.object({ submittedAt: instant.nullable() })) }),
});
const pullsPage = z.object({
  data: z.object({
    repository: z.object({
      pullRequests: z.object({ pageInfo, nodes: z.array(pullNode) }),
    }),
  }),
});

const state40 = z.string().max(40);
const listedNode = z.object({
  number: z.number().int().min(1).max(SHARED_CAPS.pullNumber),
  title: z.string().max(5000),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  isDraft: z.boolean(),
  createdAt: instant,
  updatedAt: instant,
  mergedAt: instant.nullable(),
  closedAt: instant.nullable(),
  reviewDecision: state40.nullable(),
  // Null for a deleted account. A name is a person's only: a bot has none.
  author: z
    .object({
      __typename: state40,
      login: z.string().max(200),
      name: z.string().max(2000).nullable().optional(),
    })
    .nullable(),
  reviews: z.object({ nodes: z.array(z.object({ submittedAt: instant.nullable() })) }),
  latestOpinionatedReviews: z.object({ nodes: z.array(z.object({ state: state40 })) }),
  reviewRequests: z.object({
    totalCount: z.number().int().min(0),
    nodes: z.array(
      z.object({
        // Null where the reviewer cannot be seen; a team has no login here.
        requestedReviewer: z
          .object({ __typename: state40, login: z.string().max(200).optional() })
          .nullable(),
      }),
    ),
  }),
  commits: z.object({
    nodes: z.array(
      z.object({
        commit: z.object({ statusCheckRollup: z.object({ state: state40 }).nullable().optional() }),
      }),
    ),
  }),
});
type ListedNode = z.infer<typeof listedNode>;
const listedPage = z.object({
  data: z.object({
    repository: z.object({
      pullRequests: z.object({ pageInfo, nodes: z.array(listedNode) }),
    }),
  }),
});

// ── The rules ───────────────────────────────────────────────────────────────

/** A pull request as the rules need it: times as numbers, and nothing that names anyone. */
export type Pull = {
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  createdAt: number;
  mergedAt: number | null;
  /** Opened by a bot (dependabot, renovate, github-actions: GitHub's author type "Bot"). */
  bot: boolean;
  /** When its newest submitted review was submitted; null with none. */
  lastReviewAt: number | null;
};

/** The Monday (UTC) of the week an instant falls in. */
export const weekOf = (at: number): string => periodStart("week", at);

/**
 * Whether an open pull request has waited more than three full days: open,
 * not a draft, and more than 72 hours since it was opened or last reviewed,
 * whichever is later. Exactly three days is not yet more than three.
 */
export function isStuck(pull: Pull, now: number): boolean {
  if (pull.state !== "OPEN" || pull.isDraft) return false;
  const since = Math.max(pull.createdAt, pull.lastReviewAt ?? 0);
  return now - since > STUCK_AFTER_DAYS * DAY_MS;
}

/**
 * How a default branch stands, from its latest commit's check rollup. First
 * matching row wins:
 *   no rollup (no checks, or no default branch) → none
 *   SUCCESS                                     → passing
 *   FAILURE, ERROR                              → failing
 *   PENDING, EXPECTED                           → pending
 *   anything else                               → null: not guessed at
 */
export function mainOf(state: string | null): RepoMain | null {
  if (state === null) return "none";
  if (state === "SUCCESS") return "passing";
  if (state === "FAILURE" || state === "ERROR") return "failing";
  if (state === "PENDING" || state === "EXPECTED") return "pending";
  return null;
}

/** A listed pull request, as it is sent: the whole allow-list of its fields. */
export type ListedPull = PushedSharedRow<"pull_request">;

/**
 * Where a pull request's review stands. GitHub's own `reviewDecision` where
 * it gives one; where it gives none (a repository whose branch rules ask for
 * no review), the reviewers' latest opinions say it. First matching row wins:
 *   APPROVED                              → approved
 *   CHANGES_REQUESTED                     → changes_requested
 *   REVIEW_REQUIRED                       → review_required
 *   none, and an opinion asks for changes → changes_requested
 *   none, and an opinion approves         → approved
 *   none                                  → none
 *   anything else                         → null: not guessed at
 */
export function decisionOf(decision: string | null, opinions: readonly string[]): ReviewDecision | null {
  if (decision === "APPROVED") return "approved";
  if (decision === "CHANGES_REQUESTED") return "changes_requested";
  if (decision === "REVIEW_REQUIRED") return "review_required";
  if (decision !== null) return null;
  if (opinions.includes("CHANGES_REQUESTED")) return "changes_requested";
  return opinions.includes("APPROVED") ? "approved" : "none";
}

const isLogin = (value: string | undefined): value is string =>
  value !== undefined && value.length <= SHARED_CAPS.login && LOGIN.test(value);
const iso = (value: string) => new Date(value).toISOString();

/**
 * One of GitHub's pull requests as a row of the list. `"bot"` for one a bot
 * opened (left out, as from every count), and `null` for an answer this does
 * not know how to read, which ends the run.
 *
 * The title and the name are text somebody typed: cleaned and cut here as the
 * endpoint will clean them again. A login that is not in GitHub's usual form
 * is not sent (the row is, without it), and `odd` counts those.
 */
export function listedRowOf(
  node: ListedNode,
  repo: { org: string; name: string; company: CompanyId },
  odd: { logins: number },
): ListedPull | "bot" | null {
  if (node.author?.__typename === "Bot") return "bot";
  const repoId = `${repo.org}/${repo.name}`;
  const reviewDecision = decisionOf(
    node.reviewDecision,
    node.latestOpinionatedReviews.nodes.map((review) => review.state),
  );
  const checks = mainOf(node.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null);
  if (reviewDecision === null || checks === null) return null;
  // What a state says about its dates: a merged one was merged at some time.
  if (node.state === "MERGED" && node.mergedAt === null) return null;
  if (node.state === "CLOSED" && node.closedAt === null) return null;

  let authorLogin: string | undefined;
  if (node.author !== null) {
    if (isLogin(node.author.login)) authorLogin = node.author.login;
    else odd.logins += 1;
  }
  const authorName = cleanRemote(node.author?.name ?? "", CAPS.name);
  const reviewers: string[] = [];
  for (const { requestedReviewer } of node.reviewRequests.nodes) {
    if (requestedReviewer?.__typename !== "User") continue;
    if (isLogin(requestedReviewer.login)) reviewers.push(requestedReviewer.login);
    else odd.logins += 1;
  }
  const reviewed = node.reviews.nodes.flatMap((review) =>
    review.submittedAt === null ? [] : [Date.parse(review.submittedAt)],
  );
  const created = Date.parse(node.createdAt);
  // A review dated before the pull request is a clock's mistake: left out.
  const lastReview = reviewed.filter((at) => at >= created);
  const kept = reviewers.slice(0, MAX_PR_REVIEWERS);
  return {
    repoId,
    number: node.number,
    company: repo.company,
    title: cleanRemote(node.title, MAX_PR_TITLE_LENGTH) || "(no title)",
    // Rebuilt, never read: the one link the page renders.
    url: pullUrl(repoId, node.number),
    ...(authorLogin === undefined ? {} : { authorLogin }),
    ...(authorName === "" ? {} : { authorName }),
    draft: node.isDraft,
    state: node.state === "OPEN" ? "open" : node.state === "MERGED" ? "merged" : "closed",
    createdAt: iso(node.createdAt),
    updatedAt: iso(node.updatedAt),
    ...(node.state === "MERGED" && node.mergedAt !== null ? { mergedAt: iso(node.mergedAt) } : {}),
    ...(node.state !== "OPEN" && node.closedAt !== null ? { closedAt: iso(node.closedAt) } : {}),
    reviewDecision,
    ...(lastReview.length === 0
      ? {}
      : { lastReviewAt: new Date(Math.max(...lastReview)).toISOString() }),
    reviewersRequested: Math.min(
      Math.max(node.reviewRequests.totalCount, kept.length),
      SHARED_CAPS.reviewersRequested,
    ),
    reviewers: kept,
    checks,
  };
}

/** When a merged or closed pull request left the flow; null for an open one. */
const endedAt = (row: ListedPull): number | null =>
  row.state === "open" ? null : Date.parse(row.mergedAt ?? row.closedAt ?? row.updatedAt);

/**
 * The list held to what one push may carry: `maxRows` rows and `maxBytes` of
 * JSON. Every open one comes first (the oldest first: they are what the page
 * is for), then the merged and closed, the most recently ended first; what
 * does not fit is left out from the end, and counted.
 */
export function limitPulls(
  rows: readonly ListedPull[],
  maxRows: number = MAX_PULL_REQUESTS,
  maxBytes: number = LIST_BYTES,
): { kept: ListedPull[]; leftOut: number } {
  const ordered = [...rows].sort((a, b) => {
    const [endA, endB] = [endedAt(a), endedAt(b)];
    if (endA === null && endB === null) return Date.parse(a.createdAt) - Date.parse(b.createdAt);
    if (endA === null || endB === null) return endA === null ? -1 : 1;
    return endB - endA;
  });
  const kept: ListedPull[] = [];
  let bytes = 0;
  for (const row of ordered) {
    if (kept.length >= maxRows) break;
    // Its own JSON and the comma after it.
    bytes += new TextEncoder().encode(JSON.stringify(row)).length + 1;
    if (bytes > maxBytes) break;
    kept.push(row);
  }
  return { kept, leftOut: rows.length - kept.length };
}

export type Figures = {
  /** By finished week (its Monday), oldest first: every one of the `WEEKS`, zeros included. */
  merged: Record<string, number>;
  opened: Record<string, number>;
  mergedLastWeek: number;
  open: number;
  stuck: number;
  /** Pull requests left out of every count above because a bot opened them. */
  bots: number;
};

/** One repository's counts from all of its pull requests. Bots' are in none. */
export function figuresOf(pulls: readonly Pull[], now: number): Figures {
  const weeks = closedWeeks(now, WEEKS);
  const merged: Record<string, number> = Object.fromEntries(weeks.map((week) => [week, 0]));
  const opened: Record<string, number> = { ...merged };
  let open = 0;
  let stuck = 0;
  let bots = 0;
  for (const pull of pulls) {
    if (pull.bot) {
      bots += 1;
      continue;
    }
    const openedIn = weekOf(pull.createdAt);
    if (openedIn in opened) opened[openedIn]! += 1;
    if (pull.state === "MERGED" && pull.mergedAt !== null) {
      const mergedIn = weekOf(pull.mergedAt);
      if (mergedIn in merged) merged[mergedIn]! += 1;
    }
    if (pull.state === "OPEN") open += 1;
    if (isStuck(pull, now)) stuck += 1;
  }
  return { merged, opened, mergedLastWeek: merged[weeks.at(-1)!]!, open, stuck, bots };
}

// ── Reading GitHub ──────────────────────────────────────────────────────────

const GH_FAILED = "GitHub could not be read: the gh command failed or timed out. Nothing was sent.";
const BAD_SHAPE = "GitHub's answer was not in the expected shape. Nothing was sent.";
const NO_END = "A list from GitHub did not end. Nothing was sent.";
const EMPTY_ORG =
  "An organisation listed no repository, which is how a failed read looks. Nothing was sent.";
const NOTHING_TRACKED =
  "No repository is tracked, which is how a failed read looks. Nothing was sent.";

/** Thrown inside `gather` and caught there: its message is one of the fixed sentences above. */
class Stop extends Error {}

/** Every page of one list. A failure, an unexpected shape or a list with no end stops the run. */
async function pages<T extends z.ZodType, N>(
  gh: Gh,
  query: string,
  variables: Record<string, string>,
  shape: T,
  listOf: (page: z.infer<T>) => { pageInfo: z.infer<typeof pageInfo>; nodes: N[] },
  /** Asked of each page as it arrives: true where no later page is needed. */
  enough: (page: readonly N[]) => boolean = () => false,
): Promise<N[]> {
  const nodes: N[] = [];
  let after: string | null = null;
  for (let n = 0; n < MAX_PAGES; n += 1) {
    // -f passes a value as it is. -F would read a file for one that starts with "@".
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [name, value] of Object.entries(variables)) args.push("-f", `${name}=${value}`);
    if (after !== null) args.push("-f", `after=${after}`);
    const answer = await gh(args);
    if (!answer.ok) throw new Stop(GH_FAILED);
    let raw: unknown;
    try {
      raw = JSON.parse(answer.stdout);
    } catch {
      throw new Stop(BAD_SHAPE);
    }
    // GraphQL reports a partial failure beside the data: partial is refused.
    if (typeof raw === "object" && raw !== null && "errors" in raw) throw new Stop(BAD_SHAPE);
    const parsed = shape.safeParse(raw);
    if (!parsed.success) throw new Stop(BAD_SHAPE);
    const list = listOf(parsed.data);
    nodes.push(...list.nodes);
    if (!list.pageInfo.hasNextPage || enough(list.nodes)) return nodes;
    if (list.pageInfo.endCursor === null || list.pageInfo.endCursor === "") throw new Stop(BAD_SHAPE);
    after = list.pageInfo.endCursor;
  }
  throw new Stop(NO_END);
}

/** A tracked repository and what was counted for it. No field names a person or a pull request. */
export type RepoFigures = Figures & {
  org: string;
  name: string;
  company: CompanyId;
  main: RepoMain;
  /** The UTC day code last landed. */
  pushedAt: string;
};

export type Gathered =
  | {
      ok: true;
      /** Repositories GitHub listed, tracked or not. */
      listed: number;
      skipped: Record<SkipReason, number>;
      repos: RepoFigures[];
      /** Every pull request that is open, or was merged or closed in the last 14 days. Bots' are not among them. */
      pulls: ListedPull[];
      /** Logins left out of the list for not being in GitHub's usual form. */
      oddLogins: number;
    }
  | { ok: false; problem: string };

/**
 * Read both organisations and every tracked repository's pull requests. All
 * or nothing: the first failure ends it, with one fixed sentence and no rows.
 */
export async function gather(
  deps: Pick<GatherDeps, "gh" | "now">,
  config: RepoConfig = GITHUB_REPOS,
): Promise<Gathered> {
  const now = deps.now().getTime();
  try {
    const skipped: Record<SkipReason, number> = { ignored: 0, archived: 0, fork: 0, quiet: 0 };
    const tracked: Omit<RepoFigures, keyof Figures>[] = [];
    let listed = 0;
    for (const org of config.orgs) {
      const nodes = await pages(deps.gh, REPOS_QUERY, { org: org.login }, reposPage, (page) =>
        page.data.organization.repositories,
      );
      // An organisation with nothing in it is what missing access looks like.
      if (nodes.length === 0) throw new Stop(EMPTY_ORG);
      listed += nodes.length;
      for (const node of nodes) {
        const tracking = trackingOf({ org: org.login, ...node }, now, config);
        if (!tracking.tracked) {
          skipped[tracking.reason] += 1;
          continue;
        }
        const main = mainOf(node.defaultBranchRef?.target?.statusCheckRollup?.state ?? null);
        // A check state this does not know is not filed as passing or as none.
        if (main === null || node.pushedAt === null) throw new Stop(BAD_SHAPE);
        tracked.push({
          org: org.login,
          name: node.name,
          company: tracking.company,
          main,
          pushedAt: new Date(node.pushedAt).toISOString().slice(0, 10),
        });
      }
    }
    if (tracked.length === 0) throw new Stop(NOTHING_TRACKED);

    const repos: RepoFigures[] = [];
    const listedPulls: ListedPull[] = [];
    const odd = { logins: 0 };
    const since = now - CLOSED_LISTED_DAYS * DAY_MS;
    for (const repo of tracked) {
      const nodes = await pages(
        deps.gh,
        PULLS_QUERY,
        { owner: repo.org, name: repo.name },
        pullsPage,
        (page) => page.data.repository.pullRequests,
      );
      const pulls = nodes.map((node): Pull => {
        const reviewed = node.reviews.nodes.flatMap((review) =>
          review.submittedAt === null ? [] : [Date.parse(review.submittedAt)],
        );
        return {
          state: node.state,
          isDraft: node.isDraft,
          createdAt: Date.parse(node.createdAt),
          mergedAt: node.mergedAt === null ? null : Date.parse(node.mergedAt),
          bot: node.author?.__typename === "Bot",
          lastReviewAt: reviewed.length === 0 ? null : Math.max(...reviewed),
        };
      });
      repos.push({ ...repo, ...figuresOf(pulls, now) });

      // The list: the open ones, then those merged or closed lately.
      const variables = { owner: repo.org, name: repo.name };
      const listOf = (page: z.infer<typeof listedPage>) => page.data.repository.pullRequests;
      const open = await pages(deps.gh, OPEN_PULLS_QUERY, variables, listedPage, listOf);
      const ended = await pages(
        deps.gh,
        CLOSED_PULLS_QUERY,
        variables,
        listedPage,
        listOf,
        // Newest activity first: a page that reaches past the window is the last one needed.
        (page) => page.length > 0 && Date.parse(page.at(-1)!.updatedAt) < since,
      );
      for (const [nodes, isOpen] of [
        [open, true],
        [ended, false],
      ] as const) {
        for (const node of nodes) {
          // Each query names its states; an answer outside them is not one.
          if ((node.state === "OPEN") !== isOpen) throw new Stop(BAD_SHAPE);
          const row = listedRowOf(node, repo, odd);
          if (row === null) throw new Stop(BAD_SHAPE);
          if (row === "bot") continue;
          const end = endedAt(row);
          if (end === null || end >= since) listedPulls.push(row);
        }
      }
    }
    return { ok: true, listed, skipped, repos, pulls: listedPulls, oddLogins: odd.logins };
  } catch (error) {
    // Only this file's own sentences are passed on; anything else thrown is
    // reduced to one of them, since it may quote an answer.
    return { ok: false, problem: error instanceof Stop ? error.message : BAD_SHAPE };
  }
}

// ── The envelopes ───────────────────────────────────────────────────────────

const sum = (numbers: readonly number[]) => numbers.reduce((total, n) => total + n, 0);

/**
 * The envelopes of one read: the numbers per company, the repository list,
 * and (given any) the pull request list, which is null with none to send: an
 * empty list is never sent, since it is how a failed read looks. A company with no tracked repository gets no rows at all: its figures
 * are then unknown (and soon said to be out of date), never a row of zeros
 * that a read without access to its repositories would also produce.
 */
export function buildEnvelopes(
  repos: readonly RepoFigures[],
  at: Date,
  pulls: readonly ListedPull[] = [],
): { snapshots: SnapshotEnvelope; records: RecordsEnvelope; pulls: RecordsEnvelope | null } {
  const now = at.getTime();
  const weeks = closedWeeks(now, WEEKS);
  const thisWeek = periodStart("week", now);
  const header = {
    version: 1 as const,
    source: "github",
    batchId: `github-${at.toISOString().slice(0, 10)}`,
    observedAt: at.toISOString(),
  };

  const snapshots: SnapshotRow[] = [];
  for (const scope of companyIds()) {
    const own = repos.filter((repo) => repo.company === scope);
    if (own.length === 0) continue;
    const row = (key: string, start: string, value: number): SnapshotRow => ({
      key,
      scope,
      period: "week",
      periodStart: start,
      value,
    });
    // A week's own count, for finished weeks only: never the week in progress.
    for (const week of weeks) snapshots.push(row("prs_merged", week, sum(own.map((r) => r.merged[week]!))));
    for (const week of weeks) snapshots.push(row("prs_opened", week, sum(own.map((r) => r.opened[week]!))));
    // Levels: what is true now, filed under the week this is read in.
    snapshots.push(row("prs_open", thisWeek, sum(own.map((r) => r.open))));
    snapshots.push(row("prs_stuck", thisWeek, sum(own.map((r) => r.stuck))));
    snapshots.push(row("repos_failing", thisWeek, own.filter((r) => r.main === "failing").length));
    snapshots.push(row("repos_tracked", thisWeek, own.length));
  }

  // The whole allow-list of a repository's fields, written out: a field of
  // `RepoFigures` is sent only if it is named here.
  const records: PushedSharedRow<"repo">[] = repos.map((repo) => ({
    repoId: `${repo.org}/${repo.name}`,
    org: repo.org,
    name: repo.name,
    company: repo.company,
    mergedLastWeek: repo.mergedLastWeek,
    open: repo.open,
    stuck: repo.stuck,
    main: repo.main,
    pushedAt: repo.pushedAt,
  }));
  return {
    snapshots: { ...header, snapshots },
    records: { ...header, kind: "repo", records },
    pulls: pulls.length === 0 ? null : { ...header, kind: "pull_request", records: [...pulls] },
  };
}

// ── The command ─────────────────────────────────────────────────────────────

const MAX_ISSUES = 20;
/** An issue's words made safe for a terminal: no control characters, and not long. */
const plain = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 200);

/**
 * Returns the process exit code. Nothing here prints a repository's name, a
 * pull request's title, a login, a person's name or a token: it runs
 * unattended, and what it prints is kept in a transcript.
 */
export async function run(
  argv: string[],
  env: Record<string, string | undefined>,
  deps: GatherDeps,
): Promise<number> {
  const { print, printError } = deps;

  // Sending is the explicit act: a lost, misspelled or swallowed flag must end
  // in a printout, never a push. --dry-run is the long way to say the default.
  const send = argv.includes("--send");
  const known = argv.every((arg) => arg === "--send" || arg === "--dry-run");
  if (!known || (send && argv.includes("--dry-run"))) {
    printError(USAGE);
    return 1;
  }

  // Asked before GitHub is: a run that could not send should not read first.
  const tokenEnv = ingestTokenEnv("github");
  let url = "";
  let token = "";
  if (send) {
    if (!env.STARTUP_OS_INGEST_URL || !env[tokenEnv]) {
      printError(`Set STARTUP_OS_INGEST_URL and ${tokenEnv} in .env.push or the environment.`);
      return 1;
    }
    url = env.STARTUP_OS_INGEST_URL;
    token = env[tokenEnv];
    const problem = ingestUrlProblem(url) ?? ingestTokenProblem(token, tokenEnv);
    if (problem !== null) {
      printError(problem);
      return 1;
    }
  }

  const read = await gather(deps);
  if (!read.ok) {
    printError(read.problem);
    return 1;
  }
  const at = deps.now();
  const fitted = limitPulls(read.pulls);
  const envelopes = buildEnvelopes(read.repos, at, fitted.kept);

  // The endpoint's own rules, applied here first to all, before any is sent.
  const numbers = checkEnvelope(envelopes.snapshots, at.getTime());
  const list = checkEnvelope(envelopes.records, at.getTime());
  const pullList = envelopes.pulls === null ? null : checkEnvelope(envelopes.pulls, at.getTime());
  if (!numbers.ok || !list.ok || (pullList !== null && !pullList.ok)) {
    const issues: IngestIssue[] = [];
    for (const checked of [numbers, list, ...(pullList === null ? [] : [pullList])]) {
      if (checked.ok) continue;
      if (checked.issues) issues.push(...checked.issues);
      else issues.push({ path: "envelope", message: checked.problem });
    }
    for (const issue of issues.slice(0, MAX_ISSUES)) {
      printError(`${plain(issue.path)}: ${plain(issue.message)}`);
    }
    if (issues.length > MAX_ISSUES) printError(`${issues.length - MAX_ISSUES} more issues not shown.`);
    printError("Nothing was sent.");
    return 1;
  }

  // Counts only.
  const { skipped } = read;
  print("Source: github");
  print(`Repositories listed: ${read.listed}`);
  print(
    `Tracked: ${read.repos.length} (ignored ${skipped.ignored}, archived ${skipped.archived}, forks ${skipped.fork}, not pushed to in ${GITHUB_REPOS.activeDays} days ${skipped.quiet})`,
  );
  print(`Pull requests by bots left out: ${sum(read.repos.map((repo) => repo.bots))}`);
  for (const company of companyIds()) {
    const own = read.repos.filter((repo) => repo.company === company);
    print(
      `${COMPANIES[company].name}: ${own.length} repositories, ${sum(own.map((r) => r.mergedLastWeek))} merged last week, ${sum(own.map((r) => r.open))} open, ${sum(own.map((r) => r.stuck))} waiting more than ${STUCK_AFTER_DAYS} days, ${own.filter((r) => r.main === "failing").length} with a failing main`,
    );
  }
  const states = (state: ListedPull["state"]) => fitted.kept.filter((row) => row.state === state).length;
  print(
    `Pull requests listed: ${fitted.kept.length} (${states("open")} open, ${states("merged")} merged and ${states("closed")} closed in the last ${CLOSED_LISTED_DAYS} days)`,
  );
  if (fitted.leftOut > 0) {
    print(
      `Pull requests left out of the list: ${fitted.leftOut} (it holds ${MAX_PULL_REQUESTS} rows and one request's size; open ones are kept first, then the most recently closed)`,
    );
  }
  if (read.oddLogins > 0) {
    print(`Logins left out of the list: ${read.oddLogins} (not in GitHub's usual form)`);
  }
  if (pullList === null) {
    print("No pull request to list: an empty list is never sent, so the stored list is left as it is.");
  }
  for (const line of [...numbers.summary, ...list.summary, ...(pullList?.ok ? pullList.summary : [])]) {
    print(line);
  }

  if (!send) {
    // On stderr, as the other push scripts say it.
    printError("Nothing was sent. Add --send to push it.");
    return 0;
  }

  // Three posts cannot be one. The numbers go first: if they are refused no
  // list is sent, and if a list fails afterwards that is said, since a
  // second run puts it right (each post overwrites what it names).
  if ((await postEnvelope(url, token, envelopes.snapshots, deps)) !== 0) {
    printError("The numbers were not written, so the repository list was not sent.");
    return 1;
  }
  if ((await postEnvelope(url, token, envelopes.records, deps)) !== 0) {
    printError("The numbers were written but the repository list was not. Run it again.");
    return 1;
  }
  if (envelopes.pulls !== null && (await postEnvelope(url, token, envelopes.pulls, deps)) !== 0) {
    printError(
      "The numbers and the repository list were written but the pull request list was not. Run it again.",
    );
    return 1;
  }
  return 0;
}
