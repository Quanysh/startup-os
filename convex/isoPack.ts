import { personOf } from "./evidence";
import { ISO_CONTROLS, ISO_ITEMS } from "./lib/isoPack";
import { memberMutation } from "./lib/owner";
import { anchorDayOf } from "./lib/recurrence";

/**
 * Add Globex's ISO 27001 pack to /compliance: the ISMS's recurring
 * duties, its open findings, and the applicable Annex A controls with the
 * evidence each still needs. Only for someone on Globex. Like the starter
 * checklist, an item or control already there is left exactly as it is, so
 * pressing the button twice adds nothing.
 */
export const add = memberMutation("compliance", "kz")({
  args: {},
  handler: async (ctx) => {
    const by = personOf(ctx.member);

    // What is already here, read once: one lookup a row would run past a
    // mutation's time limit on a pack this size.
    const seeded = new Set(
      (
        await ctx.db
          .query("obligations")
          .withIndex("by_seedKey", (q) => q.gte("seedKey", "iso-").lt("seedKey", "iso."))
          .collect()
      ).map((o) => o.seedKey),
    );
    const listed = new Set(
      (
        await ctx.db
          .query("complianceControls")
          .withIndex("by_framework_and_controlId", (q) => q.eq("framework", "iso27001"))
          .collect()
      ).map((c) => c.controlId),
    );

    let items = 0;
    for (const item of ISO_ITEMS) {
      if (seeded.has(item.seedKey)) continue;
      await ctx.db.insert("obligations", {
        seedKey: item.seedKey,
        category: item.category,
        title: item.title,
        note: item.note,
        due: item.due,
        // A date the documents imply is not a deadline until the owner says
        // it is: unconfirmed, it is never shown as due or overdue.
        dueConfirmed: false,
        anchorDay: item.due === undefined ? undefined : anchorDayOf(item.due),
        recurrence: item.recurrence ?? "none",
        status: "open",
      });
      items += 1;
    }

    let controls = 0;
    const at = Date.now();
    for (const control of ISO_CONTROLS) {
      if (listed.has(control.controlId)) continue;
      const id = await ctx.db.insert("complianceControls", {
        framework: "iso27001",
        controlId: control.controlId,
        title: control.title,
        changedBy: by,
        updatedAt: at,
      });
      // What would show the control works, still to find: missing until
      // someone links the record.
      for (const title of control.evidence ?? []) {
        await ctx.db.insert("evidenceItems", { controlId: id, title, status: "missing", changedBy: by, updatedAt: at });
      }
      controls += 1;
    }

    return { items, controls };
  },
});
