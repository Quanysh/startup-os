// Which GitHub repositories the OS counts, and for which company. Checked in
// on purpose: the map is a decision, and a change to it is a reviewed change.
//
// A repository's company is, first match wins:
//   1. an explicit override for that repository ("org/name"),
//   2. a name rule (its name starts with one of a company's prefixes),
//   3. its organisation's default.
// Before any of that, a repository is left out altogether if it is on the
// ignore list, archived, a fork, or was not pushed to in the last 90 days.
//
// Pure: `pnpm gather:github` reads GitHub, this only decides.

import type { CompanyId } from "../convex/lib/company";
import { GITHUB_IGNORED, GITHUB_NAME_RULES, GITHUB_ORGS } from "../convex/lib/features";
import { REPO_ACTIVE_DAYS } from "../convex/lib/limits";

/** A repository with no push for this many days is not tracked. The page quotes the same number. */
export const ACTIVE_DAYS = REPO_ACTIVE_DAYS;

export type RepoConfig = {
  /** The organisations read, each with the company its repositories default to. */
  orgs: readonly { login: string; company: CompanyId }[];
  /** A repository whose name starts with one of these is that company's, wherever it lives. */
  nameRules: readonly { company: CompanyId; prefixes: readonly string[] }[];
  /** "org/name" (lower case) to a company: beats a name rule and the default. */
  overrides: Readonly<Record<string, CompanyId>>;
  /** Repository names never tracked, in either organisation. */
  ignored: readonly string[];
  activeDays: number;
};

// The organisations, the name rules and the ignored repositories are this
// deployment's (convex/lib/features.ts).
export const GITHUB_REPOS: RepoConfig = {
  orgs: GITHUB_ORGS,
  nameRules: GITHUB_NAME_RULES,
  // Empty to start. Add a line when a name rule or a default is wrong for one
  // repository: "globex-corp/some-repo": "us".
  overrides: {},
  ignored: GITHUB_IGNORED,
  activeDays: ACTIVE_DAYS,
};

const DAY_MS = 24 * 60 * 60 * 1000;
// GitHub does not tell two organisations or repositories apart by case alone.
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The company a repository is counted for; null for an organisation the map does not hold. */
export function companyOfRepo(
  org: string,
  name: string,
  config: RepoConfig = GITHUB_REPOS,
): CompanyId | null {
  const home = config.orgs.find((o) => same(o.login, org));
  if (home === undefined) return null;
  const override = Object.entries(config.overrides).find(([id]) => same(id, `${org}/${name}`));
  if (override !== undefined) return override[1];
  const lower = name.toLowerCase();
  const rule = config.nameRules.find((r) => r.prefixes.some((prefix) => lower.startsWith(prefix)));
  return rule?.company ?? home.company;
}

/** A repository as GitHub lists it: what the decision needs and nothing else. */
export type ListedRepo = {
  org: string;
  name: string;
  isArchived: boolean;
  isFork: boolean;
  /** When code last landed, as GitHub gives it; null for a repository never pushed to. */
  pushedAt: string | null;
};

export type SkipReason = "ignored" | "archived" | "fork" | "quiet";
export type Tracking = { tracked: true; company: CompanyId } | { tracked: false; reason: SkipReason };

/**
 * Whether a repository is counted, and for whom. First matching row wins:
 *   on the ignore list                         → ignored
 *   archived                                   → archived
 *   a fork                                     → fork
 *   never pushed to, or not in `activeDays`    → quiet
 *   otherwise                                  → tracked, for `companyOfRepo`
 * An override names a company only: it brings back nothing left out above.
 */
export function trackingOf(
  repo: ListedRepo,
  now: number,
  config: RepoConfig = GITHUB_REPOS,
): Tracking {
  if (config.ignored.some((name) => same(name, repo.name))) return { tracked: false, reason: "ignored" };
  if (repo.isArchived) return { tracked: false, reason: "archived" };
  if (repo.isFork) return { tracked: false, reason: "fork" };
  const pushed = repo.pushedAt === null ? Number.NaN : Date.parse(repo.pushedAt);
  if (!(pushed >= now - config.activeDays * DAY_MS)) return { tracked: false, reason: "quiet" };
  const company = companyOfRepo(repo.org, repo.name, config);
  // An organisation outside the map is never asked for, so this is not reached
  // in a run; if it were, the repository is nobody's and is left out.
  return company === null ? { tracked: false, reason: "ignored" } : { tracked: true, company };
}
