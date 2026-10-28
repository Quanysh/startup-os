import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// Native declarative crons: they ship with every function push, so there is
// no registration step to forget and nothing that can go dormant at runtime.
const crons = cronJobs();

crons.weekly(
  "prune sync run log",
  { dayOfWeek: "sunday", hourUTC: 3, minuteUTC: 0 },
  internal.sources.pruneRuns,
);

// 06:00 UTC is the small hours in the US, after the previous day has posted.
// Daily use also keeps the token alive: Mercury deletes one unused for 45 days.
crons.daily("sync mercury", { hourUTC: 6, minuteUTC: 0 }, internal.connectors.mercury.sync, {});

// The product sources store only weeks that have ended, so once a day is
// enough: Monday's run brings the week that just closed, and the rest re-read
// the last eight for late events. After Mercury, ten minutes apart. Globex
// AI's PostHog read is the heavy one and shares 06:30 with Vertical: 06:20 is
// Vercel's minute.
crons.daily("sync posthog", { hourUTC: 6, minuteUTC: 10 }, internal.connectors.posthog.sync, {});
crons.daily("sync vercel", { hourUTC: 6, minuteUTC: 20 }, internal.connectors.vercel.sync, {});
crons.daily(
  "sync vertical startup",
  { hourUTC: 6, minuteUTC: 30 },
  internal.connectors.verticalHealth.sync,
  {},
);
crons.daily("sync posthog globex", { hourUTC: 6, minuteUTC: 30 }, internal.connectors.posthogGlobex.sync, {});

// Apollo counts to date. One read a day keeps the current week's bucket current.
crons.daily("sync apollo", { hourUTC: 6, minuteUTC: 20 }, internal.connectors.apollo.sync, {});

// 12:00 UTC is early morning Pacific, the day Google's dates are in. Its
// figures arrive two to three days late whatever the hour.
crons.daily(
  "sync search console",
  { hourUTC: 12, minuteUTC: 0 },
  internal.connectors.searchConsole.sync,
  {},
);

// Work tools (Phase 8). Short intervals: this is the owner's day, not a monthly figure.
crons.interval("sync gmail", { minutes: 15 }, internal.connectors.gmail.sync, {});
crons.interval("sync google calendar", { minutes: 15 }, internal.connectors.googleCalendar.sync, {});
crons.interval("sync linear", { minutes: 15 }, internal.connectors.linear.sync, {});
crons.interval("sync fireflies", { hours: 1 }, internal.connectors.fireflies.sync, {});
crons.daily("prune work tool records", { hourUTC: 3, minuteUTC: 30 }, internal.mirror.prune, {});
// Teammates' own records, apart from the owner's: a run that has more to do
// than its budget schedules its own next one, and can never hold the line above up.
crons.daily(
  "prune personal records",
  { hourUTC: 3, minuteUTC: 40 },
  internal.mirror.prunePersonal,
  {},
);
// Notifications older than sixty days (convex/notifications.ts), a batch at a time.
crons.daily("prune notifications", { hourUTC: 3, minuteUTC: 50 }, internal.notifications.prune, {});
// What the owner's agent called (convex/assistant.ts): the newest 500 rows and thirty days.
crons.daily("prune agent calls", { hourUTC: 4, minuteUTC: 0 }, internal.assistant.prune, {});
// OAuth sign-ins (convex/oauth.ts): spent codes, dead tokens and grants, clients never approved.
crons.daily("prune oauth sign-ins", { hourUTC: 4, minuteUTC: 30 }, internal.oauth.prune, {});
// The projects' agents' run summaries (Protocol v1.3): ninety days from when each started.
crons.daily("prune agent runs", { hourUTC: 4, minuteUTC: 10 }, internal.agentProjects.purgeRuns, {});

// The agents Startup OS runs itself (convex/agentRuntime.ts): each one whose schedule is
// due is started once for that minute, and a run whose action died is ended.
crons.interval("run startup os agents", { minutes: 1 }, internal.agentRuntime.tick, {});
// Their answers, finished runs and decided approvals: ninety days, like the run summaries.
crons.daily("prune startup os agent runs", { hourUTC: 4, minuteUTC: 20 }, internal.agentRuntime.purge, {});

// What the agents wrote (convex/assistant.ts): open proposals a week old are marked
// expired; briefs, decided proposals and answered questions go after ninety days.
crons.daily("sweep agent work", { hourUTC: 4, minuteUTC: 10 }, internal.assistant.sweep, {});

// Company memory (convex/decisions.ts): decisions whose revisit date has come
// are marked and their owner told once. Early UTC, before the US morning.
crons.daily("mark decisions to revisit", { hourUTC: 5, minuteUTC: 0 }, internal.decisions.markRevisits, {});

// The owner's approvals digest (convex/approvalsDigest.ts): 09:00 Asia/Almaty, in their own
// Telegram chat and the app. Once a day; nothing when nothing waits.
crons.daily("approvals digest", { hourUTC: 4, minuteUTC: 0 }, internal.approvalsDigest.run, {});

// The bots' requests for a fix (convex/devRequests.ts): files what still waits for a GitHub
// issue and reads the open ones' answers back, at most 20 a run. A no-op until
// GITHUB_ISSUES_TOKEN is set.
crons.interval("check bot dev requests", { minutes: 10 }, internal.devRequests.check, {});

export default crons;
