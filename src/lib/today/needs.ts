// "Needs you": one ranked list of what waits on the viewer, merged from what
// the old Dashboard's "Needs attention" and Today's "Waiting on you" each
// listed. Pure: every list is handed in already read and already narrowed to
// what the viewer may see (each by its own page's rules), so nothing here can
// show a row the server did not send. Counts for deals, clinics and
// obligations stay counts: the attention items name none of them.
//
// Most urgent first. Within a tier the lists keep the order given, which is
// each list's own (oldest due first, worst attention first):
//
//   0  late        my overdue tasks, failed sources, overdue obligations
//   1  today       open proposals, customers waiting on a person (Support),
//                  a bot refused often in the hour, my tasks due today,
//                  what is at risk
//   2  waiting     reviews asked of me, unread notifications, decisions to
//                  revisit, tasks just given me, what is due soon
//   3  stale       figures and pipelines gone quiet
//   4  missing     figures and dates never entered
//
// Said once: a notification about a task already listed, or a revisit
// reminder for a decision already listed, is left to that row.

import { ageLabel } from "@/lib/freshness";
import { dayLabel } from "@/lib/format";
import { FIN_RESULT_WORDS, type FinResult } from "@convex/lib/supportMetrics";
import type { AttentionItem } from "@/lib/metrics/scorecard";
import { durationWords, pageAreaWords } from "@/lib/support/words";

export type NeedKind = "task" | "approval" | "notification" | "revisit" | "review" | "attention" | "support" | "bot";
export type NeedTone = "danger" | "watch" | "brand" | "quiet";

export type Need = {
  /** `<kind>:<the source's own id>`: unique on the list. */
  id: string;
  kind: NeedKind;
  /** The source row's own id, for a row that acts on it. */
  ref: string;
  tier: 0 | 1 | 2 | 3 | 4;
  /** What it is. Typed or sent text: rendered as text. */
  title: string;
  /** Why it is urgent: its due date or its age. */
  why: string;
  /** Where it is acted on; null where the viewer has nowhere to open. */
  href: string | null;
  /** The action's words. */
  action: string;
  tone: NeedTone;
};

export type NeedsInput = {
  attention: readonly AttentionItem[];
  /** The owner's open proposals (none for anyone else). `text` is the proposal as a sentence. */
  approvals: readonly { id: string; text: string; createdAt: number; href: string }[];
  /** Unread notifications, newest first. `text` is the notification as a sentence. */
  notifications: readonly {
    id: string;
    text: string;
    createdAt: number;
    taskId: string | null;
    decisionId: string | null;
    href: string | null;
  }[];
  /** The viewer's own tasks: overdue or due today, and those just given them. */
  tasks: {
    due: readonly { id: string; title: string; due: string; when: "overdue" | "today" }[];
    fresh: readonly { id: string; title: string; createdAt: number }[];
  };
  /** The viewer's own decisions due for a revisit. */
  revisits: readonly { id: string; title: string; revisitOn: string }[];
  /** Pull requests that ask the viewer to review. */
  reviews: readonly { id: string; title: string; href: string | null }[];
  /**
   * Globex's customers who had waited on a person more than four hours at
   * Intercom's last push (`needsYou`), the longest first; none for a viewer
   * without Support or without Globex in view. `href` is the chat in
   * Intercom, or null without the workspace's id.
   */
  support: readonly { id: string; waitedMs: number; pageArea: string | null; fin: FinResult; href: string | null }[];
  /**
   * The owner's bots refused more than `REFUSALS_ALERT` times in the last hour
   * (`bots.refusedLately`); none for anyone else.
   */
  bots?: readonly { id: string; name: string; refusals: number }[];
  now: number;
};

const ATTENTION: Record<AttentionItem["severity"], { tier: Need["tier"]; tone: NeedTone }> = {
  error: { tier: 0, tone: "danger" },
  overdue: { tier: 0, tone: "danger" },
  risk: { tier: 1, tone: "danger" },
  due: { tier: 2, tone: "watch" },
  stale: { tier: 3, tone: "watch" },
  empty: { tier: 4, tone: "quiet" },
};

