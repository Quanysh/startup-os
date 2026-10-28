import { describe, expect, test, vi } from "vitest";
import { parseIngestEnvelope } from "../convex/lib/ingestSchema";
import {
  CLOSED_LISTED_DAYS,
  CLOSED_PULLS_QUERY,
  LIST_BYTES,
  OPEN_PULLS_QUERY,
  PULLS_QUERY,
  REPOS_QUERY,
  STUCK_AFTER_DAYS,
  USAGE,
  WEEKS,
  buildEnvelopes,
  decisionOf,
  figuresOf,
  gather,
  isStuck,
  limitPulls,
  mainOf,
  run,
  weekOf,
  type Gh,
  type ListedPull,
  type Pull,
} from "./githubGather";
import { parseSharedRecords } from "../convex/lib/sharedRecords";
import { GITHUB_REPOS } from "./githubRepos";

// Everything here is a made-up GitHub: no test runs `gh` or reaches a
// network. What the script must never print (a pull request's title, a
// person's login or name) and never send at all (a description, a branch) is
// in the fake answers, carrying the word SECRET, so one assertion proves it
// never leaves. Titles and people do travel, in the third envelope only.

// A Wednesday. The week in progress began on Monday 2026-10-12; the last
// finished week on Monday 2026-10-05.
const NOW = new Date("2026-10-14T06:00:00Z");
const NOW_MS = NOW.getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW_MS - ms).toISOString();
const TOKEN = "fake-github-token-0123456789abcdefghijklmnopqrstuvwxyz";
const URL = "https://fake-otter-123.convex.site/ingest/v1";
const ENV = { STARTUP_OS_INGEST_URL: URL, INGEST_TOKEN_GITHUB: TOKEN };
const CONFIRMED = '{"ok":true,"inserted":2,"updated":0,"unchanged":0}';

// ── A fake GitHub ───────────────────────────────────────────────────────────

type FakePull = {
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft?: boolean;
  createdAt: string;
  mergedAt?: string | null;
  bot?: boolean;
  /** No author at all: a deleted account. */
  ghost?: boolean;
  reviews?: (string | null)[];
  // What only the list asks for. A number is its place in the repository unless given.
  number?: number;
  title?: string;
  login?: string;
  name?: string | null;
  updatedAt?: string;
  closedAt?: string | null;
  decision?: string | null;
  /** The reviewers' latest opinions (`latestOpinionatedReviews`). */
  opinions?: string[];
  /** Requested reviewers: a login for a person, null for a team. */
  requested?: (string | null)[];
  /** How many are requested in all, where more than the five that are named. */
  requestedTotal?: number;
  /** The head commit's rollup state; undefined for a commit with no checks. */
  checks?: string;
};
type FakeRepo = {
  name: string;
  isArchived?: boolean;
  isFork?: boolean;
  pushedAt?: string | null;
  /** `statusCheckRollup.state`, null for a commit with no checks, undefined for no default branch. */
  rollup?: string | null;
  pulls?: FakePull[];
};
type World = Record<string, FakeRepo[]>;

const pull = (over: Partial<FakePull> = {}): FakePull => ({
  state: "OPEN",
  createdAt: ago(DAY),
  ...over,
});
const merged = (mergedAt: string, createdAt = mergedAt): FakePull => ({
  state: "MERGED",
  createdAt,
  mergedAt,
});

const pullNode = (p: FakePull) => ({
  state: p.state,
  isDraft: p.isDraft ?? false,
  createdAt: p.createdAt,
  mergedAt: p.mergedAt ?? null,
  author: p.ghost ? null : { __typename: p.bot ? "Bot" : "User", login: "SECRET-login" },
  reviews: { nodes: (p.reviews ?? []).map((submittedAt) => ({ submittedAt })) },
  // What the real API would never be asked for. Here to prove it is dropped.
  title: "SECRET pull request title",
  headRefName: "SECRET-branch",
});
const closedAtOf = (p: FakePull) =>
  p.closedAt !== undefined ? p.closedAt : p.state === "OPEN" ? null : (p.mergedAt ?? p.createdAt);
const updatedAtOf = (p: FakePull) =>
  p.updatedAt ?? [p.createdAt, p.mergedAt, closedAtOf(p), ...(p.reviews ?? [])].filter((v): v is string => !!v).sort().at(-1)!;
/** A pull request as the list's queries are answered, with what they never ask for beside it. */
const listedNode = (p: FakePull, index: number) => ({
  number: p.number ?? index + 1,
  title: p.title ?? `SECRET title ${index + 1}`,
  state: p.state,
  isDraft: p.isDraft ?? false,
  createdAt: p.createdAt,
  updatedAt: updatedAtOf(p),
  mergedAt: p.mergedAt ?? null,
  closedAt: closedAtOf(p),
  reviewDecision: p.decision ?? null,
  author: p.ghost
    ? null
    : p.bot
      ? { __typename: "Bot", login: "SECRET-bot" }
      : { __typename: "User", login: p.login ?? "SECRET-login", name: p.name === undefined ? "SECRET Name" : p.name },
  reviews: { nodes: (p.reviews ?? []).map((submittedAt) => ({ submittedAt })) },
  latestOpinionatedReviews: { nodes: (p.opinions ?? []).map((state) => ({ state })) },
  reviewRequests: {
    totalCount: p.requestedTotal ?? (p.requested ?? []).length,
    nodes: (p.requested ?? []).map((login) => ({
      requestedReviewer: login === null ? { __typename: "Team" } : { __typename: "User", login },
    })),
  },
  commits: {
    nodes: [{ commit: { statusCheckRollup: p.checks === undefined ? null : { state: p.checks }, message: "SECRET commit message" } }],
  },
  // What the real API would never be asked for. Here to prove it is dropped.
  body: "SECRET description",
  headRefName: "SECRET-branch",
  url: "https://example.test/SECRET",
});

const repoNode = (r: FakeRepo) => ({
  name: r.name,
  isArchived: r.isArchived ?? false,
  isFork: r.isFork ?? false,
  pushedAt: r.pushedAt === undefined ? ago(DAY) : r.pushedAt,
  defaultBranchRef:
    r.rollup === undefined
      ? null
      : { name: "SECRET-branch", target: { statusCheckRollup: r.rollup === null ? null : { state: r.rollup } } },
  description: "SECRET description",
});

type Call = { query: string; vars: Record<string, string>; args: readonly string[] };

/**
 * `gh api graphql` over a made-up world, two rows to a page so every list is
 * paged. `fail` answers a call by its number (1-based) with a failure, or
 * with other text in place of the JSON.
 */
function fakeGh(world: World, fail: Record<number, "exit" | string> = {}) {
  const calls: Call[] = [];
  const page = <T,>(rows: T[], after: string | undefined) => {
    const start = after === undefined ? 0 : Number(after.replace("cursor-", ""));
    const end = start + 2;
    return {
      pageInfo: { hasNextPage: end < rows.length, endCursor: end < rows.length ? `cursor-${end}` : null },
      nodes: rows.slice(start, end),
    };
  };
  const gh: Gh = vi.fn(async (args: readonly string[]) => {
    const vars: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "-f") {
        const [key, ...rest] = args[i + 1]!.split("=");
        vars[key!] = rest.join("=");
      }
    }
    const query = vars.query ?? "";
    calls.push({ query, vars, args });
    const failure = fail[calls.length];
    if (failure === "exit") return { ok: false as const };
    if (failure !== undefined) return { ok: true as const, stdout: failure };
    if (query === REPOS_QUERY) {
      const repos = world[vars.org!];
      const body =
        repos === undefined
          ? { data: { organization: null } }
          : { data: { organization: { repositories: page(repos.map(repoNode), vars.after) } } };
      return { ok: true as const, stdout: JSON.stringify(body) };
    }
    if (query === PULLS_QUERY) {
      const repo = world[vars.owner!]?.find((r) => r.name === vars.name);
      return {
        ok: true as const,
        stdout: JSON.stringify({
          data: {
            repository: { pullRequests: page((repo?.pulls ?? []).map(pullNode), vars.after) },
          },
        }),
      };
    }
    if (query === OPEN_PULLS_QUERY || query === CLOSED_PULLS_QUERY) {
      const repo = world[vars.owner!]?.find((r) => r.name === vars.name);
      const all = (repo?.pulls ?? []).map(listedNode);
      const rows =
        query === OPEN_PULLS_QUERY
          ? all.filter((n) => n.state === "OPEN").sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          : all.filter((n) => n.state !== "OPEN").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return {
        ok: true as const,
        stdout: JSON.stringify({ data: { repository: { pullRequests: page(rows, vars.after) } } }),
      };
    }
    return { ok: false as const };
  });
  return { gh, calls };
}

