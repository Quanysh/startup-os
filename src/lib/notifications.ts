import type { FunctionReturnType } from "convex/server";
import type { api } from "@convex/_generated/api";
import { UNREAD_COUNT_CAP } from "@convex/lib/limits";
import { dayLabel } from "@/lib/format";
import { taskColumnTitle } from "@/lib/task-columns";

// The words of the notification center. The server sends what happened as
// data (convex/notifications.ts); how it reads is decided here, so a sentence
// is never built from stored text and a name is never more than text.

export type Notification = FunctionReturnType<typeof api.notifications.mine>["rows"][number];

/**
 * The owner's Claude, as a card and a notification name it: "Claude (for
 * Olga)" by the owner's first name where the viewer may be told it, else
 * "The owner's Claude". One wording for both (src/components/tasks/origin.tsx).
 */
export function agentName(ownerName: string | null): string {
  const first = ownerName?.trim().split(/\s+/)[0];
  return first ? `Claude (for ${first})` : "The owner's Claude";
}

/** Who did it: a name the viewer may be told, "A teammate", or the part of the OS that did. */
export function whoOf(actor: Notification["actor"]): string {
  switch (actor.type) {
    case "system":
      // "memory": the daily sweep of decisions due for a revisit, which is no person.
      return actor.source === "standup"
        ? "The standup"
        : actor.source === "memory"
          ? "Reminder:"
          : actor.source === "digest"
            ? "Approvals:"
            : "Telegram";
    case "agent":
      return agentName(actor.name);
    case "bot":
      // One of the owner's bots, by its profile's id.
      return actor.name;
    case "user":
      return actor.name ?? "A teammate";
  }
}

/**
 * A notification as a sentence in four parts, so the page can set the title
 * apart: "<who> <lead> <title><tail>". `now` decides whether a due date
 * needs its year.
 */
export function sentenceOf(
  row: Notification,
  now: number,
): { who: string; lead: string; title: string; tail: string } {
  const say = (lead: string, tail = "") => ({ who: whoOf(row.actor), lead, title: row.title, tail });
  switch (row.kind) {
    case "assigned":
      return say("gave you");
    case "reassigned":
      return say("moved", ` to ${row.to ?? "someone else"}`);
    case "unassigned":
      return say("took you off");
    case "mentioned":
      return say("mentioned you in");
    case "moved":
      return say("moved", row.column === null ? "" : ` to ${taskColumnTitle(row.column)}`);
    case "finished":
      return say("finished");
    case "due":
      return row.due === null
        ? say("cleared the due date of")
        : say("set", ` due ${dayLabel(row.due, now)}`);
    case "decision_revisit":
      return say("time to revisit");
    case "approvals_digest":
      return say("");
    case "handoff":
      return say("handed you");
  }
}

/** The badge on the bell: nothing for none, the count up to nine, then "9+". */
export function badgeText(count: number): string | null {
  if (count <= 0) return null;
  return count > 9 ? "9+" : String(count);
}

/** The bell's accessible name, with how many are unread once that is known. */
export function bellLabel(count: number | undefined): string {
  if (count === undefined) return "Notifications";
  if (count === 0) return "Notifications, none unread";
  // The server stops counting at the cap, so at the cap it is "at least".
  if (count >= UNREAD_COUNT_CAP) return `Notifications, ${UNREAD_COUNT_CAP - 1}+ unread`;
  return `Notifications, ${count} unread`;
}
