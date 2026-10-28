// The LinkedIn content calendar (convex/linkedin.ts, /linkedin, the `gtm`
// area): the closed sets, the limits, the fixed sentences and the arithmetic,
// in one pure module the page imports too. **No LinkedIn API is used, and the
// OS publishes nothing**: a post and its figures are typed by a person or
// pushed by a bot through the owner's agent (`linkedin_post_upsert`,
// `linkedin_stats_add`).
//
// Everything typed is data: a hook, a draft, a pillar, a person's name, a
// link. Each is cleaned (convex/lib/memory.ts), held to its limit (refused,
// never cut), stored as plain text and rendered as text. None goes in a log or
// a thrown error: every refusal below is fixed words.
//
// The arithmetic takes calendar days ("YYYY-MM-DD") the caller worked out
// (the browser's own day, or UTC on the server) and `today` handed in: nothing
// here reads a clock.

import type { CompanyId } from "./company";

export const POST_STATUSES = ["idea", "draft", "scheduled", "published", "dropped"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const POST_STATUS_LABELS: Record<PostStatus, string> = {
  idea: "Idea",
  draft: "Draft",
  scheduled: "Scheduled",
  published: "Published",
  dropped: "Dropped",
};

/** A company's own page, or a named person's profile. */
export const ACCOUNT_KINDS = ["page", "person"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

/** The six figures LinkedIn shows under a post. Each is a count to date. */
export const FIGURES = ["impressions", "reactions", "comments", "reposts", "clicks", "followersGained"] as const;
export type Figure = (typeof FIGURES)[number];

export const FIGURE_LABELS: Record<Figure, string> = {
  impressions: "Impressions",
  reactions: "Reactions",
  comments: "Comments",
  reposts: "Reposts",
  clicks: "Clicks",
  followersGained: "Followers gained",
};

/** A post's hook: its first line. */
export const MAX_POST_TITLE = 200;
/** LinkedIn's own limit on a post's text. */
export const MAX_POST_BODY = 3_000;
export const MAX_PILLAR_LENGTH = 40;
export const MAX_LINK_LENGTH = 300;
/** A figure above this is a typing mistake. */
export const MAX_FIGURE = 1_000_000_000;
/** The most posts one company's list sends. Older ones fall off the page. */
export const POST_LIST_ROWS = 300;
/** The most snapshots one company's list sends. */
export const STATS_LIST_ROWS = 3_000;
/** The most posts per week a target can ask for. */
export const MAX_TARGET_PER_WEEK = 21;
/** A rate is given from this many impressions: below it a handful of likes reads as a trend. */
export const MIN_IMPRESSIONS_FOR_RATE = 100;
/** A scheduled post with no draft is flagged when it is this many days away or nearer. */
export const DRAFT_DUE_DAYS = 2;
/** The window of the stats panel. */
export const STATS_WINDOW_DAYS = 30;
/** Weeks shown in the cadence and growth charts, the week in progress included. */
export const CADENCE_WEEKS = 8;

export const LINKEDIN_WORDS = {
  postGone: "That post no longer exists.",
  needsTitle: "A post needs a hook.",
  postElsewhere: "A post cannot move to the other company.",
  nameOnly: "A person is a name only: leave out email addresses.",
  publishedOnly: "A publish time and a link belong to a published post.",
  needsPerson: "A post on a person's profile needs that person's name.",
  pageHasNoPerson: "A post on the company page names no person.",
  needsPlanned: "A scheduled post needs the time it is planned for.",
  needsPublished: "A published post needs the time it went out.",
  notADate: "That is not a date.",
  badLink: "A link is an https address on linkedin.com or lnkd.in.",
  figureRange: `A figure is a whole number from 0 to ${MAX_FIGURE.toLocaleString("en-US")}.`,
  noFigures: "Give at least one figure.",
  statsForPublished: "Figures are kept for a published post.",
  statsBeforePublished: "Those figures are dated before the post went out.",
  statsInFuture: "Those figures are dated after today.",
  badTarget: `A target is a whole number of posts a week, from 0 to ${MAX_TARGET_PER_WEEK}.`,
  tooLong: (what: string, max: number) => `${what} is too long (${max} characters at most).`,
} as const;

// ── Days and weeks ──────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const isDay = (value: string): boolean => DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

/** The UTC calendar day of an instant: what the server and the owner's agent use. */
export const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

export function addDays(day: string, days: number): string {
  return utcDay(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS);
}

/** The Monday on or before a day. */
export function mondayOf(day: string): string {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -((weekday + 6) % 7));
}

// ── Links ───────────────────────────────────────────────────────────────────

const LINK_HOSTS = ["linkedin.com", "lnkd.in"];

/**
 * A post's link as stored: an https address on LinkedIn, no credentials, no
 * fragment. Anything else is `null`: the page links to it, so a model's
 * "link" can never lead somewhere else.
 */
export function cleanLink(value: string): string | null {
  const text = value.trim();
  if (text.length > MAX_LINK_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const ours = LINK_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  if (url.protocol !== "https:" || !ours || url.username !== "" || url.password !== "") return null;
  url.hash = "";
  return url.toString();
}

// ── Rows, as the arithmetic reads them ──────────────────────────────────────

/** A figure that is missing is unknown, never zero. */
export type Figures = Record<Figure, number | null>;
export type Snapshot = { day: string } & Figures;

export type DatedPost = {
  id: string;
  company: CompanyId;
  account: AccountKind;
  person: string | null;
  status: PostStatus;
  title: string;
  hasBody: boolean;
  plannedDay: string | null;
  publishedDay: string | null;
  snapshots: readonly Snapshot[];
};

/** The latest snapshot (the figures are counts to date), or null. */
export function latestSnapshot(snapshots: readonly Snapshot[]): Snapshot | null {
  let latest: Snapshot | null = null;
  for (const snapshot of snapshots) if (latest === null || snapshot.day > latest.day) latest = snapshot;
  return latest;
}

/** (reactions + comments + reposts) / impressions, once all four are known and impressions is above zero. */
export function engagementRate(figures: Figures): number | null {
  const { impressions, reactions, comments, reposts } = figures;
  if (impressions === null || reactions === null || comments === null || reposts === null) return null;
  return impressions > 0 ? (reactions + comments + reposts) / impressions : null;
}

/** The day a post sits on the calendar: when it went out, else when it is planned. */
export const dayOnCalendar = (post: Pick<DatedPost, "plannedDay" | "publishedDay">): string | null =>
  post.publishedDay ?? post.plannedDay;

/** A post that counts toward a week having something in it. */
const COVERS_A_WEEK: ReadonlySet<PostStatus> = new Set(["draft", "scheduled", "published"]);

/** "Startup", "Globex" or a person's name. */
export function accountLabel(post: Pick<DatedPost, "account" | "person">, companyName: string): string {
  return post.account === "person" && post.person !== null ? post.person : companyName;
}

/** One key per account, for the filter: the page of a company, or a person of it. */
export const accountKey = (post: Pick<DatedPost, "company" | "account" | "person">): string =>
  post.account === "page" ? `${post.company}:page` : `${post.company}:person:${post.person ?? ""}`;

// ── The stats panel ─────────────────────────────────────────────────────────

export type WindowTotals = {
  from: string;
  to: string;
  /** Posts that went out in the window. */
  published: number;
  /** Of those, how many have any figures. */
  measured: number;
  /** The sum of each figure over the posts that have it; null when none has. */
  totals: Figures;
  /** Over the posts whose four figures are all known; null with none. */
  rate: number | null;
};

/** The last `days` days up to and including `today`: what went out, and what it did so far. */
export function windowTotals(posts: readonly DatedPost[], today: string, days = STATS_WINDOW_DAYS): WindowTotals {
  const from = addDays(today, -(days - 1));
  const inWindow = posts.filter(
    (post) => post.status === "published" && post.publishedDay !== null && post.publishedDay >= from && post.publishedDay <= today,
  );
  const totals = Object.fromEntries(FIGURES.map((figure) => [figure, null])) as Figures;
  let measured = 0;
  let engaged = 0;
  let seen = 0;
  for (const post of inWindow) {
    const latest = latestSnapshot(post.snapshots);
    if (latest === null) continue;
    measured += 1;
    for (const figure of FIGURES) {
      const value = latest[figure];
      if (value !== null) totals[figure] = (totals[figure] ?? 0) + value;
    }
    if (engagementRate(latest) !== null) {
      engaged += latest.reactions! + latest.comments! + latest.reposts!;
      seen += latest.impressions!;
    }
  }
  return { from, to: today, published: inWindow.length, measured, totals, rate: seen > 0 ? engaged / seen : null };
}

export type RankedPost = { id: string; title: string; rate: number; impressions: number };

/** Published posts by engagement rate, best first, from `MIN_IMPRESSIONS_FOR_RATE` impressions. */
export function topPosts(posts: readonly DatedPost[], limit = 5): RankedPost[] {
  const ranked: RankedPost[] = [];
  for (const post of posts) {
    if (post.status !== "published") continue;
    const latest = latestSnapshot(post.snapshots);
    if (latest === null || (latest.impressions ?? 0) < MIN_IMPRESSIONS_FOR_RATE) continue;
    const rate = engagementRate(latest);
    if (rate !== null) ranked.push({ id: post.id, title: post.title, rate, impressions: latest.impressions! });
  }
  return ranked.sort((a, b) => b.rate - a.rate || b.impressions - a.impressions || a.id.localeCompare(b.id)).slice(0, limit);
}

// ── Cadence and growth ──────────────────────────────────────────────────────

export type CadenceWeek = {
  weekStart: string;
  /** Went out this week. */
  published: number;
  /** Drafts and scheduled posts planned for this week. */
  planned: number;
  /** The week still running. */
  inProgress: boolean;
};

/** The last `weeks` weeks, Monday to Sunday, oldest first, the week of `today` last. */
export function cadenceWeeks(posts: readonly DatedPost[], today: string, weeks = CADENCE_WEEKS): CadenceWeek[] {
  const current = mondayOf(today);
  const starts = Array.from({ length: weeks }, (_, i) => addDays(current, -7 * (weeks - 1 - i)));
  return starts.map((weekStart) => {
    const end = addDays(weekStart, 6);
    const within = (day: string | null) => day !== null && day >= weekStart && day <= end;
    return {
      weekStart,
      published: posts.filter((post) => post.status === "published" && within(post.publishedDay)).length,
      planned: posts.filter((post) => (post.status === "draft" || post.status === "scheduled") && within(post.plannedDay)).length,
      inProgress: weekStart === current,
    };
  });
}

export type CadenceVerdict = {
  target: number;
  /** Posts a week over the finished weeks shown. */
  average: number;
  /** "met" at or above the target. */
  verdict: "met" | "below";
};

/** The finished weeks' average against a target, or null with no target or no finished week. */
export function cadenceVerdict(weeks: readonly CadenceWeek[], target: number | null): CadenceVerdict | null {
  const finished = weeks.filter((week) => !week.inProgress);
  if (target === null || finished.length === 0) return null;
  const average = finished.reduce((sum, week) => sum + week.published, 0) / finished.length;
  return { target, average, verdict: average >= target ? "met" : "below" };
}

export type GrowthWeek = { weekStart: string; impressions: number; followersGained: number };

/**
 * What the posts gained each week: the step between a post's consecutive
 * snapshots lands in the week of the later one (the first snapshot's whole
 * count lands in its own week). A figure revised down counts as no gain.
 */
export function growthWeeks(posts: readonly DatedPost[], today: string, weeks = CADENCE_WEEKS): GrowthWeek[] {
  const current = mondayOf(today);
  const rows = new Map<string, GrowthWeek>(
    Array.from({ length: weeks }, (_, i) => {
      const weekStart = addDays(current, -7 * (weeks - 1 - i));
      return [weekStart, { weekStart, impressions: 0, followersGained: 0 }];
    }),
  );
  for (const post of posts) {
    const ordered = [...post.snapshots].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    let before = null as Pick<Snapshot, "impressions" | "followersGained"> | null;
    for (const snapshot of ordered) {
      const row = rows.get(mondayOf(snapshot.day));
      if (row !== undefined) {
        row.impressions += Math.max((snapshot.impressions ?? 0) - (before?.impressions ?? 0), 0);
        row.followersGained += Math.max((snapshot.followersGained ?? 0) - (before?.followersGained ?? 0), 0);
      }
      before = {
        impressions: snapshot.impressions ?? before?.impressions ?? null,
        followersGained: snapshot.followersGained ?? before?.followersGained ?? null,
      };
    }
  }
  return [...rows.values()];
}

// ── Needs you ───────────────────────────────────────────────────────────────

export type NeedsItem = {
  id: string;
  severity: "overdue" | "due" | "empty";
  title: string;
  detail: string;
  href: string;
};

const SEVERITY_ORDER = { overdue: 0, due: 1, empty: 2 } as const;

/** "Oct 20" for a week's Monday. */
export function weekWords(weekStart: string): string {
  const [, month, day] = weekStart.split("-").map(Number);
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[month! - 1]} ${day}`;
}

/**
 * What waits on a person: a scheduled post with no draft that is `DRAFT_DUE_DAYS`
 * days away or nearer (or past, and still not out), and, for each company in
 * view, this week or next with no post planned in it.
 */
export function needsYou(
  posts: readonly DatedPost[],
  today: string,
  companies: readonly CompanyId[],
  names: Record<CompanyId, string>,
): NeedsItem[] {
  const items: NeedsItem[] = [];
  const horizon = addDays(today, DRAFT_DUE_DAYS);
  for (const post of posts) {
    if (post.status !== "scheduled" || post.hasBody || post.plannedDay === null || post.plannedDay > horizon) continue;
    items.push({
      id: `draft:${post.id}`,
      severity: post.plannedDay < today ? "overdue" : "due",
      title: `No draft for "${post.title}"`,
      detail: `${accountLabel(post, names[post.company])} · planned ${post.plannedDay}`,
      href: "/linkedin",
    });
  }
  const thisWeek = mondayOf(today);
  for (const company of companies) {
    for (const weekStart of [thisWeek, addDays(thisWeek, 7)]) {
      const end = addDays(weekStart, 6);
      const covered = posts.some((post) => {
        const day = dayOnCalendar(post);
        return post.company === company && COVERS_A_WEEK.has(post.status) && day !== null && day >= weekStart && day <= end;
      });
      if (covered) continue;
      items.push({
        id: `week:${company}:${weekStart}`,
        severity: "empty",
        title: `No post planned for the week of ${weekWords(weekStart)}`,
        detail: `${names[company]} · ${weekStart === thisWeek ? "this week" : "next week"}`,
        href: "/linkedin",
      });
    }
  }
  return items.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
