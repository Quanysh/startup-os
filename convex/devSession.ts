// `pnpm dev:signin`: a session on a LOCAL backend for a made-up person, so a
// page can be looked at as the owner or as a teammate without Google sign-in
// (which a local backend has no client for).
//
// It makes a user, a `members` row for a teammate, a session and a refresh
// token, and returns their ids; scripts/dev/signin.ts signs the token with
// the local backend's own key. It refuses to run anywhere but a local
// development backend, by the backend's own environment
// (convex/lib/devLocal.ts): on a cloud deployment it throws before writing a
// row. It takes no address: the only people it can sign in are the made-up
// local ones (`localEmail`), who exist nowhere else. Internal, so no browser
// can call it.

import { ConvexError, v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { memberByEmail } from "./authOwner";
import { localUser } from "./devSeed";
import {
  LOCAL_COMPANY_CHOICES,
  LOCAL_OWNER_EMAIL,
  LOCAL_ROLES,
  localEmail,
  refusalHere,
} from "./lib/devLocal";
import { seedRoles } from "./devSeed";
import { isSeedRole, localName, seedMember } from "./lib/devSeedData";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a local session lasts. */
const SESSION_DAYS = 30;

export const create = internalMutation({
  args: {
    role: v.union(...LOCAL_ROLES.map((role) => v.literal(role))),
    companies: v.union(...LOCAL_COMPANY_CHOICES.map((choice) => v.literal(choice))),
  },
  returns: v.object({
    email: v.string(),
    userId: v.string(),
    sessionId: v.string(),
    refreshTokenId: v.string(),
    /** The local backend's own site address: the token's issuer. */
    issuer: v.string(),
  }),
  handler: async (ctx, args) => {
    const refused = refusalHere();
    if (refused !== null) throw new ConvexError(refused);
    // The owner is on both companies, whatever was asked.
    const companies = args.role === "owner" ? "both" : args.companies;
    const email = localEmail(args.role, companies);
    const userId = await localUser(ctx, email, localName(args.role, companies));

    // A teammate needs their row. One that is already there is left as it is:
    // the pages ticked for them locally are part of what is being looked at.
    if (args.role !== "owner" && (await memberByEmail(ctx.db, email)) === null) {
      const person = { role: args.role, companies, name: localName(args.role, companies) };
      const ownerId = await localUser(ctx, LOCAL_OWNER_EMAIL, localName("owner", "both"));
      // A role the made-up owner named: its row, made here if the seed has not run.
      const role = isSeedRole(args.role) ? (await seedRoles(ctx, ownerId))[args.role] : args.role;
      await ctx.db.insert("members", {
        ...seedMember(person, role),
        addedAt: Date.now(),
        addedBy: ownerId,
      });
    }

    const expirationTime = Date.now() + SESSION_DAYS * DAY_MS;
    const sessionId = await ctx.db.insert("authSessions", { userId, expirationTime });
    const refreshTokenId = await ctx.db.insert("authRefreshTokens", { sessionId, expirationTime });
    return { email, userId, sessionId, refreshTokenId, issuer: process.env.CONVEX_SITE_URL ?? "" };
  },
});
