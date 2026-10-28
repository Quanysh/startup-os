// What people are told about the board. One function, called by every
// mutation that makes or changes a task, inside that mutation: the rows it
// writes cannot drift from the task, and a new way to change a task that
// forgets to call it tells nobody (convex/notifications.test.ts lists them).
//
// It decides who is told by comparing the task as it was with the task as it
// now is, so no caller says what happened. Nobody is ever told of what they
// did themselves.
//
//   assigned     the task now has a holder who is not who held it before
//   reassigned   it went from you to somebody else
//   unassigned   it went from you to nobody
//   mentioned    a save named you (the caller passes who: convex/tasks.ts)
//   moved        a task you still hold changed column
//   due          a task you still hold had its due date set, changed or cleared
//   finished     a task you made went to Done, and you are not its holder
//                (who is told that it moved)
//
// Someone handed a task is told that once, not also where it now is and when
// it is due. A row holds ids, the title as it was and nothing else about a
// person: names are looked up when it is read (convex/notifications.ts).
// Nothing here logs, and nothing here throws a title.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { MAX_NOTIFICATIONS, MAX_TITLE_LENGTH } from "./limits";

type Task = Doc<"tasks">;
type Row = Doc<"notifications">;
export type NotificationActor = Row["actor"];

/**
 * The `users` row behind an address: the one row that holds it, or null when
 * nobody has signed in with it yet (there is then nowhere to tell them) or
 * more than one row does (it is then nobody's, as for personal records).
 */
export async function userOfAddress(
  db: QueryCtx["db"],
  email: string | undefined,
): Promise<Id<"users"> | null> {
  if (email === undefined) return null;
  const users = await db
    .query("users")
    .withIndex("email", (q) => q.eq("email", email))
    .take(2);
  return users.length === 1 ? users[0]!._id : null;
}

/** Rows over the cap that one write deletes. A person is over by one row at most. */
const PRUNE_BATCH = 20;

/** Keep a person's newest MAX_NOTIFICATIONS. Bounded: one read of the cap and a little more. */
export async function keepNewest(ctx: MutationCtx, recipient: Id<"users">) {
  const rows = await ctx.db
    .query("notifications")
    .withIndex("by_recipient_and_createdAt", (q) => q.eq("recipient", recipient))
    .order("desc")
    .take(MAX_NOTIFICATIONS + PRUNE_BATCH);
  for (const row of rows.slice(MAX_NOTIFICATIONS)) await ctx.db.delete(row._id);
}

/**
 * Tell whoever a change to a task concerns. Call it once the task is written.
 *
 * `before` is the task as it was (null for one just made), `actor` who did
 * it, and `mentioned` the people this save newly mentions, already checked.
 */
export async function notifyTaskChange(
  ctx: MutationCtx,
  change: {
    taskId: Id<"tasks">;
    before: Task | null;
    actor: NotificationActor;
    mentioned?: readonly Id<"users">[];
  },
): Promise<void> {
  const after = await ctx.db.get(change.taskId);
  if (after === null) return;
  const { before, actor } = change;
  // An agent acts for its owner, who is told of its work no more than of their own.
  const actorId = actor.type === "user" || actor.type === "agent" ? actor.userId : null;
  const now = Date.now();
  const told = new Set<Id<"users">>();

  const tell = async (
    recipient: Id<"users"> | null | undefined,
    kind: Row["kind"],
    detail: Pick<Row, "column" | "to" | "due"> = {},
  ) => {
    if (recipient == null || recipient === actorId) return;
    await ctx.db.insert("notifications", {
      recipient,
      kind,
      actor,
      taskId: after._id,
      ...(after.company === undefined ? null : { company: after.company }),
      title: after.title.slice(0, MAX_TITLE_LENGTH),
      ...detail,
      createdAt: now,
    });
    told.add(recipient);
  };

  const holder = await userOfAddress(ctx.db, after.assignee);
  if (after.assignee !== before?.assignee) {
    await tell(holder, "assigned");
    if (before?.assignee !== undefined) {
      const was = await userOfAddress(ctx.db, before.assignee);
      if (after.assignee === undefined) await tell(was, "unassigned");
      else await tell(was, "reassigned", holder === null ? {} : { to: holder });
    }
  } else if (before !== null) {
    if (after.column !== before.column) await tell(holder, "moved", { column: after.column });
    if (after.due !== before.due) await tell(holder, "due", { due: after.due ?? null });
  }

  if (
    before !== null &&
    after.column === "done" &&
    before.column !== "done" &&
    after.createdBy !== holder
  ) {
    await tell(after.createdBy, "finished");
  }

  for (const person of new Set(change.mentioned)) await tell(person, "mentioned");

  for (const recipient of told) await keepNewest(ctx, recipient);
}