// Two made-up organisations (the made-up deployment's, convex/lib/deployment.kit.ts). The first company's repositories live in both.
const WORLD: World = {
  "Made-Up-Org": [
    {
      name: "first-search",
      rollup: "SUCCESS",
      pulls: [
        merged("2026-10-06T10:00:00Z"),
        merged("2026-10-11T23:59:59Z", "2026-09-30T08:00:00Z"),
        merged("2026-09-29T10:00:00Z"),
        // Merged this week: in no finished week.
        merged("2026-10-12T00:00:00Z", "2026-10-09T08:00:00Z"),
        // Open, waiting four days: stuck.
        pull({ createdAt: ago(4 * DAY) }),
        // Open, a draft: counted as open, never as stuck.
        pull({ createdAt: ago(30 * DAY), isDraft: true }),
        // A bot's: in no count at all.
        pull({ createdAt: ago(20 * DAY), bot: true }),
        { state: "MERGED", createdAt: "2026-10-06T09:00:00Z", mergedAt: "2026-10-06T09:05:00Z", bot: true },
      ],
    },
    { name: "first-os", rollup: "FAILURE", pulls: [pull({ createdAt: ago(2 * DAY) })] },
    { name: "demo-repository", rollup: "FAILURE", pulls: [pull({ createdAt: ago(40 * DAY) })] },
    { name: "first-old", isArchived: true, rollup: "FAILURE" },
    { name: "first-quiet", pushedAt: ago(200 * DAY), rollup: "FAILURE" },
  ],
  "Second-Org": [
    {
      name: "second-app",
      rollup: "ERROR",
      pulls: [
        merged("2026-10-07T12:00:00Z"),
        // Closed without merging: opened, never merged.
        { state: "CLOSED", createdAt: "2026-10-08T12:00:00Z", mergedAt: null },
        // Reviewed yesterday: waiting on its author, not stuck.
        pull({ createdAt: ago(10 * DAY), reviews: [ago(9 * DAY), ago(DAY)] }),
      ],
    },
    { name: "vertical-app", rollup: "PENDING", pulls: [merged("2026-10-05T00:00:00Z")] },
    { name: "pacs-viewer", rollup: null },
    { name: "ohif-upstream", isFork: true },
    { name: "telegram-bot" },
  ],
};

function setup(options: { world?: World; fail?: Record<number, "exit" | string>; reply?: () => Promise<Response> } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const { gh, calls } = fakeGh(options.world ?? WORLD, options.fail);
  const fetchMock = vi.fn(options.reply ?? (async () => new Response(CONFIRMED, { status: 200 })));
  const deps = {
    gh,
    fetch: fetchMock as unknown as typeof fetch,
    print: (line: string) => void out.push(line),
    printError: (line: string) => void err.push(line),
    now: () => NOW,
  };
  const sent = () =>
    fetchMock.mock.calls.map(
      (call) => JSON.parse((call as unknown as [string, { body: string }])[1].body) as Record<string, unknown>,
    );
  return { deps, gh, calls, fetchMock, out, err, sent, printed: () => [...out, ...err].join("\n") };
}

// ── The pure rules ──────────────────────────────────────────────────────────

const human = (over: Partial<Pull> = {}): Pull => ({
  state: "OPEN",
  isDraft: false,
  createdAt: NOW_MS - DAY,
  mergedAt: null,
  bot: false,
  lastReviewAt: null,
  ...over,
});

describe("weeks", () => {
  test("thirteen finished weeks, oldest first, the week in progress never among them", () => {
    expect(WEEKS).toBe(13);
    const f = figuresOf([], NOW_MS);
    expect(Object.keys(f.merged)).toHaveLength(13);
    expect(Object.keys(f.merged)[0]).toBe("2026-07-13");
    expect(Object.keys(f.merged).at(-1)).toBe("2026-10-05");
    expect(Object.keys(f.opened)).toEqual(Object.keys(f.merged));
  });

  test("a week starts on Monday at 00:00 UTC", () => {
    expect(weekOf(Date.parse("2026-10-11T23:59:59Z"))).toBe("2026-10-05");
    expect(weekOf(Date.parse("2026-10-12T00:00:00Z"))).toBe("2026-10-12");
    // Sunday evening in New York is already Monday in UTC.
    expect(weekOf(Date.parse("2026-10-04T20:30:00-04:00"))).toBe("2026-10-05");
  });

  test("merged is counted by the merge, opened by the creation, each in its own week", () => {
    const f = figuresOf(
      [
        human({ state: "MERGED", createdAt: Date.parse("2026-09-22T10:00:00Z"), mergedAt: Date.parse("2026-10-06T10:00:00Z") }),
        human({ state: "MERGED", createdAt: Date.parse("2026-10-06T10:00:00Z"), mergedAt: Date.parse("2026-10-06T11:00:00Z") }),
        human({ state: "CLOSED", createdAt: Date.parse("2026-10-07T10:00:00Z") }),
      ],
      NOW_MS,
    );
    expect(f.merged["2026-10-05"]).toBe(2);
    expect(f.opened["2026-10-05"]).toBe(2);
    expect(f.opened["2026-09-21"]).toBe(1);
    expect(f.merged["2026-09-21"]).toBe(0);
    expect(f.mergedLastWeek).toBe(2);
  });

  test("what happened in the week in progress, or before the thirteen, is in no week", () => {
    const f = figuresOf(
      [
        human({ state: "MERGED", createdAt: Date.parse("2026-10-12T01:00:00Z"), mergedAt: Date.parse("2026-10-13T01:00:00Z") }),
        human({ state: "MERGED", createdAt: Date.parse("2026-07-01T01:00:00Z"), mergedAt: Date.parse("2026-07-12T23:00:00Z") }),
      ],
      NOW_MS,
    );
    expect(Object.values(f.merged).reduce((a, b) => a + b, 0)).toBe(0);
    expect(Object.values(f.opened).reduce((a, b) => a + b, 0)).toBe(0);
    expect(f.mergedLastWeek).toBe(0);
  });

  test("a pull request closed without merging is never merged, whatever date it carries", () => {
    const f = figuresOf(
      [human({ state: "CLOSED", createdAt: Date.parse("2026-10-06T10:00:00Z"), mergedAt: Date.parse("2026-10-06T11:00:00Z") })],
      NOW_MS,
    );
    expect(f.merged["2026-10-05"]).toBe(0);
  });
});

