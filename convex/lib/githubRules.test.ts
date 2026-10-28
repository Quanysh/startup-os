import { describe, expect, test } from "vitest";
import { SOURCES, feedOf } from "../connectors/manifest";
import { companyOfMetric, sourceServes } from "./company";
import { isRecordsEnvelope, parseIngestEnvelope } from "./ingestSchema";
import { METRICS, SOURCE_IDS, getMetric, metricScopes, staleAfter } from "./metricRegistry";
import { SHARED_KINDS, SHARED_KINDS_OF, SHARED_SOURCES } from "./mirrorRules";
import { GITHUB_FINISHED_WEEK_KEYS, pushedSnapshotProblems } from "./pushRules";
import {
  SHARED_CAPS,
  parseSharedRecords,
  sharedKeyOf,
  sharedRefusal,
  type SharedRecord,
} from "./sharedRecords";
import { validateSnapshots, type SnapshotInput } from "./snapshotRules";

// GitHub's engineering signals: what the registry, the push rules and the
// shared `repo` list accept. Repository names here are made up.

// A Wednesday. The week in progress began on Monday 2026-10-12.
const NOW = Date.UTC(2026, 9, 14, 6);
const WEEKLY = ["prs_merged", "prs_opened"];
const LEVELS = ["prs_open", "prs_stuck", "repos_failing", "repos_tracked"];

const week = (key: string, scope: string, periodStart: string, value = 3): SnapshotInput => ({
  key,
  scope,
  period: "week",
  periodStart,
  value,
});

