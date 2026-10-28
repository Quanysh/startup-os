// A stored role read for what it is called and what it arranges. Runs only
// inside Convex. The three built-in roles are resolved here, in code: they are
// not rows, so a deployment needs no first write and no row from before roles
// could be named needs migrating. A role the owner named is a row of `roles`,
// read each time: a rename or a change of focus shows at once, everywhere.
//
// Nothing here says what anyone may do. That is `effectiveAreas`.

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { focusOf, type Focus } from "./focus";
import { CUSTOM_ROLE, ROLE_LABELS, roleKind } from "./roles";

export type ShownRole = {
  /** Its name: a built-in's, the owner's own words, or "No role" where the row is gone. */
  name: string;
  focus: Focus;
};

/** A teammate's role, as their row stores it, by name and focus. */
export async function shownRole(
  db: QueryCtx["db"],
  stored: Doc<"members">["role"],
): Promise<ShownRole> {
  const kind = roleKind(stored);
  if (kind !== CUSTOM_ROLE) return { name: ROLE_LABELS[kind], focus: focusOf(kind) };
  const row = await db.get(stored as Id<"roles">);
  return { name: row?.name ?? ROLE_LABELS.custom, focus: focusOf(CUSTOM_ROLE, row) };
}