describe("the stuck rule", () => {
  test("three days is the limit", () => {
    expect(STUCK_AFTER_DAYS).toBe(3);
  });

  test("open, not a draft, unreviewed for more than three full days: stuck", () => {
    expect(isStuck(human({ createdAt: NOW_MS - 3 * DAY - 1000 }), NOW_MS)).toBe(true);
    expect(isStuck(human({ createdAt: NOW_MS - 30 * DAY }), NOW_MS)).toBe(true);
  });

  test("exactly three days is not more than three days", () => {
    expect(isStuck(human({ createdAt: NOW_MS - 3 * DAY }), NOW_MS)).toBe(false);
    expect(isStuck(human({ createdAt: NOW_MS - 3 * DAY + 1000 }), NOW_MS)).toBe(false);
  });

  test("a draft is never stuck, however old", () => {
    expect(isStuck(human({ createdAt: NOW_MS - 60 * DAY, isDraft: true }), NOW_MS)).toBe(false);
  });

  test("reviewed in the last three days: not stuck, however old the pull request", () => {
    const old = { createdAt: NOW_MS - 20 * DAY };
    expect(isStuck(human({ ...old, lastReviewAt: NOW_MS - DAY }), NOW_MS)).toBe(false);
    expect(isStuck(human({ ...old, lastReviewAt: NOW_MS - 3 * DAY }), NOW_MS)).toBe(false);
  });

  test("reviewed long ago and nothing since: stuck again, counted from that review", () => {
    const old = { createdAt: NOW_MS - 20 * DAY };
    expect(isStuck(human({ ...old, lastReviewAt: NOW_MS - 3 * DAY - 1000 }), NOW_MS)).toBe(true);
    expect(isStuck(human({ ...old, lastReviewAt: NOW_MS - 15 * DAY }), NOW_MS)).toBe(true);
  });

  test("a merged or closed pull request is not waiting on anyone", () => {
    const old = { createdAt: NOW_MS - 20 * DAY };
    expect(isStuck(human({ ...old, state: "MERGED", mergedAt: NOW_MS - 10 * DAY }), NOW_MS)).toBe(false);
    expect(isStuck(human({ ...old, state: "CLOSED" }), NOW_MS)).toBe(false);
  });

  test("a bot's pull request is in no count: not open, stuck, opened or merged", () => {
    const f = figuresOf(
      [
        human({ bot: true, createdAt: NOW_MS - 20 * DAY }),
        human({ bot: true, state: "MERGED", createdAt: Date.parse("2026-10-06T10:00:00Z"), mergedAt: Date.parse("2026-10-06T11:00:00Z") }),
      ],
      NOW_MS,
    );
    expect([f.open, f.stuck, f.mergedLastWeek, f.bots]).toEqual([0, 0, 0, 2]);
    expect(Object.values(f.opened).reduce((a, b) => a + b, 0)).toBe(0);
  });

  test("drafts are counted in open and left out of stuck", () => {
    const f = figuresOf(
      [human({ createdAt: NOW_MS - 9 * DAY, isDraft: true }), human({ createdAt: NOW_MS - 9 * DAY })],
      NOW_MS,
    );
    expect([f.open, f.stuck]).toEqual([2, 1]);
  });
});

describe("the default branch's build", () => {
  test.each([
    ["SUCCESS", "passing"],
    ["FAILURE", "failing"],
    ["ERROR", "failing"],
    ["PENDING", "pending"],
    ["EXPECTED", "pending"],
    [null, "none"],
  ] as const)("%s is %s", (state, main) => {
    expect(mainOf(state)).toBe(main);
  });

  test("a state this script does not know is not guessed at", () => {
    expect(mainOf("SOMETHING_NEW")).toBeNull();
  });
});

// ── Reading GitHub ──────────────────────────────────────────────────────────