describe("the registry: GitHub's metrics", () => {
  test("github is a source, wired up as a pushed one that serves both companies", () => {
    expect(SOURCE_IDS).toContain("github");
    const source = SOURCES.find((s) => s.id === "github")!;
    expect(source).toMatchObject({
      kind: "ingest",
      short: "GitHub",
      named: "GitHub",
      requiredEnv: ["INGEST_TOKEN_GITHUB"],
    });
    // No flag that would let its token carry clinics, the plan or tasks.
    expect([source.customers, source.plan, source.tasks, source.pushable]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(source.description).toMatch(/never code/i);
    expect(sourceServes("us", "github")).toBe(true);
    expect(sourceServes("kz", "github")).toBe(true);
    // Nothing set: not configured, and so no token is honoured.
    expect(feedOf(source)).toBeNull();
  });

  test.each([...WEEKLY, ...LEVELS])("%s: a whole weekly count on the product page, per company", (key) => {
    const metric = getMetric(key)!;
    expect(metric).toMatchObject({
      section: "product",
      unit: "count",
      grain: "week",
      integer: true,
      min: 0,
      sources: { us: "github", kz: "github" },
    });
    expect(metricScopes(metric)).toEqual(["us", "kz"]);
    expect(companyOfMetric(key, "us")).toBe("us");
    expect(companyOfMetric(key, "kz")).toBe("kz");
    // A typo could be believed without a ceiling.
    expect(metric.max).toBeGreaterThan(0);
    // The attention list is told by its own function, never by "missing or stale".
    expect([metric.home, metric.watch, metric.sparse]).toEqual([undefined, undefined, undefined]);
  });

  test("a week's own count is due once the week ends; a level is read daily", () => {
    for (const key of WEEKLY) expect(staleAfter(getMetric(key)!, "us"), key).toBe(10);
    for (const key of LEVELS) expect(staleAfter(getMetric(key)!, "kz"), key).toBe(4);
    expect(GITHUB_FINISHED_WEEK_KEYS).toEqual(WEEKLY);
  });

  test("which direction is good", () => {
    const better = (key: string) => getMetric(key)!.better;
    expect(better("prs_merged")).toBe("up");
    expect(better("prs_stuck")).toBe("down");
    expect(better("repos_failing")).toBe("down");
  });

  test("GitHub owns nothing else, and nobody else owns these", () => {
    const owned = METRICS.filter((m) => Object.values(m.sources).includes("github")).map((m) => m.key);
    expect(owned.sort()).toEqual([...WEEKLY, ...LEVELS].sort());
    expect(validateSnapshots("apollo", [week("prs_merged", "us", "2026-10-05")])).toHaveLength(1);
    expect(validateSnapshots("github", [week("apollo_contacts", "us", "2026-10-12")])).toHaveLength(1);
    expect(validateSnapshots("github", [week("prs_merged", "us", "2026-10-05")])).toEqual([]);
  });

  test("plausibility: no half a pull request, no negative, no count past the ceiling", () => {
    const issues = (value: number, key = "prs_stuck") =>
      validateSnapshots("github", [week(key, "us", "2026-10-12", value)], undefined, { now: NOW });
    expect(issues(0)).toEqual([]);
    expect(issues(1.5)).toHaveLength(1);
    expect(issues(-1)).toHaveLength(1);
    expect(issues(10_000_000)).toHaveLength(1);
    expect(issues(301, "repos_tracked")).toHaveLength(1);
    expect(issues(301, "repos_failing")).toHaveLength(1);
  });

  test("a count has no scope but the two companies", () => {
    expect(validateSnapshots("github", [week("prs_merged", "company", "2026-10-05")])).toHaveLength(1);
    expect(validateSnapshots("github", [week("prs_merged", "startup_insights", "2026-10-05")])).toHaveLength(1);
  });
});

describe("pushedSnapshotProblems: GitHub", () => {
  test("a finished week's pull request counts are accepted, for either company", () => {
    const rows = [week("prs_merged", "us", "2026-10-05"), week("prs_opened", "kz", "2026-07-13")];
    expect(pushedSnapshotProblems("github", rows, NOW)).toEqual([]);
  });

  test.each(WEEKLY)("%s for the week in progress is refused", (key) => {
    expect(pushedSnapshotProblems("github", [week(key, "us", "2026-10-12")], NOW)).toEqual([
      {
        index: 0,
        field: "periodStart",
        message: "This week has not ended. Only finished weeks are stored.",
      },
    ]);
  });

  test.each(LEVELS)("%s is a level: the week it is read in, and no other", (key) => {
    expect(pushedSnapshotProblems("github", [week(key, "kz", "2026-10-12")], NOW)).toEqual([]);
    expect(pushedSnapshotProblems("github", [week(key, "kz", "2026-10-05")], NOW)).toEqual([
      { index: 0, field: "periodStart", message: "A level belongs to the week it is read in." },
    ]);
  });

  test("a level read just before Monday and sent just after is still last week's", () => {
    const monday = Date.UTC(2026, 9, 12, 0, 30);
    expect(pushedSnapshotProblems("github", [week("prs_open", "us", "2026-10-05")], monday)).toEqual([]);
  });

  test("the rule is GitHub's alone: the same keys from another source get none here", () => {
    expect(pushedSnapshotProblems("vercel", [week("prs_merged", "us", "2026-10-12")], NOW)).toEqual([]);
  });
});

// ── The shared `repo` list ──────────────────────────────────────────────────

const options = { empty: false, now: NOW };
const repo = (name: string, over: Record<string, unknown> = {}) => ({
  repoId: `Made-Up-Org/${name}`,
  org: "Made-Up-Org",
  name,
  company: "us",
  mergedLastWeek: 4,
  open: 3,
  stuck: 1,
  main: "passing",
  pushedAt: "2026-10-13",
  ...over,
});
const issuesOf = (result: ReturnType<typeof parseSharedRecords>) => (result.ok ? [] : result.issues);
const parse = (rows: unknown[]) => parseSharedRecords("github", "repo", rows, options);

describe("which source carries which list", () => {
  test("GitHub's two lists are `repo` and `pull_request`; Apollo's two are as they were", () => {
    expect(SHARED_SOURCES).toEqual(["apollo", "github"]);
    expect(SHARED_KINDS).toEqual(["sequence", "stage_count", "repo", "pull_request"]);
    expect(SHARED_KINDS_OF).toEqual({
      apollo: ["sequence", "stage_count"],
      github: ["repo", "pull_request"],
    });
  });

  test("a list sent under the other source is refused before a row is read", () => {
    expect(issuesOf(parseSharedRecords("apollo", "repo", [repo("alpha")], options))).toEqual([
      { path: "kind", message: "This source has no list of that kind." },
    ]);
    for (const kind of ["sequence", "stage_count"] as const) {
      expect(issuesOf(parseSharedRecords("github", kind, [{ any: "row" }], options)), kind).toEqual([
        { path: "kind", message: "This source has no list of that kind." },
      ]);
    }
  });
});

describe("parseSharedRecords: repositories", () => {
  test("a repository becomes the stored record, field for field", () => {
    expect(parse([repo("alpha")])).toEqual({
      ok: true,
      rows: [
        {
          kind: "repo",
          repoId: "Made-Up-Org/alpha",
          org: "Made-Up-Org",
          name: "alpha",
          company: "us",
          mergedLastWeek: 4,
          open: 3,
          stuck: 1,
          main: "passing",
          pushedAt: "2026-10-13",
        },
      ],
    });
  });

  test.each(["passing", "failing", "pending", "none"])("main may be %s", (main) => {
    expect(parse([repo("alpha", { main })]).ok).toBe(true);
  });

  test.each([
    ["title", "SECRET pull request title"],
    ["author", "SECRET person"],
    ["login", "secret-login"],
    ["branch", "SECRET-branch"],
    ["defaultBranch", "main"],
    ["additions", 120],
    ["commits", 9],
    ["reviewComments", 4],
    ["url", "https://example.test/SECRET"],
  ])("strict: there is no field for %s, and what was sent is not echoed", (field, value) => {
    const result = parse([repo("alpha", { [field]: value })]);
    expect(issuesOf(result)).toEqual([
      { path: "records.0", message: "has a field the OS does not accept" },
    ]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain(field);
  });

  test.each([
    [{ company: "company" }, "records.0.company", "is not one of the allowed values"],
    [{ main: "SUCCESS" }, "records.0.main", "is not one of the allowed values"],
    [{ open: -1 }, "records.0.open", "is empty or too small"],
    [{ open: 2.5, stuck: 0 }, "records.0.open", "is missing or of the wrong type"],
    [{ mergedLastWeek: 100_001 }, "records.0.mergedLastWeek", "is too long or too large"],
    [{ stuck: 4 }, "records.0.stuck", "is more than open"],
    [{ pushedAt: "2026-02-30" }, "records.0.pushedAt", "is not a real date (YYYY-MM-DD)"],
    [{ pushedAt: "2026-10-13T10:00:00Z" }, "records.0.pushedAt", "is not a real date (YYYY-MM-DD)"],
    [{ pushedAt: "2026-10-17" }, "records.0.pushedAt", "is in the future"],
    [{ name: "has space", repoId: "Made-Up-Org/has space" }, "records.0.repoId", "is not in the expected form"],
    [{ org: "Other-Org" }, "records.0.repoId", "is not the organisation and the name"],
    [{ name: "x".repeat(101), repoId: `Made-Up-Org/${"x".repeat(101)}` }, "records.0.name", "is too long or too large"],
    [{ name: "ünïcode", repoId: "Made-Up-Org/ünïcode" }, "records.0.repoId", "is not in the expected form"],
  ])("a row that could not be true: %j", (over, path, message) => {
    expect(issuesOf(parse([repo("alpha", over)]))).toContainEqual({ path, message });
  });

  test("the day a repository was pushed to may be a day ahead of the server's", () => {
    expect(parse([repo("alpha", { pushedAt: "2026-10-15" })]).ok).toBe(true);
  });

  test("the same repository twice refuses the push, however it is cased", () => {
    const again = repo("ALPHA", { repoId: "made-up-org/ALPHA", org: "made-up-org" });
    expect(issuesOf(parse([repo("alpha"), again]))).toEqual([
      { path: "records.1.repoId", message: "repeats the id of an earlier record" },
    ]);
  });

  test("at most 300 repositories", () => {
    expect(SHARED_CAPS.repo).toBe(300);
    const rows = (n: number) => Array.from({ length: n }, (_, i) => repo(`r${i}`));
    expect(parse(rows(300)).ok).toBe(true);
    expect(issuesOf(parse(rows(301)))).toEqual([
      { path: "records", message: "At most 300 records of this kind in one push." },
    ]);
  });

  test("an empty list is refused, with `empty` or without: nothing there is a failed read", () => {
    expect(issuesOf(parse([])).map((i) => i.path)).toEqual(["records"]);
    expect(
      issuesOf(parseSharedRecords("github", "repo", [], { empty: true, now: NOW })).map((i) => i.path),
    ).toEqual(["empty"]);
  });

  test("rows of Apollo's lists are refused by row", () => {
    const result = parse([{ entity: "contact", stage: "Cold", count: 1 }]);
    expect(result.ok).toBe(false);
    expect(issuesOf(result).every((i) => i.path.startsWith("records.0"))).toBe(true);
  });
});

describe("the repo list's key and the write's own guard", () => {
  const stored = (name: string, over: Partial<Extract<SharedRecord, { kind: "repo" }>> = {}) =>
    ({ kind: "repo", ...repo(name), ...over }) as SharedRecord;

  test("keyed by organisation and name, ordered by the last push", () => {
    expect(sharedKeyOf(stored("Alpha"))).toEqual({
      externalId: "repo:made-up-org/alpha",
      sortAt: Date.UTC(2026, 9, 13),
    });
  });

  test("what the parser produces passes", () => {
    const parsed = parse([repo("alpha"), repo("beta", { company: "kz", main: "none" })]);
    expect(parsed.ok && sharedRefusal("repo", parsed.rows)).toBeNull();
  });

  test("an empty batch, a row of another kind, a repeat and an impossible row are refused", () => {
    expect(sharedRefusal("repo", [])).toBe("An empty list is never written for this source.");
    const sequenceRow = {
      kind: "sequence",
      sequenceId: "s1",
      name: "x",
      active: true,
      archived: false,
      steps: 1,
      createdAt: "2026-03-13",
      delivered: 0,
      opened: 0,
      replied: 0,
      bounced: 0,
      unsubscribed: 0,
    } as SharedRecord;
    const words = (bad: number, of: number) =>
      `${bad} of ${of} records broke the size and shape rules, so nothing was written.`;
    expect(sharedRefusal("repo", [sequenceRow])).toBe(words(1, 1));
    expect(sharedRefusal("sequence", [stored("alpha")])).toBe(words(1, 1));
    expect(sharedRefusal("repo", [stored("alpha"), stored("alpha")])).toBe(words(1, 2));
    expect(sharedRefusal("repo", [stored("alpha", { stuck: 9 })])).toBe(words(1, 1));
    expect(sharedRefusal("repo", [stored("alpha", { open: 1.5 })])).toBe(words(1, 1));
    expect(sharedRefusal("repo", [stored("alpha", { pushedAt: "yesterday" })])).toBe(words(1, 1));
    expect(sharedRefusal("repo", [stored("alpha", { repoId: "Elsewhere/alpha" })])).toBe(words(1, 1));
    expect(sharedRefusal("repo", [stored("alpha", { name: "a b", repoId: "Made-Up-Org/a b" })])).toBe(
      words(1, 1),
    );
  });
});

describe("parseIngestEnvelope: GitHub's list", () => {
  const github = {
    version: 1,
    source: "github",
    batchId: "github-2026-10-14",
    observedAt: "2026-10-14T06:00:00Z",
  };
  const apollo = { ...github, source: "apollo", batchId: "apollo-2026-10-14" };
  const issues = (raw: unknown) => {
    const result = parseIngestEnvelope(raw);
    return result.ok ? [] : result.issues;
  };

  test("GitHub's records say they are the repo list", () => {
    const result = parseIngestEnvelope({ ...github, kind: "repo", records: [{ any: "row" }] });
    expect(result.ok).toBe(true);
    if (result.ok && isRecordsEnvelope(result.envelope)) expect(result.envelope.kind).toBe("repo");
  });

  test("without a kind they are refused, in words that name GitHub's two lists", () => {
    expect(issues({ ...github, records: [{}] })).toEqual([
      { path: "kind", message: 'Say which list this is: "kind" is "repo" or "pull_request".' },
    ]);
  });

  test("Apollo is still asked for one of its own two", () => {
    expect(issues({ ...apollo, records: [{}] })).toEqual([
      { path: "kind", message: 'Say which list this is: "kind" is "sequence" or "stage_count".' },
    ]);
  });

  test("a list of the other source's kind is refused by the envelope", () => {
    const WORDS = "This source has no list of that kind.";
    expect(issues({ ...github, kind: "sequence", records: [{}] })).toEqual([{ path: "kind", message: WORDS }]);
    expect(issues({ ...github, kind: "stage_count", records: [{}] })).toEqual([
      { path: "kind", message: WORDS },
    ]);
    expect(issues({ ...apollo, kind: "repo", records: [{}] })).toEqual([{ path: "kind", message: WORDS }]);
  });

  test("one payload per envelope: the list beside numbers is refused", () => {
    const snapshot = { key: "prs_open", scope: "us", period: "week", periodStart: "2026-10-12", value: 1 };
    expect(
      issues({ ...github, kind: "repo", records: [{}], snapshots: [snapshot] }).map((i) => i.path),
    ).toEqual(["snapshots"]);
    expect(issues({ ...github, kind: "repo", snapshots: [snapshot] })).toEqual([
      { path: "kind", message: "kind belongs to a records push." },
    ]);
  });
});
