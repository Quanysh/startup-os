import Google from "@auth/core/providers/google";
import { convexAuth } from "@convex-dev/auth/server";
import { googleProfile, resolveOwnerUser } from "./authOwner";
import type { MutationCtx } from "./_generated/server";

// Google sign-in only. There is deliberately no password or anonymous
// provider: the allow-list relies on claims only Google can make.
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  // googleProfile carries `email_verified` and `hd` through; Convex Auth's
  // default mapping would drop both before the callback below sees them.
  providers: [Google({ profile: googleProfile })],
  callbacks: {
    async createOrUpdateUser(ctx, args) {
      return await resolveOwnerUser((ctx as unknown as MutationCtx).db, {
        existingUserId: args.existingUserId,
        profile: args.profile,
      });
    },
  },
});