describe("gather: what is asked of GitHub", () => {
  test("only `gh api graphql`, with read-only queries and no method or token argument", async () => {
    const h = setup();
    await gather(h.deps, GITHUB_REPOS);
    expect(h.calls.length).toBeGreaterThan(0);
    for (const call of h.calls) {
      expect(call.args.slice(0, 2)).toEqual(["api", "graphql"]);
      expect(call.query.trimStart().startsWith("query")).toBe(true);
      expect(call.query).not.toMatch(/mutation/i);
      // Every variable is passed raw (-f): -F would read a file for a value starting with "@".
      expect(call.args.filter((a) => a.startsWith("-"))).toEqual(
        call.args.filter((a) => a === "-f"),
      );
      expect(call.args.join(" ")).not.toMatch(/token|authorization/i);
    }
  });

  test("the queries ask for states, dates, check results and repository names, and nothing else", () => {
    // No title, body, branch, commit message, size or comment count; no login,
    // name or email of a person. The only `name` is the repository's.
    const forbidden =
      /title|body|headRef|baseRef|message|additions|deletions|changedFiles|commits|comments|login|email|description|url|avatar/i;
    expect(PULLS_QUERY).not.toMatch(forbidden);
    // Past the repository's own name (an argument), nothing named is asked for.
    expect(PULLS_QUERY.slice(PULLS_QUERY.indexOf("pullRequests"))).not.toMatch(/\bname\b/);
    // (`login` appears once, as the argument that names the organisation.)
    expect(REPOS_QUERY.slice(REPOS_QUERY.indexOf("repositories"))).not.toMatch(forbidden);
    expect(REPOS_QUERY.match(/login/g)).toHaveLength(1);
    // The default branch is asked for its commit's checks, never its name.
    expect(REPOS_QUERY).toMatch(/defaultBranchRef\s*\{\s*target/);
    // An author is asked only whether it is a bot.
    expect(PULLS_QUERY).toMatch(/author\s*\{\s*__typename\s*\}/);
  });

  test("each organisation's repositories are paged to the end, then each tracked repository's pull requests", async () => {
    const h = setup();
    const result = await gather(h.deps, GITHUB_REPOS);
    expect(result.ok).toBe(true);
    const repoCalls = h.calls.filter((c) => c.query === REPOS_QUERY);
    // Five repositories each, two to a page: three pages an organisation.
    expect(repoCalls.map((c) => [c.vars.org, c.vars.after])).toEqual([
      ["Made-Up-Org", undefined],
      ["Made-Up-Org", "cursor-2"],
      ["Made-Up-Org", "cursor-4"],
      ["Second-Org", undefined],
      ["Second-Org", "cursor-2"],
      ["Second-Org", "cursor-4"],
    ]);
    const pullCalls = h.calls.filter((c) => c.query === PULLS_QUERY);
    // Only tracked repositories are asked about: no ignored, archived, forked or quiet one.
    expect([...new Set(pullCalls.map((c) => `${c.vars.owner}/${c.vars.name}`))]).toEqual([
      "Made-Up-Org/first-search",
      "Made-Up-Org/first-os",
      "Second-Org/second-app",
      "Second-Org/vertical-app",
      "Second-Org/pacs-viewer",
      "Second-Org/telegram-bot",
    ]);
    // first-search has eight pull requests: four pages.
    expect(pullCalls.filter((c) => c.vars.name === "first-search").map((c) => c.vars.after)).toEqual([
      undefined,
      "cursor-2",
      "cursor-4",
      "cursor-6",
    ]);
  });

  test("what it works out for each tracked repository", async () => {
    const h = setup();
    const result = await gather(h.deps, GITHUB_REPOS);
    if (!result.ok) throw new Error(result.problem);
    expect(result.skipped).toEqual({ ignored: 1, archived: 1, fork: 1, quiet: 1 });
    expect(result.listed).toBe(10);
    expect(
      result.repos.map((r) => [r.org, r.name, r.company, r.mergedLastWeek, r.open, r.stuck, r.main]),
    ).toEqual([
      ["Made-Up-Org", "first-search", "us", 2, 2, 1, "passing"],
      ["Made-Up-Org", "first-os", "us", 0, 1, 0, "failing"],
      ["Second-Org", "second-app", "kz", 1, 1, 0, "failing"],
      // vertical-app is the first company's by its name, though it lives in the other organisation.
      ["Second-Org", "vertical-app", "us", 1, 0, 0, "pending"],
      ["Second-Org", "pacs-viewer", "kz", 0, 0, 0, "none"],
      // No default branch at all: no checks either.
      ["Second-Org", "telegram-bot", "kz", 0, 0, 0, "none"],
    ]);
    expect(result.repos.reduce((sum, r) => sum + r.bots, 0)).toBe(2);
  });

  test("a pending review (no submission time) is no review; a deleted author is a person", async () => {
    const world: World = {
      "Made-Up-Org": [
        {
          name: "first-search",
          pulls: [
            pull({ createdAt: ago(10 * DAY), reviews: [ago(8 * DAY), null] }),
            pull({ createdAt: ago(10 * DAY), ghost: true }),
          ],
        },
      ],
      "Second-Org": [{ name: "second-app" }],
    };
    const result = await gather(setup({ world }).deps, GITHUB_REPOS);
    if (!result.ok) throw new Error(result.problem);
    expect([result.repos[0]!.open, result.repos[0]!.stuck]).toEqual([2, 2]);
  });
});

describe("gather: all or nothing", () => {
  // The repositories, each one's pull requests for the counts, then each one's
  // open and lately closed ones for the list.
  const CALLS = 6 + 4 + 1 + 2 + 1 + 1 + 1 + (2 + 3) + 2 + 2 + 2 + 2 + 2;

  test("the made-up world takes this many calls", async () => {
    const h = setup();
    await gather(h.deps, GITHUB_REPOS);
    expect(h.calls).toHaveLength(CALLS);
  });

  test.each(Array.from({ length: CALLS }, (_, i) => i + 1))(
    "call %i failing means nothing is sent and the run exits 1, in fixed words",
    async (n) => {
      const h = setup({ fail: { [n]: "exit" } });
      expect(await run(["--send"], ENV, h.deps)).toBe(1);
      expect(h.fetchMock).not.toHaveBeenCalled();
      expect(h.out).toEqual([]);
      expect(h.err).toEqual([
        "GitHub could not be read: the gh command failed or timed out. Nothing was sent.",
      ]);
      // It stopped there: no further question was put to GitHub.
      expect(h.calls).toHaveLength(n);
    },
  );

  test.each([
    ["not JSON", "<html>SECRET sign-in page</html>"],
    ["an errors list", JSON.stringify({ errors: [{ message: "SECRET rate limit" }], data: null })],
    [
      // GraphQL can answer in part: a page that looks whole, beside an error.
      "a whole-looking page beside an error",
      JSON.stringify({
        errors: [{ message: "SECRET partial failure" }],
        data: {
          organization: {
            repositories: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          },
        },
      }),
    ],
    ["a list with no page information", JSON.stringify({ data: { organization: { repositories: { nodes: [] } } } })],
    ["a truncated answer", '{"data":{"organization":{"repositories":{"pageInfo":'],
  ])("an answer that is %s is refused, and not quoted", async (_what, stdout) => {
    const h = setup({ fail: { 2: stdout } });
    expect(await run(["--send"], ENV, h.deps)).toBe(1);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.err).toEqual(["GitHub's answer was not in the expected shape. Nothing was sent."]);
    expect(h.printed()).not.toContain("SECRET");
  });

  test("a pull request with a date that is not one is refused", async () => {
    const world: World = {
      "Made-Up-Org": [{ name: "first-search", pulls: [pull({ createdAt: "yesterday" })] }],
      "Second-Org": [{ name: "second-app" }],
    };
    const h = setup({ world });
    expect(await run([], ENV, h.deps)).toBe(1);
    expect(h.err).toEqual(["GitHub's answer was not in the expected shape. Nothing was sent."]);
  });

  test("a build state this script does not know is refused, not filed as passing", async () => {
    const world: World = {
      "Made-Up-Org": [{ name: "first-search", rollup: "SOMETHING_NEW" }],
      "Second-Org": [{ name: "second-app" }],
    };
    const h = setup({ world });
    expect(await run([], ENV, h.deps)).toBe(1);
    expect(h.err).toEqual(["GitHub's answer was not in the expected shape. Nothing was sent."]);
  });

  test("an organisation that cannot be seen, or lists nothing, is a failed read", async () => {
    const missing = setup({ world: { "Made-Up-Org": WORLD["Made-Up-Org"]! } });
    expect(await run(["--send"], ENV, missing.deps)).toBe(1);
    expect(missing.err).toEqual(["GitHub's answer was not in the expected shape. Nothing was sent."]);
    expect(missing.fetchMock).not.toHaveBeenCalled();

    const empty = setup({ world: { ...WORLD, "Second-Org": [] } });
    expect(await run(["--send"], ENV, empty.deps)).toBe(1);
    expect(empty.err).toEqual([
      "An organisation listed no repository, which is how a failed read looks. Nothing was sent.",
    ]);
    expect(empty.fetchMock).not.toHaveBeenCalled();
  });

  test("a list that never ends is cut off, and nothing is sent", async () => {
    const endless: Gh = async () => ({
      ok: true,
      stdout: JSON.stringify({
        data: {
          organization: {
            repositories: { pageInfo: { hasNextPage: true, endCursor: "again" }, nodes: [] },
          },
        },
      }),
    });
    const h = setup();
    expect(await run(["--send"], ENV, { ...h.deps, gh: endless })).toBe(1);
    expect(h.err).toEqual(["A list from GitHub did not end. Nothing was sent."]);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  test("no repository tracked at all is a failed read, not thirteen weeks of zeros", async () => {
    const world: World = {
      "Made-Up-Org": [{ name: "first-old", isArchived: true }],
      "Second-Org": [{ name: "ohif-upstream", isFork: true }],
    };
    const h = setup({ world });
    expect(await run(["--send"], ENV, h.deps)).toBe(1);
    expect(h.err).toEqual(["No repository is tracked, which is how a failed read looks. Nothing was sent."]);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

// ── The envelopes ───────────────────────────────────────────────────────────

async function envelopes(world: World = WORLD) {
  const result = await gather(setup({ world }).deps, GITHUB_REPOS);
  if (!result.ok) throw new Error(result.problem);
  return buildEnvelopes(result.repos, NOW);
}
type Row = { key: string; scope: string; period: string; periodStart: string; value: number };

describe("buildEnvelopes", () => {
  test("the numbers: thirteen finished weeks of two counts and four levels, for each company", async () => {
    const { snapshots } = await envelopes();
    expect(snapshots).toMatchObject({
      version: 1,
      source: "github",
      batchId: "github-2026-10-14",
      observedAt: "2026-10-14T06:00:00.000Z",
    });
    const rows = snapshots.snapshots as Row[];
    expect(rows).toHaveLength(2 * (13 * 2 + 4));
    expect(new Set(rows.map((r) => r.period))).toEqual(new Set(["week"]));
    const value = (key: string, scope: string, periodStart: string) =>
      rows.find((r) => r.key === key && r.scope === scope && r.periodStart === periodStart)?.value;

    // The first company: first-search, first-os and vertical-app.
    expect(value("prs_merged", "us", "2026-10-05")).toBe(3);
    expect(value("prs_merged", "us", "2026-09-28")).toBe(1);
    expect(value("prs_merged", "us", "2026-07-13")).toBe(0);
    expect(value("prs_opened", "us", "2026-10-05")).toBe(4);
    expect(value("prs_opened", "us", "2026-09-28")).toBe(2);
    expect(value("prs_open", "us", "2026-10-12")).toBe(3);
    expect(value("prs_stuck", "us", "2026-10-12")).toBe(1);
    expect(value("repos_failing", "us", "2026-10-12")).toBe(1);
    expect(value("repos_tracked", "us", "2026-10-12")).toBe(3);
    // The second: second-app, pacs-viewer and telegram-bot. An errored build is a failing one.
    expect(value("prs_merged", "kz", "2026-10-05")).toBe(1);
    expect(value("prs_opened", "kz", "2026-10-05")).toBe(2);
    expect(value("prs_open", "kz", "2026-10-12")).toBe(1);
    expect(value("prs_stuck", "kz", "2026-10-12")).toBe(0);
    expect(value("repos_failing", "kz", "2026-10-12")).toBe(1);
    expect(value("repos_tracked", "kz", "2026-10-12")).toBe(3);

    // A week's own count never for the week in progress; a level only for it.
    for (const row of rows) {
      const weekly = row.key === "prs_merged" || row.key === "prs_opened";
      expect(row.periodStart === "2026-10-12", `${row.key} ${row.periodStart}`).toBe(!weekly);
    }
  });

  test("the repositories: one row each, the whole allow-list of fields", async () => {
    const { records } = await envelopes();
    expect(records).toMatchObject({ version: 1, source: "github", kind: "repo", batchId: "github-2026-10-14" });
    expect(records.records).toHaveLength(6);
    expect(records.records[0]).toEqual({
      repoId: "Made-Up-Org/first-search",
      org: "Made-Up-Org",
      name: "first-search",
      company: "us",
      mergedLastWeek: 2,
      open: 2,
      stuck: 1,
      main: "passing",
      pushedAt: "2026-10-13",
    });
  });

  test("both pass the endpoint's own schema", async () => {
    const { snapshots, records } = await envelopes();
    expect(parseIngestEnvelope(snapshots)).toMatchObject({ ok: true });
    expect(parseIngestEnvelope(records)).toMatchObject({ ok: true });
  });

  test("nothing about a person, a title or a branch is in either envelope", async () => {
    const { snapshots, records } = await envelopes();
    const text = JSON.stringify([snapshots, records]);
    expect(text).not.toContain("SECRET");
    for (const word of ["author", "login", "user", "assignee", "reviewer", "title", "branch", "ref", "email", "commit"]) {
      expect(text.toLowerCase(), word).not.toContain(`"${word}`);
    }
    // Every key that is sent, by name: a new field has to be added here on purpose.
    const keys = new Set<string>();
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (typeof value === "object" && value !== null) {
        for (const [key, inner] of Object.entries(value)) {
          keys.add(key);
          walk(inner);
        }
      }
    };
    walk([snapshots, records]);
    expect([...keys].sort()).toEqual(
      [
        "version", "source", "batchId", "observedAt", "snapshots", "kind", "records",
        "key", "scope", "period", "periodStart", "value",
        "repoId", "org", "name", "company", "mergedLastWeek", "open", "stuck", "main", "pushedAt",
      ].sort(),
    );
  });

  test("a company with no tracked repository gets no rows: unknown, not zero", async () => {
    const world: World = {
      "Made-Up-Org": [{ name: "first-search", rollup: "SUCCESS", pulls: [merged("2026-10-06T10:00:00Z")] }],
      "Second-Org": [{ name: "ohif-upstream", isFork: true }],
    };
    const { snapshots, records } = await envelopes(world);
    const rows = snapshots.snapshots as Row[];
    expect(new Set(rows.map((r) => r.scope))).toEqual(new Set(["us"]));
    expect(rows).toHaveLength(30);
    expect(records.records).toHaveLength(1);
  });
});

// ── The command ─────────────────────────────────────────────────────────────

const SUMMARY = [
  "Source: github",
  "Repositories listed: 10",
  "Tracked: 6 (ignored 1, archived 1, forks 1, not pushed to in 90 days 1)",
  "Pull requests by bots left out: 2",
  "Startup: 3 repositories, 3 merged last week, 3 open, 1 waiting more than 3 days, 1 with a failing main",
  "Globex: 3 repositories, 1 merged last week, 1 open, 0 waiting more than 3 days, 1 with a failing main",
  "Pull requests listed: 10 (4 open, 5 merged and 1 closed in the last 14 days)",
  "Kind: snapshots",
  "Snapshots: 60",
  "Metric keys: prs_merged, prs_open, prs_opened, prs_stuck, repos_failing, repos_tracked",
  "Kind: records (repo)",
  "Records: 6",
  "Kind: records (pull_request)",
  "Records: 10",
];

describe("run: arguments", () => {
  test.each([[["--sned"]], [["-s"]], [["--send", "--dry-run"]], [["--send", "--force"]], [["file.json"]], [["--send", "extra"]]])(
    "%j prints the usage line, exits 1, and neither reads GitHub nor sends",
    async (argv) => {
      const h = setup();
      expect(await run(argv, ENV, h.deps)).toBe(1);
      expect(h.err).toEqual([USAGE]);
      expect(USAGE).toBe("Usage: pnpm gather:github [--send]");
      expect(h.gh).not.toHaveBeenCalled();
      expect(h.fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("run: printing is the default", () => {
  test.each([[[]], [["--dry-run"]]])("%j prints counts and sends nothing, even with credentials set", async (argv) => {
    const h = setup();
    expect(await run(argv, ENV, h.deps)).toBe(0);
    expect(h.out).toEqual(SUMMARY);
    expect(h.err).toEqual(["Nothing was sent. Add --send to push it."]);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  test("printing needs no credentials at all", async () => {
    const h = setup();
    expect(await run([], {}, h.deps)).toBe(0);
    expect(h.out).toEqual(SUMMARY);
  });

  test("the summary is counts: no repository's name, no title, no login, no token", async () => {
    const h = setup();
    await run([], ENV, h.deps);
    const printed = h.printed();
    expect(printed).not.toContain("SECRET");
    expect(printed).not.toContain(TOKEN);
    for (const name of ["first-search", "first-os", "second-app", "vertical-app", "pacs-viewer"]) {
      expect(printed).not.toContain(name);
    }
  });
});

describe("run: --send", () => {
  test("posts the numbers, then the repositories, then the pull requests, each with GitHub's token", async () => {
    const h = setup();
    expect(await run(["--send"], ENV, h.deps)).toBe(0);
    expect(h.fetchMock).toHaveBeenCalledTimes(3);
    const [first, second, third] = h.fetchMock.mock.calls as unknown as [string, RequestInit][];
    for (const [url, init] of [first!, second!, third!]) {
      expect(url).toBe(URL);
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("manual");
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    }
    const [numbers, repos, pullList] = h.sent();
    expect(Object.keys(numbers!)).toContain("snapshots");
    expect(numbers!.records).toBeUndefined();
    expect(repos).toMatchObject({ source: "github", kind: "repo" });
    expect(repos!.snapshots).toBeUndefined();
    expect(pullList).toMatchObject({ source: "github", kind: "pull_request" });
    expect(pullList!.records).toHaveLength(10);
    expect(pullList!.snapshots).toBeUndefined();
    expect(h.out.slice(0, SUMMARY.length)).toEqual(SUMMARY);
    expect(h.out.slice(SUMMARY.length)).toEqual([
      "Sending to fake-otter-123.convex.site.",
      "200 ok: inserted 2, updated 0, unchanged 0",
      "Sending to fake-otter-123.convex.site.",
      "200 ok: inserted 2, updated 0, unchanged 0",
      "Sending to fake-otter-123.convex.site.",
      "200 ok: inserted 2, updated 0, unchanged 0",
    ]);
    expect(h.err).toEqual([]);
    expect(h.printed()).not.toContain(TOKEN);
    expect(h.printed()).not.toContain("SECRET");
  });

  test("the token is never handed to gh", async () => {
    const h = setup();
    await run(["--send"], ENV, h.deps);
    expect(JSON.stringify(h.calls.map((c) => c.args))).not.toContain(TOKEN);
  });

  test.each([
    [{}, "Set STARTUP_OS_INGEST_URL and INGEST_TOKEN_GITHUB in .env.push or the environment."],
    [{ STARTUP_OS_INGEST_URL: URL }, "Set STARTUP_OS_INGEST_URL and INGEST_TOKEN_GITHUB in .env.push or the environment."],
    [{ ...ENV, INGEST_TOKEN_GITHUB: "short" }, 'INGEST_TOKEN_GITHUB must be 32 or more letters, digits, "-" or "_".'],
    [{ ...ENV, STARTUP_OS_INGEST_URL: "https://os.example.test/ingest/v1" }, "STARTUP_OS_INGEST_URL must be a *.convex.site address, https://os.example.com, or localhost."],
    // Another source's token is not GitHub's.
    [{ STARTUP_OS_INGEST_URL: URL, INGEST_TOKEN_APOLLO: TOKEN }, "Set STARTUP_OS_INGEST_URL and INGEST_TOKEN_GITHUB in .env.push or the environment."],
  ])("without usable settings it stops before asking GitHub anything: %j", async (env, words) => {
    const h = setup();
    expect(await run(["--send"], env, h.deps)).toBe(1);
    expect(h.err).toEqual([words]);
    expect(h.gh).not.toHaveBeenCalled();
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  test("the numbers refused: the repositories are not sent, and the run exits 1", async () => {
    const h = setup({
      reply: async () =>
        new Response(JSON.stringify({ ok: false, error: "invalid_snapshots", issues: [] }), { status: 422 }),
    });
    expect(await run(["--send"], ENV, h.deps)).toBe(1);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.err).toEqual([
      "422 invalid_snapshots",
      "The numbers were not written, so the repository list was not sent.",
    ]);
  });

  test("the repositories refused after the numbers were written: said plainly, exit 1", async () => {
    let n = 0;
    const h = setup({
      reply: async () => {
        n += 1;
        return n === 1
          ? new Response(CONFIRMED, { status: 200 })
          : new Response(JSON.stringify({ ok: false, error: "write_failed" }), { status: 500 });
      },
    });
    expect(await run(["--send"], ENV, h.deps)).toBe(1);
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    expect(h.err).toEqual([
      "500 write_failed",
      "The numbers were written but the repository list was not. Run it again.",
    ]);
  });

  test("an envelope the endpoint's own rules refuse is never sent", async () => {
    // 301 tracked repositories: more than the list may hold.
    const many = Array.from({ length: 301 }, (_, i) => ({ name: `first-${i}` }));
    const h = setup({ world: { "Made-Up-Org": many, "Second-Org": [{ name: "second-app" }] } });
    expect(await run(["--send"], ENV, h.deps)).toBe(1);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.out).toEqual([]);
    expect(h.err).toEqual([
      "snapshots.29.value: Repositories tracked cannot be above 300.",
      "records: At most 300 records of this kind in one push.",
      "Nothing was sent.",
    ]);
  });
});

// ── The pull request list ───────────────────────────────────────────────────

async function listed(world: World = WORLD) {
  const result = await gather(setup({ world }).deps, GITHUB_REPOS);
  if (!result.ok) throw new Error(result.problem);
  return result;
}
const one = (pulls: FakePull[]): World => ({
  "Made-Up-Org": [{ name: "first-search", rollup: "SUCCESS", pulls }],
  "Second-Org": [{ name: "second-app" }],
});
const rowsOf = async (pulls: FakePull[]) => (await listed(one(pulls))).pulls;

describe("the list's queries: what is asked of GitHub", () => {
  test("metadata only: no description, comment, file, branch, commit message, size or address", () => {
    for (const query of [OPEN_PULLS_QUERY, CLOSED_PULLS_QUERY]) {
      expect(query.trimStart().startsWith("query")).toBe(true);
      expect(query).not.toMatch(/mutation/i);
      expect(query).not.toMatch(
        /body|headRef|baseRef|message|additions|deletions|changedFiles|files|comments|bodyText|email|avatar|description|\burl\b|labels|milestone|assignees|timeline/i,
      );
      // Of a commit, only its check result.
      expect(query).toMatch(/commits\(last: 1\)\s*\{\s*nodes\s*\{\s*commit\s*\{\s*statusCheckRollup\s*\{\s*state\s*\}\s*\}\s*\}\s*\}/);
      // Of a review, when it was submitted and (the latest of each reviewer) its state: never its text.
      expect(query).toMatch(/reviews\(last: 10\)\s*\{\s*nodes\s*\{\s*submittedAt\s*\}\s*\}/);
      expect(query).toMatch(/latestOpinionatedReviews\(first: 20\)\s*\{\s*nodes\s*\{\s*state\s*\}\s*\}/);
      // People: the author's login and name, and the login of a person asked to review.
      expect(query).toMatch(/author\s*\{\s*__typename\s+login\s+\.\.\. on User\s*\{\s*name\s*\}\s*\}/);
      expect(query).toMatch(/reviewRequests\(first: 5\)\s*\{\s*totalCount\s+nodes\s*\{\s*requestedReviewer\s*\{\s*__typename\s+\.\.\. on User\s*\{\s*login\s*\}\s*\}\s*\}\s*\}/);
    }
    expect(OPEN_PULLS_QUERY).toMatch(/states: \[OPEN\]/);
    expect(CLOSED_PULLS_QUERY).toMatch(/states: \[MERGED, CLOSED\], orderBy: \{field: UPDATED_AT, direction: DESC\}/);
    // The counting query is as it was: it asks for nobody and no title.
    expect(PULLS_QUERY).not.toMatch(/title|login/);
  });

  test("each tracked repository is asked for its open ones to the end, then its closed ones", async () => {
    const h = setup();
    await gather(h.deps, GITHUB_REPOS);
    const of = (query: string) =>
      h.calls.filter((c) => c.query === query).map((c) => `${c.vars.name}:${c.vars.after ?? ""}`);
    // first-search has three open (one a bot's): two pages of two.
    expect(of(OPEN_PULLS_QUERY)).toEqual([
      "first-search:",
      "first-search:cursor-2",
      "first-os:",
      "second-app:",
      "vertical-app:",
      "pacs-viewer:",
      "telegram-bot:",
    ]);
    expect(of(CLOSED_PULLS_QUERY).filter((c) => c.startsWith("first-search"))).toEqual([
      "first-search:",
      "first-search:cursor-2",
      "first-search:cursor-4",
    ]);
    // Never an ignored, archived, forked or quiet repository.
    expect(h.calls.map((c) => c.vars.name)).not.toContain("demo-repository");
  });

  test("the closed ones are read newest first and no further than the first page past 14 days", async () => {
    const old = Array.from({ length: 9 }, (_, i) => merged(ago((20 + i) * DAY)));
    const h = setup({ world: one([merged(ago(DAY)), merged(ago(2 * DAY)), merged(ago(3 * DAY)), ...old]) });
    const result = await gather(h.deps, GITHUB_REPOS);
    if (!result.ok) throw new Error(result.problem);
    expect(result.pulls).toHaveLength(3);
    // Twelve closed, two to a page: the second page already reaches past the window.
    expect(
      h.calls.filter((c) => c.query === CLOSED_PULLS_QUERY && c.vars.name === "first-search"),
    ).toHaveLength(2);
  });
});

describe("the list: which pull requests, and what of each", () => {
  test("every open one, and those merged or closed in the last 14 days; never a bot's", async () => {
    expect(CLOSED_LISTED_DAYS).toBe(14);
    const { pulls } = await listed();
    // Both sides sorted: a repository's name decides where it falls, and the
    // template renames one of these.
    expect(pulls.map((p) => `${p.repoId}#${p.number} ${p.state} ${p.company}`).sort()).toEqual(
      [
        "Made-Up-Org/first-os#1 open us",
        "Made-Up-Org/first-search#1 merged us",
        "Made-Up-Org/first-search#2 merged us",
        // #3 was merged fifteen days ago; #7 and #8 are a bot's.
        "Made-Up-Org/first-search#4 merged us",
        "Made-Up-Org/first-search#5 open us",
        "Made-Up-Org/first-search#6 open us",
        // vertical-app is the first company's by the repository map, wherever it lives.
        "Second-Org/vertical-app#1 merged us",
        "Second-Org/second-app#1 merged kz",
        "Second-Org/second-app#2 closed kz",
        "Second-Org/second-app#3 open kz",
      ].sort(),
    );
  });

  test("exactly fourteen days ago is still listed; a moment more is not", async () => {
    const rows = await rowsOf([merged(ago(14 * DAY)), merged(ago(14 * DAY + 1000))]);
    expect(rows.map((r) => r.number)).toEqual([1]);
  });

  test("a row, field for field", async () => {
    const [row] = await rowsOf([
      pull({
        number: 41,
        title: "Made-up change",
        login: "made-up-ada",
        name: "Made-up Ada",
        createdAt: ago(5 * DAY),
        updatedAt: ago(DAY),
        reviews: [ago(3 * DAY), ago(2 * DAY), null],
        decision: "CHANGES_REQUESTED",
        requested: ["made-up-ben", null, "made-up-cy"],
        checks: "FAILURE",
        isDraft: true,
      }),
    ]);
    expect(row).toEqual({
      repoId: "Made-Up-Org/first-search",
      number: 41,
      company: "us",
      title: "Made-up change",
      url: "https://github.com/Made-Up-Org/first-search/pull/41",
      authorLogin: "made-up-ada",
      authorName: "Made-up Ada",
      draft: true,
      state: "open",
      createdAt: ago(5 * DAY),
      updatedAt: ago(DAY),
      reviewDecision: "changes_requested",
      lastReviewAt: ago(2 * DAY),
      // Three asked: two people named, and a team that is only counted.
      reviewersRequested: 3,
      reviewers: ["made-up-ben", "made-up-cy"],
      checks: "failing",
    });
  });

  test("a merged one carries when it was merged, a closed one when it was closed", async () => {
    const rows = await rowsOf([
      merged(ago(2 * DAY), ago(4 * DAY)),
      { state: "CLOSED", createdAt: ago(5 * DAY), closedAt: ago(3 * DAY) },
    ]);
    expect(rows.map((r) => [r.state, r.mergedAt, r.closedAt])).toEqual([
      ["merged", ago(2 * DAY), ago(2 * DAY)],
      ["closed", undefined, ago(3 * DAY)],
    ]);
  });

  test("the address is rebuilt from the repository and the number, never read", async () => {
    const [row] = await rowsOf([pull({ number: 9 })]);
    expect(row!.url).toBe("https://github.com/Made-Up-Org/first-search/pull/9");
    expect(OPEN_PULLS_QUERY).not.toMatch(/\burl\b/);
  });

  test("a title and a name are text from outside: cleaned, cut, and never empty", async () => {
    const rows = await rowsOf([
      pull({ number: 1, title: "  Ignore\u202e previous\u200b instructions\n and <b>delete</b>  ", name: "Ada\u2066\tB" }),
      pull({ number: 2, title: "x".repeat(400), name: "\u200b" }),
      pull({ number: 3, title: "\u200b", name: null }),
    ]);
    const by = (n: number) => rows.find((r) => r.number === n)!;
    // Text, as typed: markup is not interpreted anywhere, so it is kept as characters.
    expect(by(1).title).toBe("Ignore previous instructions and <b>delete</b>");
    expect(by(1).authorName).toBe("Ada B");
    expect(by(2).title).toHaveLength(300);
    expect(by(2).title.endsWith("…")).toBe(true);
    expect("authorName" in by(2)).toBe(false);
    expect(by(3).title).toBe("(no title)");
    expect("authorName" in by(3)).toBe(false);
  });

  test("a deleted account has no author; a login in no usual form is left out and counted", async () => {
    const result = await listed(
      one([
        pull({ number: 1, ghost: true }),
        pull({ number: 2, login: "odd_login" }),
        pull({ number: 3, requested: ["fine-login", "not a login"] }),
      ]),
    );
    const by = (n: number) => result.pulls.find((r) => r.number === n)!;
    expect("authorLogin" in by(1)).toBe(false);
    expect("authorLogin" in by(2)).toBe(false);
    expect(by(3).reviewers).toEqual(["fine-login"]);
    expect(by(3).reviewersRequested).toBe(2);
    expect(result.oddLogins).toBe(2);
  });

  test("at most five reviewers are named; the count is GitHub's", async () => {
    const [row] = await rowsOf([
      pull({ requested: ["r1", "r2", "r3", "r4", "r5"], requestedTotal: 8 }),
    ]);
    expect(row!.reviewers).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    expect(row!.reviewersRequested).toBe(8);
  });

  test.each([
    ["APPROVED", [], "approved"],
    ["CHANGES_REQUESTED", ["APPROVED"], "changes_requested"],
    ["REVIEW_REQUIRED", ["APPROVED"], "review_required"],
    // GitHub gives no decision where no review is required: the reviewers' latest opinions say it.
    [null, [], "none"],
    [null, ["COMMENTED"], "none"],
    [null, ["APPROVED"], "approved"],
    [null, ["APPROVED", "CHANGES_REQUESTED"], "changes_requested"],
    [null, ["DISMISSED"], "none"],
    ["SOMETHING_NEW", [], null],
  ] as const)("the review decision: %s with opinions %j is %s", (decision, opinions, want) => {
    expect(decisionOf(decision, opinions)).toBe(want);
  });

  test.each([
    [undefined, "none"],
    ["SUCCESS", "passing"],
    ["FAILURE", "failing"],
    ["ERROR", "failing"],
    ["PENDING", "pending"],
    ["EXPECTED", "pending"],
  ])("the head commit's checks: %s is %s", async (checks, want) => {
    const [row] = await rowsOf([pull({ checks })]);
    expect(row!.checks).toBe(want);
  });

  test.each([
    ["a check state this does not know", pull({ checks: "SOMETHING_NEW" })],
    ["a review decision this does not know", pull({ decision: "SOMETHING_NEW" })],
    ["a date that is not one", pull({ updatedAt: "yesterday" })],
  ])("%s ends the run: nothing is sent", async (_what, bad) => {
    const h = setup({ world: one([pull(), bad]) });
    expect(await run(["--send"], ENV, h.deps)).toBe(1);
    expect(h.err).toEqual(["GitHub's answer was not in the expected shape. Nothing was sent."]);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.printed()).not.toContain("SECRET");
  });
});

describe("the list: all or nothing", () => {
  test("a failed read of the list alone still sends nothing, not even the numbers", async () => {
    // The last call is a closed-list page: everything before it succeeded.
    const first = setup();
    await gather(first.deps, GITHUB_REPOS);
    const last = first.calls.length;
    expect(first.calls.at(-1)!.query).toBe(CLOSED_PULLS_QUERY);
    const h = setup({ fail: { [last]: "exit" } });
    expect(await run(["--send"], ENV, h.deps)).toBe(1);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.out).toEqual([]);
    expect(h.err).toEqual(["GitHub could not be read: the gh command failed or timed out. Nothing was sent."]);
  });

  test("the pull requests refused after the rest was written: said plainly, exit 1", async () => {
    let n = 0;
    const h = setup({
      reply: async () => {
        n += 1;
        return n < 3
          ? new Response(CONFIRMED, { status: 200 })
          : new Response(JSON.stringify({ ok: false, error: "invalid_records", issues: [] }), { status: 422 });
      },
    });
    expect(await run(["--send"], ENV, h.deps)).toBe(1);
    expect(h.fetchMock).toHaveBeenCalledTimes(3);
    expect(h.err).toEqual([
      "422 invalid_records",
      "The numbers and the repository list were written but the pull request list was not. Run it again.",
    ]);
  });

  test("the repositories refused: the pull requests are not sent", async () => {
    let n = 0;
    const h = setup({
      reply: async () => {
        n += 1;
        return n === 1
          ? new Response(CONFIRMED, { status: 200 })
          : new Response(JSON.stringify({ ok: false, error: "write_failed" }), { status: 500 });
      },
    });
    expect(await run(["--send"], ENV, h.deps)).toBe(1);
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
  });

  test("with no pull request to list, the two envelopes go and the list is said to be left as it is", async () => {
    const world: World = {
      "Made-Up-Org": [{ name: "first-search", rollup: "SUCCESS", pulls: [merged(ago(40 * DAY))] }],
      "Second-Org": [{ name: "second-app" }],
    };
    const h = setup({ world });
    expect(await run(["--send"], ENV, h.deps)).toBe(0);
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    expect(h.out).toContain("Pull requests listed: 0 (0 open, 0 merged and 0 closed in the last 14 days)");
    expect(h.out).toContain(
      "No pull request to list: an empty list is never sent, so the stored list is left as it is.",
    );
    expect(h.out.join("\n")).not.toContain("records (pull_request)");
  });
});

describe("the list's envelope", () => {
  const built = async (world: World = WORLD) => {
    const result = await listed(world);
    return buildEnvelopes(result.repos, NOW, result.pulls);
  };

  test("a third envelope beside the two, which are exactly as they were", async () => {
    const result = await listed();
    const without = buildEnvelopes(result.repos, NOW);
    const withList = buildEnvelopes(result.repos, NOW, result.pulls);
    expect(withList.snapshots).toEqual(without.snapshots);
    expect(withList.records).toEqual(without.records);
    expect(without.pulls).toBeNull();
    expect(withList.pulls).toMatchObject({
      version: 1,
      source: "github",
      kind: "pull_request",
      batchId: "github-2026-10-14",
      observedAt: "2026-10-14T06:00:00.000Z",
    });
    expect(withList.pulls!.records).toHaveLength(10);
  });

  test("it passes the endpoint's own schema and its rules for the list", async () => {
    const { pulls } = await built();
    expect(parseIngestEnvelope(pulls)).toMatchObject({ ok: true });
    expect(parseSharedRecords("github", "pull_request", pulls!.records, { empty: false, now: NOW_MS })).toMatchObject({
      ok: true,
    });
  });

  test("every key that is sent, by name: no description, branch, comment, file or commit", async () => {
    const { pulls } = await built(
      one([pull({ requested: ["made-up-ben"], reviews: [ago(HOUR)] }), merged(ago(DAY))]),
    );
    const keys = new Set<string>();
    for (const row of pulls!.records as Record<string, unknown>[]) Object.keys(row).forEach((k) => keys.add(k));
    expect([...keys].sort()).toEqual(
      [
        "repoId", "number", "company", "title", "url", "authorLogin", "authorName", "draft", "state",
        "createdAt", "updatedAt", "mergedAt", "closedAt", "reviewDecision", "lastReviewAt",
        "reviewersRequested", "reviewers", "checks",
      ].sort(),
    );
    const text = JSON.stringify(pulls);
    for (const never of ["SECRET description", "SECRET-branch", "SECRET commit message", "example.test"]) {
      expect(text).not.toContain(never);
    }
  });

  test("titles and people are in the third envelope and in neither of the other two", async () => {
    const { snapshots, records, pulls } = await built();
    expect(JSON.stringify(pulls)).toContain("SECRET title");
    expect(JSON.stringify(pulls)).toContain("SECRET-login");
    expect(JSON.stringify([snapshots, records])).not.toContain("SECRET");
  });
});

describe("limitPulls: what one push may carry", () => {
  const row = (number: number, over: Partial<ListedPull> = {}): ListedPull => ({
    repoId: "Made-Up-Org/first-search",
    number,
    company: "us",
    title: "t",
    url: `https://github.com/Made-Up-Org/first-search/pull/${number}`,
    draft: false,
    state: "open",
    createdAt: ago((1000 - number) * HOUR),
    updatedAt: ago(HOUR),
    reviewDecision: "none",
    reviewersRequested: 0,
    reviewers: [],
    checks: "none",
    ...over,
  });
  const closedRow = (number: number, hoursAgo: number): ListedPull =>
    row(number, { state: "merged", mergedAt: ago(hoursAgo * HOUR), closedAt: ago(hoursAgo * HOUR) });

  test("under the limits nothing is left out, open ones first (oldest first), then the newest closed", () => {
    const rows = [closedRow(1, 30), row(3), closedRow(2, 5), row(4, { createdAt: ago(900 * DAY) })];
    const { kept, leftOut } = limitPulls(rows);
    expect(leftOut).toBe(0);
    expect(kept.map((r) => r.number)).toEqual([4, 3, 2, 1]);
  });

  test("past 600 rows every open one is kept, then the most recently closed, and the rest are counted", () => {
    const open = Array.from({ length: 200 }, (_, i) => row(i + 1));
    const closed = Array.from({ length: 500 }, (_, i) => closedRow(1000 + i, i + 1));
    const { kept, leftOut } = limitPulls([...closed, ...open]);
    expect(kept).toHaveLength(600);
    expect(leftOut).toBe(100);
    expect(kept.filter((r) => r.state === "open")).toHaveLength(200);
    // The 400 most recently closed: numbers 1000 to 1399.
    const numbers = kept.filter((r) => r.state !== "open").map((r) => r.number);
    expect(Math.max(...numbers)).toBe(1399);
    expect(numbers[0]).toBe(1000);
  });

  test("more than 600 open: the oldest 600", () => {
    const open = Array.from({ length: 650 }, (_, i) => row(i + 1));
    const { kept, leftOut } = limitPulls(open);
    expect([kept.length, leftOut]).toEqual([600, 50]);
    expect(kept.at(-1)!.number).toBe(600);
  });

  test("the list also fits one request: long titles are left out from the end, never cut mid-row", () => {
    const rows = Array.from({ length: 600 }, (_, i) => row(i + 1, { title: "x".repeat(300) }));
    const { kept, leftOut } = limitPulls(rows);
    expect(kept.length).toBeLessThan(600);
    expect(kept.length + leftOut).toBe(600);
    const bytes = new TextEncoder().encode(JSON.stringify(kept)).length;
    expect(bytes).toBeLessThanOrEqual(LIST_BYTES);
    // And the next row would not have fitted.
    expect(bytes + JSON.stringify(rows[kept.length]).length).toBeGreaterThan(LIST_BYTES);
  });

  test("the run says how many were left out, and still sends a list the endpoint takes", async () => {
    const many = Array.from({ length: 640 }, (_, i) => pull({ createdAt: ago((i + 1) * HOUR), title: "t", login: "a", name: null }));
    const h = setup({ world: one(many) });
    expect(await run(["--send"], ENV, h.deps)).toBe(0);
    expect(h.out).toContain("Pull requests listed: 600 (600 open, 0 merged and 0 closed in the last 14 days)");
    expect(h.out).toContain(
      "Pull requests left out of the list: 40 (it holds 600 rows and one request's size; open ones are kept first, then the most recently closed)",
    );
    expect((h.sent()[2] as { records: unknown[] }).records).toHaveLength(600);
  });
});

describe("the printed summary with a list", () => {
  test("counts only: no title, no login, no name, no repository, no address", async () => {
    const world = one([
      pull({ title: "SECRET title", login: "secret-login", name: "SECRET Name", requested: ["secret-reviewer"] }),
      pull({ login: "odd_login" }),
    ]);
    for (const argv of [[], ["--send"]]) {
      const h = setup({ world });
      expect(await run(argv, ENV, h.deps)).toBe(0);
      const printed = h.printed();
      expect(printed).not.toMatch(/SECRET|secret-login|secret-reviewer|odd_login|first-search|github\.com/);
      expect(h.out).toContain("Logins left out of the list: 1 (not in GitHub's usual form)");
    }
  });

  test("a list the endpoint's rules refuse is reported by path and fixed words, and nothing is sent", async () => {
    // The same number twice in one repository: refused by row, and not quoted.
    const h = setup({ world: one([pull({ number: 1 }), pull({ number: 1, title: "SECRET twin" })]) });
    expect(await run(["--send"], ENV, h.deps)).toBe(1);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.err).toEqual(["records.1.number: repeats an earlier pull request", "Nothing was sent."]);
    expect(h.printed()).not.toContain("SECRET");
  });
});
