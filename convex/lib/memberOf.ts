// A person as the gate would see them, without a session: for the two callers
// that hold no browser session but act as someone the OS lets in. The
// Telegram webhook (convex/telegramInbound.ts) resolves whoever wrote in a
// group; the owner's agent endpoint (convex/mcp.ts) resolves the owner behind
// an agent token. Both then use the app's own checks and write helpers.
//
// It mirrors `getMember` (convex/lib/owner.ts): change one, change the other.

import type { QueryCtx } from "../_generated/server";
import { hasOwner, isOwnerEmail, memberByEmail } from "../authOwner";
import { companyIds, isCompanyId } from "./company";
import type { Member } from "./owner";
import { effectiveAreas, ownerAreas, roleKind } from "./roles";

/**
 * The person as the gate would see them, had they called from the browser:
 * `getMember` without a session. Null for anyone it would refuse, and for a
 * teammate who has never signed in (a card needs a user to have made it).
 */
export async function memberOf(ctx: QueryCtx, email: string): Promise<Member | null> {
  if (!hasOwner()) return null;
  const user = await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", email))
    .first();
  if (user === null || !user.emailVerificationTime) return null;
  if (isOwnerEmail(email)) return { user, role: "owner", companies: companyIds(), areas: ownerAreas() };
  const row = await memberByEmail(ctx.db, email);
  if (row === null) return null;
  return {
    user,
    role: roleKind(row.role),
    companies: row.companies.filter(isCompanyId),
    areas: effectiveAreas(row.role, row.areas),
  };
}
