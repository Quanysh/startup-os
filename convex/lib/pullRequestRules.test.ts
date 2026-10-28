import { describe, expect, test } from "vitest";
import { isRecordsEnvelope, parseIngestEnvelope } from "./ingestSchema";
import { MAX_PULL_REQUESTS } from "./limits";
import { SHARED_KINDS, SHARED_KINDS_OF } from "./mirrorRules";
import {
  SHARED_CAPS,
  parseSharedRecords,
  sharedKeyOf,
  sharedRefusal,
  type SharedRecord,
} from "./sharedRecords";

// GitHub's third list: individual pull requests, with their title and author.
// Every organisation, repository, title and person here is made up. A value
// that must never be echoed in an issue carries SECRET.

// A Wednesday.
const NOW = Date.UTC(2026, 9, 14, 6);
const options = { empty: false, now: NOW };

const pull = (number: number, over: Record<string, unknown> = {}) => ({
  repoId: "Made-Up-Org/startup-app",
  number,
  company: "us",
  title: `SECRET title ${number}`,
  url: `https://github.com/Made-Up-Org/startup-app/pull/${number}`,
  authorLogin: "made-up-ada",
  authorName: "Made-up Ada",
  draft: false,
  state: "open",
  createdAt: "2026-10-10T08:00:00Z",
  updatedAt: "2026-10-13T09:00:00Z",
  reviewDecision: "review_required",
  lastReviewAt: "2026-10-12T10:00:00Z",
  reviewersRequested: 1,
  reviewers: ["made-up-ben"],
  checks: "passing",
  ...over,
});
const issuesOf = (result: ReturnType<typeof parseSharedRecords>) => (result.ok ? [] : result.issues);
const parse = (rows: unknown[]) => parseSharedRecords("github", "pull_request", rows, options);
const merged = { state: "merged", mergedAt: "2026-10-13T09:00:00Z", closedAt: "2026-10-13T09:00:00Z" };

describe("which source carries the pull request list", () => {
  test("it is GitHub's second list, and nobody else's", () => {
    expect(SHARED_KINDS).toContain("pull_request");
    expect(SHARED_KINDS_OF.github).toEqual(["repo", "pull_request"]);
    expect(SHARED_KINDS_OF.apollo).not.toContain("pull_request");
    expect(issuesOf(parseSharedRecords("apollo", "pull_request", [pull(1)], options))).toEqual([
      { path: "kind", message: "This source has no list of that kind." },
    ]);
  });

  test("the envelope takes the kind for GitHub and refuses it for Apollo", () => {
    const header = { version: 1, source: "github", batchId: "github-2026-10-14", observedAt: "2026-10-14T06:00:00Z" };
    const result = parseIngestEnvelope({ ...header, kind: "pull_request", records: [{}] });
    expect(result.ok).toBe(true);
    if (result.ok && isRecordsEnvelope(result.envelope)) expect(result.envelope.kind).toBe("pull_request");
    const apollo = parseIngestEnvelope({ ...header, source: "apollo", kind: "pull_request", records: [{}] });
    expect(apollo.ok ? [] : apollo.issues).toEqual([
      { path: "kind", message: "This source has no list of that kind." },
    ]);
  });
});

