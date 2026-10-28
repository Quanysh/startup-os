import { ConvexError, v } from "convex/values";
import { categoryServesAny } from "./lib/company";
import { starterItems } from "./lib/obligationSeed";
import { memberMutation } from "./lib/owner";
import { isCanonicalPeriodStart } from "./lib/periods";
import { anchorDayOf } from "./lib/recurrence";

/**
 * Add the starter checklist to /compliance. Run only when the owner asks.
 * An item already there (by its seed key) is left exactly as the owner has
 * it, so pressing the button twice adds nothing.
 */
export const add = memberMutation("compliance")({
  args: {
    /** The owner's calendar date: decides which March 1 is next. */
    today: v.string(),
  },
  handler: async (ctx, args) => {
    if (!isCanonicalPeriodStart("day", args.today)) {
      throw new ConvexError("Today's date did not arrive as a date.");
    }
    let added = 0;
    for (const item of starterItems(args.today)) {
      // Only what the caller's companies have. The owner, or someone on the
      // other company, pressing the button later adds the rest.
      if (!categoryServesAny(ctx.member.companies, item.category)) continue;
      const existing = await ctx.db
        .query("obligations")
        .withIndex("by_seedKey", (q) => q.eq("seedKey", item.seedKey))
        .first();
      if (existing !== null) continue;
      await ctx.db.insert("obligations", {
        seedKey: item.seedKey,
        category: item.category,
        title: item.title,
        note: item.note,
        due: item.due,
        // Nothing the checklist adds is a deadline yet. The one dated item's
        // date was read off the page `sourceUrl` names, but whether it applies
        // to this company is the owner's to say: it stays unconfirmed, and so
        // is never shown as due or overdue, until the owner confirms it.
        dueConfirmed: false,
        anchorDay: item.due === undefined ? undefined : anchorDayOf(item.due),
        recurrence: item.recurrence ?? "none",
        status: "open",
        sourceUrl: item.sourceUrl,
      });
      added += 1;
    }
    return { added };
  },
});
