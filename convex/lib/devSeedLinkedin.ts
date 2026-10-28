// The LinkedIn calendar's made-up rows for the local backend
// (convex/devSeed.ts). Every hook, name and figure here is invented and reads
// as invented. Days are counted from the seed's "now", so the seeded page shows
// a scheduled post with no draft, posts that went out over four weeks, and a
// week with nothing planned for Globex.

import { COMPANIES, type CompanyId } from "./company";
import type { AccountKind, PostStatus } from "./linkedin";

export type SeedFigures = {
  /** Days after it went out that the figures were read. */
  after: number;
  impressions: number;
  reactions: number;
  comments: number;
  reposts: number;
  clicks: number;
  followersGained: number;
};

export type SeedLinkedinPost = {
  company: CompanyId;
  account: AccountKind;
  person?: string;
  status: PostStatus;
  title: string;
  body?: string;
  pillar?: string;
  /** Days from now at 09:00 UTC; negative is past. Absent: undated. */
  at?: number;
  /** Whether the owner owns it. */
  ownedByOwner?: boolean;
  link?: string;
  figures?: SeedFigures[];
};

const fig = (after: number, impressions: number, reactions: number, comments: number, reposts: number, clicks: number, followersGained: number): SeedFigures => ({
  after, impressions, reactions, comments, reposts, clicks, followersGained,
});

export const SEED_LINKEDIN: SeedLinkedinPost[] = [
  {
    company: "us", account: "page", status: "published", at: -24, pillar: "denials", ownedByOwner: true,
    title: "Made-up: why a denial starts at the front desk",
    body: "A made-up post about intake errors.\n\nNothing here was posted anywhere.",
    link: "https://www.linkedin.com/posts/made-up-front-desk",
    figures: [fig(1, 420, 12, 1, 0, 9, 1), fig(3, 980, 31, 4, 2, 21, 3), fig(7, 1_450, 44, 6, 3, 38, 4), fig(20, 1_900, 52, 8, 4, 51, 6)],
  },
  {
    company: "us", account: "page", status: "published", at: -17, pillar: "coding",
    title: "Made-up: three code pairs that bundle",
    body: "A made-up post about edits.",
    link: "https://www.linkedin.com/posts/made-up-code-pairs",
    figures: [fig(1, 610, 25, 3, 2, 14, 2), fig(4, 1_700, 71, 9, 6, 40, 5), fig(14, 2_600, 96, 12, 9, 66, 9)],
  },
  {
    company: "us", account: "person", person: "Sample Founder", status: "published", at: -10, pillar: "founder",
    title: "Made-up: what a first clinic taught us",
    body: "A made-up story.",
    link: "https://www.linkedin.com/posts/made-up-first-clinic",
    figures: [fig(1, 900, 60, 14, 5, 12, 6), fig(3, 2_400, 140, 31, 12, 33, 15), fig(9, 3_300, 171, 38, 15, 44, 21)],
  },
  {
    company: "us", account: "page", status: "published", at: -3, pillar: "denials",
    title: "Made-up: the appeal letter nobody reads",
    body: "A made-up post about appeals.",
    link: "https://www.linkedin.com/posts/made-up-appeals",
    figures: [fig(1, 380, 11, 1, 0, 6, 0), fig(2, 760, 23, 3, 1, 13, 2)],
  },
  // Scheduled for tomorrow with no draft: it needs the owner.
  { company: "us", account: "page", status: "scheduled", at: 1, pillar: "coding", ownedByOwner: true, title: "Made-up: modifier 25, plainly" },
  {
    company: "us", account: "page", status: "scheduled", at: 4, pillar: "denials",
    title: "Made-up: a prior-auth checklist", body: "A made-up checklist post.",
  },
  {
    company: "us", account: "person", person: "Sample Founder", status: "draft", at: 8, pillar: "founder",
    title: "Made-up: what we learned about reading policies", body: "Half a made-up draft.",
  },
  { company: "us", account: "page", status: "idea", pillar: "coding", title: "Made-up idea: a week of CARC codes" },
  { company: "us", account: "page", status: "dropped", at: -6, title: "Made-up: a post that was dropped" },
  {
    company: "kz", account: "page", status: "published", at: -12, pillar: "product",
    title: `Made-up: ${COMPANIES.kz.name} reads a radiograph in seconds`,
    body: "A made-up product post.",
    link: "https://www.linkedin.com/posts/made-up-second",
    figures: [fig(1, 300, 9, 1, 0, 4, 1), fig(5, 880, 28, 3, 2, 12, 4), fig(11, 1_200, 37, 4, 3, 19, 6)],
  },
  {
    company: "kz", account: "page", status: "scheduled", at: 3, pillar: "product",
    title: "Made-up: a clinic story from Almaty", body: "A made-up clinic story.",
  },
  { company: "kz", account: "person", person: "Made-up Person", status: "idea", title: "Made-up idea: why we built it in Almaty" },
];

/** The posts a week the seeded page asks of each company. */
export const SEED_LINKEDIN_TARGETS: Record<CompanyId, number> = { us: 2, kz: 1 };