describe("parseSharedRecords: pull requests", () => {
  test("a pull request becomes the stored record: times as instants, the rest as sent", () => {
    expect(parse([pull(7)])).toEqual({
      ok: true,
      rows: [
        {
          kind: "pull_request",
          repoId: "Made-Up-Org/startup-app",
          number: 7,
          company: "us",
          title: "SECRET title 7",
          url: "https://github.com/Made-Up-Org/startup-app/pull/7",
          authorLogin: "made-up-ada",
          authorName: "Made-up Ada",
          draft: false,
          state: "open",
          createdAt: Date.UTC(2026, 9, 10, 8),
          updatedAt: Date.UTC(2026, 9, 13, 9),
          reviewDecision: "review_required",
          lastReviewAt: Date.UTC(2026, 9, 12, 10),
          reviewersRequested: 1,
          reviewers: ["made-up-ben"],
          checks: "passing",
        },
      ],
    });
  });

  test("what may be absent: the author (a deleted account), a name, a review, reviewers", () => {
    const bare = pull(7, { reviewersRequested: 0, reviewers: [], reviewDecision: "none" }) as Record<string, unknown>;
    delete bare.authorLogin;
    delete bare.authorName;
    delete bare.lastReviewAt;
    const result = parse([bare]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.rows[0]!)).not.toContain("authorLogin");
    expect(Object.keys(result.rows[0]!)).not.toContain("authorName");
    expect(Object.keys(result.rows[0]!)).not.toContain("lastReviewAt");
  });

  test("a merged and a closed one carry when", () => {
    const result = parse([pull(1, merged), pull(2, { state: "closed", closedAt: "2026-10-12T09:00:00Z" })]);
    expect(result.ok && result.rows.map((r) => r.kind === "pull_request" && [r.state, r.mergedAt, r.closedAt])).toEqual([
      ["merged", Date.UTC(2026, 9, 13, 9), Date.UTC(2026, 9, 13, 9)],
      ["closed", undefined, Date.UTC(2026, 9, 12, 9)],
    ]);
  });

  test("the title and the name are cleaned by the project's text rules", () => {
    const result = parse([
      pull(7, {
        title: "  Fix‮ the​ thing\n\nnow\u0000 ",
        authorName: "Made-up⁦ Ada\t",
      }),
    ]);
    expect(result.ok && result.rows[0]).toMatchObject({ title: "Fix the thing now", authorName: "Made-up Ada" });
  });

  test("a title with nothing to read is said to be so, and a name with nothing is no name", () => {
    const result = parse([pull(7, { title: " ​ ", authorName: "​" })]);
    expect(result.ok && result.rows[0]).toMatchObject({ title: "(no title)" });
    expect(result.ok && Object.keys(result.rows[0]!)).not.toContain("authorName");
  });

  test.each([
    ["body", "SECRET description"],
    ["headRefName", "SECRET-branch"],
    ["branch", "SECRET-branch"],
    ["comments", ["SECRET comment"]],
    ["reviewComments", 4],
    ["files", ["SECRET/path.ts"]],
    ["additions", 120],
    ["commitMessage", "SECRET message"],
    ["authorEmail", "secret@example.test"],
    ["avatarUrl", "https://example.test/SECRET.png"],
    ["bot", false],
  ])("strict: there is no field for %s, and what was sent is not echoed", (field, value) => {
    const result = parse([pull(7, { [field]: value })]);
    expect(issuesOf(result)).toEqual([{ path: "records.0", message: "has a field the OS does not accept" }]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain(field);
  });

  test.each([
    // The URL is the one link the page renders: it is GitHub's own for this pull request, or nothing.
    [{ url: "https://example.test/Made-Up-Org/startup-app/pull/7" }, "records.0.url", "is not this pull request's address on GitHub"],
    [{ url: "http://github.com/Made-Up-Org/startup-app/pull/7" }, "records.0.url", "is not this pull request's address on GitHub"],
    [{ url: "https://github.com/Made-Up-Org/startup-app/pull/8" }, "records.0.url", "is not this pull request's address on GitHub"],
    [{ url: "https://github.com/Other-Org/startup-app/pull/7" }, "records.0.url", "is not this pull request's address on GitHub"],
    [{ url: "https://github.com/Made-Up-Org/startup-app/pull/7?x=SECRET" }, "records.0.url", "is not this pull request's address on GitHub"],
    [{ url: "https://github.com/Made-Up-Org/startup-app/pull/7#SECRET" }, "records.0.url", "is not this pull request's address on GitHub"],
    [{ url: "javascript:alert('SECRET')" }, "records.0.url", "is not this pull request's address on GitHub"],
    [{ url: "https://github.com.example.test/Made-Up-Org/startup-app/pull/7" }, "records.0.url", "is not this pull request's address on GitHub"],
    [{ repoId: "Made-Up-Org/has space" }, "records.0.repoId", "is not in the expected form"],
    [{ repoId: "no-slash" }, "records.0.repoId", "is not in the expected form"],
    [{ repoId: "a/b/c" }, "records.0.repoId", "is not in the expected form"],
    [{ number: 0 }, "records.0.number", "is empty or too small"],
    [{ number: 7.5 }, "records.0.number", "is missing or of the wrong type"],
    [{ title: "x".repeat(301) }, "records.0.title", "is too long or too large"],
    [{ authorName: "x".repeat(101) }, "records.0.authorName", "is too long or too large"],
    [{ authorLogin: "has space" }, "records.0.authorLogin", "is not in the expected form"],
    [{ authorLogin: "under_score" }, "records.0.authorLogin", "is not in the expected form"],
    [{ authorLogin: "x".repeat(40) }, "records.0.authorLogin", "is too long or too large"],
    [{ authorLogin: "" }, "records.0.authorLogin", "is empty or too small"],
    [{ reviewers: ["ok", "not ok"] }, "records.0.reviewers.1", "is not in the expected form"],
    [{ reviewers: ["a", "b", "c", "d", "e", "f"], reviewersRequested: 6 }, "records.0.reviewers", "is too long or too large"],
    [{ reviewers: ["a", "b"], reviewersRequested: 1 }, "records.0.reviewers", "names more reviewers than are requested"],
    [{ reviewersRequested: -1 }, "records.0.reviewersRequested", "is empty or too small"],
    [{ company: "company" }, "records.0.company", "is not one of the allowed values"],
    [{ state: "OPEN" }, "records.0.state", "is not one of the allowed values"],
    [{ reviewDecision: "APPROVED" }, "records.0.reviewDecision", "is not one of the allowed values"],
    [{ checks: "SUCCESS" }, "records.0.checks", "is not one of the allowed values"],
    [{ draft: "no" }, "records.0.draft", "is missing or of the wrong type"],
    [{ createdAt: "2026-10-10" }, "records.0.createdAt", "is not in the expected form"],
    [{ createdAt: "yesterday" }, "records.0.createdAt", "is not in the expected form"],
    [{ updatedAt: "2026-10-16T09:00:00Z" }, "records.0.updatedAt", "is in the future"],
    [{ updatedAt: "2026-10-09T09:00:00Z" }, "records.0.updatedAt", "is before it was opened"],
    [{ lastReviewAt: "2026-10-09T09:00:00Z" }, "records.0.lastReviewAt", "is before it was opened"],
    [{ mergedAt: "2026-10-13T09:00:00Z" }, "records.0.mergedAt", "is given for one that is not merged"],
    [{ closedAt: "2026-10-13T09:00:00Z" }, "records.0.closedAt", "is given for one that is open"],
    [{ state: "merged" }, "records.0.mergedAt", "is missing for one that is merged"],
    [{ state: "closed" }, "records.0.closedAt", "is missing for one that is closed"],
    [{ state: "closed", closedAt: "2026-10-13T09:00:00Z", mergedAt: "2026-10-13T09:00:00Z" }, "records.0.mergedAt", "is given for one that is not merged"],
  ])("a row that could not be true: %j", (over, path, message) => {
    const result = parse([pull(7, over)]);
    expect(issuesOf(result)).toContainEqual({ path, message });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  test("a time may be a day ahead of the server's clock, and carry an offset", () => {
    expect(parse([pull(7, { updatedAt: "2026-10-14T20:00:00Z" })]).ok).toBe(true);
    const offset = parse([pull(7, { createdAt: "2026-10-10T13:00:00+05:00" })]);
    expect(offset.ok && offset.rows[0]).toMatchObject({ createdAt: Date.UTC(2026, 9, 10, 8) });
  });

  test("the same pull request twice refuses the push, however its repository is cased", () => {
    const again = pull(7, {
      repoId: "made-up-org/STARTUP-APP",
      url: "https://github.com/made-up-org/STARTUP-APP/pull/7",
    });
    expect(issuesOf(parse([pull(7), again]))).toEqual([
      { path: "records.1.number", message: "repeats an earlier pull request" },
    ]);
  });

  test("a repository's pull requests are one company's", () => {
    expect(issuesOf(parse([pull(7), pull(8, { company: "kz" })]))).toEqual([
      { path: "records.1.company", message: "is not the company of this repository's other pull requests" },
    ]);
  });

  test(`at most ${MAX_PULL_REQUESTS} pull requests`, () => {
    expect(MAX_PULL_REQUESTS).toBe(600);
    expect(SHARED_CAPS.pull_request).toBe(600);
    const rows = (n: number) => Array.from({ length: n }, (_, i) => pull(i + 1));
    expect(parse(rows(600)).ok).toBe(true);
    expect(issuesOf(parse(rows(601)))).toEqual([
      { path: "records", message: "At most 600 records of this kind in one push." },
    ]);
  });

  test("an empty list is refused, with `empty` or without", () => {
    expect(issuesOf(parse([])).map((i) => i.path)).toEqual(["records"]);
    expect(
      issuesOf(parseSharedRecords("github", "pull_request", [], { empty: true, now: NOW })).map((i) => i.path),
    ).toEqual(["empty"]);
  });

  test("a repository row is not a pull request, and the other way round", () => {
    const repo = {
      repoId: "Made-Up-Org/startup-app",
      org: "Made-Up-Org",
      name: "startup-app",
      company: "us",
      mergedLastWeek: 1,
      open: 1,
      stuck: 0,
      main: "passing",
      pushedAt: "2026-10-13",
    };
    expect(parse([repo]).ok).toBe(false);
    const asRepo = parseSharedRecords("github", "repo", [pull(7)], options);
    expect(asRepo.ok).toBe(false);
    expect(JSON.stringify(asRepo)).not.toContain("SECRET");
  });
});

describe("the pull request list's key and the write's own guard", () => {
  const stored = (number: number, over: Record<string, unknown> = {}) => {
    const parsed = parse([pull(number)]);
    if (!parsed.ok) throw new Error("fixture");
    return { ...parsed.rows[0]!, ...over } as SharedRecord;
  };
  const words = (bad: number, of: number) =>
    `${bad} of ${of} records broke the size and shape rules, so nothing was written.`;

  test("keyed by repository and number, ordered by the last activity", () => {
    expect(sharedKeyOf(stored(7))).toEqual({
      externalId: "pr:made-up-org/startup-app#7",
      sortAt: Date.UTC(2026, 9, 13, 9),
    });
  });

  test("what the parser produces passes", () => {
    const parsed = parse([pull(1), pull(2, merged)]);
    expect(parsed.ok && sharedRefusal("pull_request", parsed.rows)).toBeNull();
  });

  test.each([
    [{ url: "https://example.test/SECRET" }],
    [{ url: "https://github.com/Made-Up-Org/startup-app/pull/8" }],
    [{ title: "x".repeat(301) }],
    [{ title: "" }],
    [{ title: "hidden​" }],
    [{ authorLogin: "not a login" }],
    [{ authorName: "" }],
    [{ authorName: "x".repeat(101) }],
    [{ reviewers: ["a", "b", "c", "d", "e", "f"], reviewersRequested: 6 }],
    [{ reviewers: ["not a login"] }],
    [{ number: 1.5 }],
    [{ repoId: "Made-Up-Org/a b" }],
    [{ createdAt: 12 }],
    [{ updatedAt: Number.NaN }],
    [{ state: "merged" }],
    [{ mergedAt: Date.UTC(2026, 9, 13) }],
  ])("a stored row that could not be the parser's is refused: %j", (over) => {
    expect(sharedRefusal("pull_request", [stored(7, over)])).toBe(words(1, 1));
  });

  test("a repeat, a row of another kind and an empty batch are refused", () => {
    expect(sharedRefusal("pull_request", [])).toBe("An empty list is never written for this source.");
    expect(sharedRefusal("pull_request", [stored(7), stored(7)])).toBe(words(1, 2));
    expect(sharedRefusal("repo", [stored(7)])).toBe(words(1, 1));
  });
});
