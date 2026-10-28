import { getAuthUserId } from "@convex-dev/auth/server";
import { query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { focusOf } from "./lib/focus";
import { getMember } from "./lib/owner";
import { shownRole } from "./lib/roleRows";
import { ROLE_LABELS } from "./lib/roles";

// The one public function that does not throw for someone who is not let in:
// the app shell needs to tell "signed out", "signed in but not allowed" and
// "a member" apart to show the right screen. It returns nothing about the
// company, and about the caller only what they are: their own profile, role,
// companies and the areas the owner gave them. The UI shows and hides with these;
// every function still checks for itself. With the role come its name and its
// focus (what the Dashboard and Today pages are arranged for): both are for
// the eye and decide nothing a function allows.
export const me = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const member = await getMember(ctx);
    if (member === null) return { isOwner: false as const, isMember: false as const };
    const role =
      member.named === undefined
        ? // The owner, or a built-in role. An id with no row behind it reads "No role".
          { name: ROLE_LABELS[member.role], focus: focusOf(member.role) }
        : await shownRole(ctx.db, member.named as Doc<"members">["role"]);
    return {
      isOwner: member.role === "owner",
      isMember: true as const,
      role: member.role,
      /** What their role is called: a built-in's name, or the owner's words. */
      roleName: role.name,
      /** What their Dashboard and Today are arranged for. Never access. */
      focus: role.focus,
      companies: [...member.companies],
      areas: [...member.areas],
      email: member.user.email ?? null,
      name: member.user.name ?? null,
      image: member.user.image ?? null,
    };
  },
});
