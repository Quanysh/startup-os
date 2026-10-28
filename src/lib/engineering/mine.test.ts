import { describe, expect, test } from "vitest";
import type { PullRow } from "./flow";
import { GITHUB_ASK_OWNER, GITHUB_SET_YOURS, githubPrompt, pullsForMe } from "./mine";

// Every pull request, repository and person here is made up.
const NOW = Date.UTC(2026, 9, 14, 12);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms: number) => NOW - ms;

let number = 0;
const pr = (title: string, over: Partial<PullRow> = {}): PullRow => ({
  repoId: "Made-Up-Org/startup-app",
  number: ++number,
  company: "us",
  title,
  url: "https://github.com/Made-Up-Org/startup-app/pull/1",
  authorLogin: "made-up-ada",
  draft: false,
  state: "open",
  createdAt: ago(DAY),
  updatedAt: ago(HOUR),
  reviewDecision: "none",
  reviewersRequested: 0,
  reviewers: [],
  checks: "passing",
  ...over,
});
const stuck = { createdAt: ago(9 * DAY), updatedAt: ago(9 * DAY) };
const titles = (rows: readonly { pull: PullRow }[]) => rows.map((row) => row.pull.title);
const BOTH = ["us", "kz"] as const;

describe("pull requests, for one person", () => {
  const rows = [
    pr("mine, fresh"),
    pr("mine, stuck", stuck),
    pr("mine, merged", { state: "merged", mergedAt: ago(DAY) }),
    pr("theirs, stuck", { ...stuck, authorLogin: "made-up-ben" }),
    pr("theirs, asks me", { authorLogin: "made-up-ben", reviewers: ["Made-Up-Ada"], reviewersRequested: 1 }),
    pr("theirs, asks someone else", { authorLogin: "made-up-ben", reviewers: ["made-up-cy"], reviewersRequested: 1 }),
    pr("mine, asks me", { reviewers: ["made-up-ada"], reviewersRequested: 1 }),
  ];

  test("with a GitHub username: my open ones, which of mine are stuck, and where I am asked to review", () => {
    const result = pullsForMe(rows, { login: "Made-Up-Ada", companies: BOTH, now: NOW });
    expect(result.known).toBe(true);
    // Open only: a merged one is done.
    expect(titles(result.open)).toEqual(["mine, fresh", "mine, stuck", "mine, asks me"]);
    expect(titles(result.stuck)).toEqual(["mine, stuck"]);
    expect(result.stuck[0]!.words).toBe("Waiting 9 days for a first review");
    // Somebody else's, where I am one of those asked; whatever the capitals.
    expect(titles(result.reviews)).toEqual(["theirs, asks me"]);
  });

  test("without one: the company's stuck pull requests, nobody's in particular", () => {
    const result = pullsForMe(rows, { login: null, companies: BOTH, now: NOW });
    expect(result.known).toBe(false);
    expect(titles(result.stuck)).toEqual(["mine, stuck", "theirs, stuck"]);
    expect(result.open).toHaveLength(6);
    expect(result.reviews).toEqual([]);
  });

  test("a login that opened nothing has nothing, and is not shown the company's instead", () => {
    const result = pullsForMe(rows, { login: "made-up-nobody", companies: BOTH, now: NOW });
    expect(result).toMatchObject({ known: true, open: [], stuck: [], reviews: [] });
  });

  test("only the companies in view: a Globex view never holds a Startup pull request", () => {
    const mixed = [
      pr("SECRET startup", stuck),
      pr("globex", { ...stuck, company: "kz" }),
      pr("SECRET startup asks me", { authorLogin: "made-up-ben", reviewers: ["made-up-ada"] }),
    ];
    for (const login of ["made-up-ada", null]) {
      const result = pullsForMe(mixed, { login, companies: ["kz"], now: NOW });
      const all = [...result.open, ...result.stuck, ...result.reviews];
      expect(titles(all).join()).not.toContain("SECRET");
      expect(titles(result.stuck)).toEqual(["globex"]);
    }
  });

  test("the longest stuck comes first", () => {
    const result = pullsForMe(
      [pr("three days", { createdAt: ago(4 * DAY) }), pr("nine days", stuck)],
      { login: null, companies: BOTH, now: NOW },
    );
    expect(titles(result.stuck)).toEqual(["nine days", "three days"]);
  });
});

describe("the line that asks for a GitHub username", () => {
  test("the owner is told where to add theirs; a teammate to ask the owner", () => {
    expect(githubPrompt(true)).toBe(GITHUB_SET_YOURS);
    expect(githubPrompt(false)).toBe(GITHUB_ASK_OWNER);
    expect(GITHUB_SET_YOURS).toBe("Add your GitHub username on the Team page to see only yours.");
    expect(GITHUB_ASK_OWNER).toBe(
      "Ask the owner to add your GitHub username on the Team page to see only yours.",
    );
  });
});
