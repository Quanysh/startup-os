// How the Assistant page shows the owner's chat. The limits, the closed sets
// and every fixed sentence are convex/lib/chatRules.ts (pure, and what the
// server enforces): this path re-exports them, and adds how an answer's text,
// its steps and the runner's state are put into words. Pure: what depends on
// "now" takes it.
//
// **An answer was written by a model. It is data.** It is shown as text, its
// lines kept. The one thing made of it is a link, and only where a path from
// the closed list of the app's own pages stands as a word of its own: never
// an address the answer gives, never markup.

import { CHAT_PAGES, STEP_LABELS, isChatTool, runnerIsThere } from "@convex/lib/chatRules";
import { PRODUCT } from "@convex/lib/identity";
import { whenWritten } from "./words";

export * from "@convex/lib/chatRules";

export type ChatPage = (typeof CHAT_PAGES)[number];
export type TextPart = { text: string } | { page: ChatPage };

/** The pages an answer may link, longest first. The Dashboard's bare "/" is never one: a slash is too often just a slash. */
const LINKED = CHAT_PAGES.filter((page) => page !== "/").sort((a, b) => b.length - a.length);
/**
 * A page's path as a word of its own: after the start, a space, a bracket or
 * a quote; before the end or a space, with only closing punctuation between.
 */
const PAGE_WORD = new RegExp(
  `(?<=^|[\\s("'])(${LINKED.map((page) => page.replace("/", "\\/")).join("|")})(?=[.,;:!?)"']*(?:\\s|$))`,
  "g",
);

/** An answer as pieces of text and links to the app's own pages, in order. Joined back, it is the answer. */
export function textParts(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let from = 0;
  for (const match of text.matchAll(PAGE_WORD)) {
    if (match.index > from) parts.push({ text: text.slice(from, match.index) });
    parts.push({ page: match[1] as ChatPage });
    from = match.index + match[1]!.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from) });
  return parts;
}

/** The steps as chips: each tool once, in the order first used, with how often. */
export function stepChips(steps: readonly string[]): { label: string; times: number }[] {
  const chips = new Map<string, number>();
  for (const step of steps) {
    if (isChatTool(step)) chips.set(STEP_LABELS[step], (chips.get(STEP_LABELS[step]) ?? 0) + 1);
  }
  return [...chips].map(([label, times]) => ({ label, times }));
}

/** The line over the chat: whether the Mac is answering, or since when it has not been. */
export function runnerLine(
  runner: { checkedInAt: number | null; everyMs: number | null },
  now: number,
): { there: boolean; text: string } {
  if (runnerIsThere(runner, now)) {
    const every = Math.round((runner.everyMs ?? 0) / 1000);
    return {
      there: true,
      text:
        every > 5
          ? `Answered by Claude on your Mac. It is idle and checks every ${every} seconds, so an answer may take that long to start.`
          : "Answered by Claude on your Mac.",
    };
  }
  const since =
    runner.checkedInAt === null
      ? "has never checked in"
      : `has not checked in since ${whenWritten(runner.checkedInAt, now).replace(/^(at|on) /, "")}`;
  return { there: false, text: `Your Mac ${since}. Questions wait until it does.` };
}

export const RUNNER_COMMAND = "pnpm assistant:runner";
export const RUNNER_INSTALL_COMMAND = "pnpm assistant:runner:install";

/** "How this works", a paragraph an entry. */
export const HOW_IT_WORKS = [
  `Your question is stored in ${PRODUCT.name} and waits. A small program on your Mac, the runner, picks it up and has Claude Code answer it there, on the Claude subscription your Mac is signed in to. There is no model key on the server, and the server calls no model.`,
  "Claude reads the OS through the same connection and token as the rest of your Claude (Connect Claude, below), with the read tools only. It changes nothing itself: a change it suggests shows as a card under its answer, and happens only when you approve it.",
  "What passes through Claude to answer you: your question, and what the tools return for it. That can include task titles, deal and clinic names, pull-request titles, metric values, and the decisions and meeting notes kept in Memory (cut short, with no attendees). Never payroll, tokens, mail or calendar: the server does not offer them to any token.",
  `To start it, run ${RUNNER_COMMAND} in the repository on your Mac and leave it running. To have it start at every login, run ${RUNNER_INSTALL_COMMAND} once and then the command it prints.`,
  "If your Mac is asleep or the runner is not running, a question waits. If Claude is signed out or out of usage, the answer says so.",
] as const;