export function rankNeeds(input: NeedsInput): Need[] {
  const { now } = input;
  const taskHref = (id: string) => `/board?task=${id}`;
  const listedTasks = new Set([...input.tasks.due, ...input.tasks.fresh].map((task) => task.id));
  const listedDecisions = new Set(input.revisits.map((row) => row.id));

  const rows: Need[] = [
    ...input.tasks.due.map(
      (task): Need => ({
        id: `task:${task.id}`,
        kind: "task",
        ref: task.id,
        tier: task.when === "overdue" ? 0 : 1,
        title: task.title,
        why: task.when === "overdue" ? `Overdue, was due ${dayLabel(task.due, now)}` : "Due today",
        href: taskHref(task.id),
        action: "Open",
        tone: task.when === "overdue" ? "danger" : "watch",
      }),
    ),
    ...input.approvals.map(
      (row): Need => ({
        id: `approval:${row.id}`,
        kind: "approval",
        ref: row.id,
        tier: 1,
        title: row.text,
        why: `Proposed ${ageLabel(now, row.createdAt)}`,
        href: row.href,
        action: "Review",
        tone: "brand",
      }),
    ),
    ...input.support.map(
      (wait): Need => ({
        id: `support:${wait.id}`,
        kind: "support",
        ref: wait.id,
        tier: 1,
        // Never a word of the chat: what it is, how long, where, and what Fin did.
        title: "A customer is waiting on a person",
        why: [
          `Waited ${durationWords(wait.waitedMs)} at the last push`,
          ...(wait.pageArea === null ? [] : [pageAreaWords(wait.pageArea)]),
          FIN_RESULT_WORDS[wait.fin],
        ].join(" · "),
        href: wait.href,
        action: "Open in Intercom",
        tone: "danger",
      }),
    ),
    ...(input.bots ?? []).map(
      (bot): Need => ({
        id: `bot:${bot.id}`,
        kind: "bot",
        ref: bot.id,
        tier: 1,
        // The owner's words for the bot, and a count: nothing a call sent.
        title: `${bot.name} was refused ${bot.refusals} times in the last hour`,
        why: "Its permissions or limits may need a look",
        href: "/agents?view=bots",
        action: "Open",
        tone: "watch",
      }),
    ),
    ...input.attention.map((item): Need => {
      const { tier, tone } = ATTENTION[item.severity];
      return {
        id: `attention:${item.id}`,
        kind: "attention",
        ref: item.id,
        tier,
        title: item.title,
        why: item.detail,
        href: item.href,
        action: "Open",
        tone,
      };
    }),
    ...input.reviews.map(
      (pull): Need => ({
        id: `review:${pull.id}`,
        kind: "review",
        ref: pull.id,
        tier: 2,
        title: pull.title,
        why: "You are asked to review",
        href: pull.href,
        action: "Review",
        tone: "brand",
      }),
    ),
    ...input.notifications
      .filter(
        (row) =>
          !(row.taskId !== null && listedTasks.has(row.taskId)) &&
          !(row.decisionId !== null && listedDecisions.has(row.decisionId)),
      )
      .map(
        (row): Need => ({
          id: `notification:${row.id}`,
          kind: "notification",
          ref: row.id,
          tier: 2,
          title: row.text,
          why: ageLabel(now, row.createdAt),
          href: row.href,
          action: "Open",
          tone: "brand",
        }),
      ),
    ...input.revisits.map(
      (row): Need => ({
        id: `revisit:${row.id}`,
        kind: "revisit",
        ref: row.id,
        tier: 2,
        title: row.title,
        why: `To revisit since ${dayLabel(row.revisitOn, now)}`,
        href: `/memory?decision=${row.id}`,
        action: "Revisit",
        tone: "brand",
      }),
    ),
    ...input.tasks.fresh.map(
      (task): Need => ({
        id: `task:${task.id}`,
        kind: "task",
        ref: task.id,
        tier: 2,
        title: task.title,
        why: "New for you",
        href: taskHref(task.id),
        action: "Open",
        tone: "brand",
      }),
    ),
  ];

  const seen = new Set<string>();
  const unique = rows.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
  // Stable: rows of one tier and one place keep each list's own order.
  return unique.sort((a, b) => a.tier - b.tier || place(a) - place(b));
}

/**
 * Within a tier, the viewer's own first: their late task before a failed
 * source, a proposal before a task due today, and the company's attention
 * items after what is the viewer's.
 */
function place(need: Need): number {
  switch (need.kind) {
    case "task":
      return need.tier === 0 ? 0 : need.tier === 1 ? 2 : 6;
    case "approval":
      return 1;
    // A customer waiting, after the owner's proposals and before their own tasks due today.
    case "support":
      return 1.5;
    // A bot refused often, after a customer waiting and before the owner's own tasks due today.
    case "bot":
      return 1.7;
    case "review":
      return 3;
    case "notification":
      return 4;
    case "revisit":
      return 5;
    case "attention":
      return 7;
  }
}
