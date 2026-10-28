// "Suggest a change": the sidebar's dialog for teammates who do not code.
// What someone types becomes a card in the task board's Backlog, shared by
// both companies, so the people who do change the OS find it where they
// already look.
//
// Anyone with a page may send one, the board or not: a member without the
// board cannot read the card back (`tasks.board` is still the board's), and
// this mutation returns nothing about the board. A teammate with no page at
// all is refused, as everywhere.

import { ConvexError, v } from "convex/values";
import { memberMutation } from "./lib/owner";
import { periodStart } from "./lib/periods";
import { ANY_AREA } from "./lib/roles";
import {
  MAX_SUGGESTIONS_PER_DAY,
  SUGGESTION_SOURCE,
  SUGGESTION_WORDS,
  suggestionCard,
} from "./lib/suggestion";
import { PERSON_DUPLICATE_REASONS, createTask, nearMark, nearTasks } from "./tasks";

export const create = memberMutation(ANY_AREA)({
  args: { text: v.string(), page: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const card = suggestionCard(args.text, args.page);
    if (!card.ok) throw new ConvexError(SUGGESTION_WORDS[card.error]);

    // At most so many a day from one person. Their rows from earlier days
    // are of no more use and go as this one is counted.
    const now = Date.now();
    const day = periodStart("day", now);
    const userId = ctx.member.user._id;
    const sent = await ctx.db
      .query("suggestionsSent")
      .withIndex("by_userId_and_day", (q) => q.eq("userId", userId))
      .collect();
    let today = 0;
    for (const row of sent) {
      if (row.day === day) today += 1;
      else await ctx.db.delete(row._id);
    }
    if (today >= MAX_SUGGESTIONS_PER_DAY) throw new ConvexError(SUGGESTION_WORDS.too_many);
    await ctx.db.insert("suggestionsSent", { userId, day, at: now });

    // The board's one writer, at the bottom of Backlog: a shared card with
    // nobody on it, so nobody is told and no Telegram group hears of it. The
    // gate stays this file's (`ANY_AREA`): `createTask` asks for no area.
    // A near open card is not said back (the sender may not read the board):
    // the card is added and marked for whoever reads it there.
    const near = await nearTasks(ctx, null, { title: card.title, company: null, now });
    await createTask(
      ctx,
      ctx.member,
      { title: card.title, kind: "task", column: "backlog", ...(card.notes === undefined ? null : { notes: card.notes }), company: null },
      { origin: { source: SUGGESTION_SOURCE }, duplicate: nearMark(near, PERSON_DUPLICATE_REASONS.suggestion) },
    );
    return null;
  },
});
