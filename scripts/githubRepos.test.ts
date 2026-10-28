import { describe, expect, test } from "vitest";
import {
  ACTIVE_DAYS,
  GITHUB_REPOS,
  companyOfRepo,
  trackingOf,
  type RepoConfig,
} from "./githubRepos";

// A Wednesday.
const NOW = Date.UTC(2026, 9, 14, 6);
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

const listed = (org: string, name: string, over: Record<string, unknown> = {}) => ({
  org,
  name,
  isArchived: false,
  isFork: false,
  pushedAt: iso(NOW - DAY),
  ...over,
});

// The map as the made-up deployment has it (convex/lib/deployment.kit.ts, which every test runs as);
// the deployment's own organisations are pinned in convex/lib/deployment.test.ts.
describe("the map", () => {
  test("two organisations, each with the company its repositories default to", () => {
    expect(GITHUB_REPOS.orgs).toEqual([
      { login: "Made-Up-Org", company: "us" },
      { login: "Second-Org", company: "kz" },
    ]);
  });

  test("no per-repository override to start with, and the ignored repositories", () => {
    expect(GITHUB_REPOS.overrides).toEqual({});
    expect(GITHUB_REPOS.ignored).toEqual([
      "demo-repository",
      "sample-intros",
    ]);
    expect(ACTIVE_DAYS).toBe(90);
    expect(GITHUB_REPOS.activeDays).toBe(90);
  });

  test("no prefix is claimed by both companies", () => {
    const [kz, us] = GITHUB_REPOS.nameRules;
    expect([kz!.company, us!.company]).toEqual(["kz", "us"]);
    for (const a of kz!.prefixes) {
      for (const b of us!.prefixes) {
        expect(a.startsWith(b) || b.startsWith(a), `${a} / ${b}`).toBe(false);
      }
    }
  });
});

describe("companyOfRepo", () => {
  test("an organisation's default: Made-Up-Org is the first company's, Second-Org the second's", () => {
    expect(companyOfRepo("Made-Up-Org", "website")).toBe("us");
    expect(companyOfRepo("Second-Org", "infrastructure")).toBe("kz");
    // GitHub does not tell an organisation's name apart by case.
    expect(companyOfRepo("made-up-org", "website")).toBe("us");
  });

  test.each(["second-app", "radio-tools", "pacs-viewer", "Second-API"])(
    "%s is the second company's by its name, even in the first's organisation",
    (name) => {
      expect(companyOfRepo("Made-Up-Org", name)).toBe("kz");
    },
  );

  test.each(["vertical-app", "first-search", "First-OS"])(
    "%s is the first company's by its name, even in the second's organisation",
    (name) => {
      expect(companyOfRepo("Second-Org", name)).toBe("us");
    },
  );

  test("a name rule is a prefix, not a word anywhere in the name", () => {
    expect(companyOfRepo("Second-Org", "my-first-notes")).toBe("kz");
    expect(companyOfRepo("Made-Up-Org", "old-second-list")).toBe("us");
  });

  test("an explicit override beats a name rule and the default", () => {
    const config: RepoConfig = {
      ...GITHUB_REPOS,
      overrides: { "second-org/first-archive": "kz", "made-up-org/website": "kz" },
    };
    expect(companyOfRepo("Second-Org", "first-archive", config)).toBe("kz");
    expect(companyOfRepo("Second-Org", "First-Archive", config)).toBe("kz");
    expect(companyOfRepo("Made-Up-Org", "website", config)).toBe("kz");
    // The same name in the other organisation is not overridden.
    expect(companyOfRepo("Made-Up-Org", "first-archive", config)).toBe("us");
  });

  test("an organisation the map does not hold has no company", () => {
    expect(companyOfRepo("Somebody-Else", "first-search")).toBeNull();
  });
});

describe("trackingOf: which repositories are counted", () => {
  test("an ordinary repository pushed to yesterday is tracked for its company", () => {
    expect(trackingOf(listed("Made-Up-Org", "first-search"), NOW)).toEqual({ tracked: true, company: "us" });
    expect(trackingOf(listed("Second-Org", "vertical-app"), NOW)).toEqual({ tracked: true, company: "us" });
    expect(trackingOf(listed("Second-Org", "second-app"), NOW)).toEqual({ tracked: true, company: "kz" });
  });

  test.each(GITHUB_REPOS.ignored)("%s is ignored, in either organisation and however it is cased", (name) => {
    expect(trackingOf(listed("Made-Up-Org", name), NOW)).toEqual({ tracked: false, reason: "ignored" });
    expect(trackingOf(listed("Second-Org", name.toUpperCase()), NOW)).toEqual({
      tracked: false,
      reason: "ignored",
    });
  });

  test("an archived repository and a fork are skipped", () => {
    expect(trackingOf(listed("Made-Up-Org", "first-old", { isArchived: true }), NOW)).toEqual({
      tracked: false,
      reason: "archived",
    });
    expect(trackingOf(listed("Made-Up-Org", "radio-viewer", { isFork: true }), NOW)).toEqual({
      tracked: false,
      reason: "fork",
    });
  });

  test("the 90-day rule: pushed to within ninety days, to the moment", () => {
    const at = (ms: number) => trackingOf(listed("Made-Up-Org", "first-search", { pushedAt: iso(ms) }), NOW);
    expect(at(NOW - 89 * DAY)).toEqual({ tracked: true, company: "us" });
    expect(at(NOW - 90 * DAY)).toEqual({ tracked: true, company: "us" });
    expect(at(NOW - 90 * DAY - 1000)).toEqual({ tracked: false, reason: "quiet" });
    expect(at(NOW - 400 * DAY)).toEqual({ tracked: false, reason: "quiet" });
  });

  test("a repository nothing was ever pushed to is quiet, not tracked", () => {
    expect(trackingOf(listed("Made-Up-Org", "first-empty", { pushedAt: null }), NOW)).toEqual({
      tracked: false,
      reason: "quiet",
    });
  });

  test("an override names a company, and does not bring back an ignored or archived repository", () => {
    const config: RepoConfig = {
      ...GITHUB_REPOS,
      overrides: { "made-up-org/demo-repository": "us", "made-up-org/website": "kz" },
    };
    expect(trackingOf(listed("Made-Up-Org", "demo-repository"), NOW, config)).toEqual({
      tracked: false,
      reason: "ignored",
    });
    expect(trackingOf(listed("Made-Up-Org", "website"), NOW, config)).toEqual({ tracked: true, company: "kz" });
    expect(trackingOf(listed("Made-Up-Org", "website", { isArchived: true }), NOW, config)).toEqual({
      tracked: false,
      reason: "archived",
    });
  });
});
