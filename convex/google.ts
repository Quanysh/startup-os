// The Google grant: making it, keeping it sealed, giving it up.
//
// The stored token is read in exactly one place, `sealedToken` (internal;
// ciphertext for the two Google connectors). `connection` returns only
// whether a row exists and when it was made. (convex/mirror.ts also asks
// whether a row exists, and nothing more, before writing Google's records.)

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import {
  httpAction,
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { googleVouchesFor, isOwnerEmail } from "./authOwner";
import {
  GOOGLE_SCOPES,
  GOOGLE_TOKEN_PURPOSE,
  GOOGLE_TOKEN_URL,
  parseGrant,
} from "./connectors/googleParse";
import { ask } from "./connectors/request";
import { PRODUCT } from "./lib/identity";
import { ownerMutation, ownerQuery } from "./lib/owner";
import { keyProblem, open, seal } from "./lib/tokenCrypto";
import { GOOGLE_SOURCES } from "./lib/mirrorRules";
import {
  CONNECT_GOOGLE_MESSAGE,
  GOOGLE_REMOVED_MESSAGE,
  REVOKE_UNCONFIRMED_MESSAGE,
  deleteRecords,
  markNotConfigured,
} from "./mirror";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
/** The one path Google may return the browser to. Never built from a request. */
const CALLBACK_PATH = "/google/callback";
/** The one page the callback sends the browser on to. */
const SETTINGS_PATH = "/settings/connections";

const STATE_TTL_MS = 10 * 60 * 1000;
/** How often Google is asked to revoke a grant before the owner is told to do it. */
const REVOKE_TRIES = 3;
const REVOKE_RETRY_MS = 30_000;
/** The provider id Convex Auth files the sign-in account under (convex/auth.ts). */
const SIGN_IN_PROVIDER = "google";
/** 32 random bytes in base64url is 43 characters; PKCE allows up to 128. */
const NONCE = /^[A-Za-z0-9_-]{43,128}$/;
const MAX_CODE_LENGTH = 2048;

const REQUIRED_ENV = [
  "GOOGLE_WORK_CLIENT_ID",
  "GOOGLE_WORK_CLIENT_SECRET",
  "TOKEN_ENCRYPTION_KEY",
  "SITE_URL",
] as const;
const missingEnv = () => REQUIRED_ENV.filter((name) => !process.env[name]);
// CONVEX_SITE_URL is the deployment's own HTTP address, set by Convex itself.
const redirectUri = () => `${process.env.CONVEX_SITE_URL}${CALLBACK_PATH}`;

const connectionRow = (ctx: QueryCtx) =>
  ctx.db
    .query("oauthConnections")
    .withIndex("by_provider", (q) => q.eq("provider", "google"))
    .unique();

/** Whether Google is connected. Never the token, sealed or not. */
export const connection = ownerQuery({
  args: {},
  handler: async (ctx) => {
    const row = await connectionRow(ctx);
    return {
      missingEnv: missingEnv(),
      connected: row !== null,
      connectedAt: row?.connectedAt ?? null,
    };
  },
});

/**
 * Start a connection. The browser supplies the randomness (a mutation cannot
 * be relied on for it); this stores it for ten minutes and returns where to
 * send the browser. Only the owner can create a state row, which is what lets
 * the callback trust one.
 */
export const begin = ownerMutation({
  args: { state: v.string(), verifier: v.string(), challenge: v.string() },
  handler: async (ctx, args) => {
    if (![args.state, args.verifier, args.challenge].every((value) => NONCE.test(value))) {
      throw new ConvexError("That connect request was malformed. Try again.");
    }
    const missing = missingEnv();
    if (missing.length > 0) {
      throw new ConvexError(`Set ${missing.join(", ")} on the Convex deployment first.`);
    }
    // Found now, not after the owner has been through Google's consent screen.
    const badKey = keyProblem();
    if (badKey !== null) throw new ConvexError(badKey);
    if (!process.env.CONVEX_SITE_URL) {
      throw new ConvexError("This deployment has no HTTP address for Google to return to.");
    }

    // One attempt at a time: starting again cancels the one before.
    for (const old of await ctx.db.query("oauthStates").collect()) await ctx.db.delete(old._id);
    await ctx.db.insert("oauthStates", {
      state: args.state,
      verifier: args.verifier,
      expiresAt: Date.now() + STATE_TTL_MS,
      // Whose attempt this is: the grant must be for the Google account this
      // user signs in with.
      userId: ctx.owner._id,
    });

    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_WORK_CLIENT_ID!,
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      access_type: "offline",
      // Always ask again, so Google returns a refresh token on a reconnect.
      prompt: "consent",
      state: args.state,
      code_challenge: args.challenge,
      code_challenge_method: "S256",
    });
    if (ctx.owner.email) params.set("login_hint", ctx.owner.email);
    return `${AUTH_URL}?${params.toString()}`;
  },
});

/** Use up a state. Returns its verifier and who started it, if it existed and was in time. */
export const takeState = internalMutation({
  args: { state: v.string() },
  handler: async (ctx, { state }) => {
    const row = await ctx.db
      .query("oauthStates")
      .withIndex("by_state", (q) => q.eq("state", state))
      .unique();
    if (row === null) return null;
    await ctx.db.delete(row._id); // single use, in time or not
    if (row.expiresAt <= Date.now()) return null;
    return { verifier: row.verifier, userId: row.userId ?? null };
  },
});

/**
 * Keep a grant, if it is the owner's own Google identity: the account in the
 * grant (`sub`, Google's id for it) must be the one the user who started the
 * attempt signs in with, and that user must still be an owner. Being able to
 * show the owner's address is not enough, here as at sign-in: a second Google
 * account can present it. Returns false, having stored nothing, otherwise.
 */
export const save = internalMutation({
  args: { sealed: v.string(), userId: v.id("users"), sub: v.string() },
  handler: async (ctx, { sealed, userId, sub }) => {
    const user = await ctx.db.get(userId);
    if (!user?.emailVerificationTime || !isOwnerEmail(user.email)) return false;
    const accounts = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) =>
        q.eq("userId", userId).eq("provider", SIGN_IN_PROVIDER),
      )
      .collect();
    if (!accounts.some((account) => account.providerAccountId === sub)) return false;

    const existing = await connectionRow(ctx);
    if (existing !== null) await ctx.db.delete(existing._id);
    await ctx.db.insert("oauthConnections", {
      provider: "google",
      sealedRefreshToken: sealed,
      connectedAt: Date.now(),
    });
    // The first read, so the page fills without waiting for the schedule.
    await ctx.scheduler.runAfter(0, internal.connectors.gmail.sync, {});
    await ctx.scheduler.runAfter(0, internal.connectors.googleCalendar.sync, {});
    return true;
  },
});

/** Ciphertext, for convex/connectors/googleAuth.ts only. */
export const sealedToken = internalQuery({
  args: {},
  handler: async (ctx) => (await connectionRow(ctx))?.sealedRefreshToken ?? null,
});

/** When the stored grant was made, or null. What a read is stamped with (connectors/mirror.ts). */
export const grantAt = internalQuery({
  args: {},
  handler: async (ctx) => (await connectionRow(ctx))?.connectedAt ?? null,
});

/** Delete everything read with the Google grant, and say why in each source's status. */
async function forgetGoogleRecords(ctx: MutationCtx, message: string): Promise<void> {
  for (const source of GOOGLE_SOURCES) {
    await deleteRecords(ctx, source);
    await markNotConfigured(ctx, source, message, { forget: true });
  }
}

/**
 * Whether Google confirmed the grant is gone: a 200, or a 400 saying the
 * token is already invalid. Anything else, and no answer at all, is "not
 * known". Never throws, and nothing Google sent is kept.
 */
async function revokeAtGoogle(refreshToken: string): Promise<boolean> {
  try {
    const { status, json } = await ask({
      who: "Google",
      what: "revoking the grant",
      url: REVOKE_URL,
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({ token: refreshToken }).toString(),
    });
    if (status === 200) return true;
    const error =
      typeof json === "object" && json !== null ? (json as { error?: unknown }).error : undefined;
    return status === 400 && error === "invalid_token";
  } catch {
    return false;
  }
}

type Result =
  | "connected"
  | "declined"
  | "expired"
  | "failed"
  | "no_refresh_token"
  | "missing_scope"
  | "wrong_account";

/**
 * Back to the app. The destination is SITE_URL, one fixed path and one of
 * seven fixed words: nothing from the request, and nothing Google sent.
 */
function back(result: Result): Response {
  const site = process.env.SITE_URL;
  if (!site) {
    // Nowhere of ours to send the browser, so it is sent nowhere.
    return new Response(`${PRODUCT.name} is not set up to connect Google yet.`, {
      status: 500,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${site}${SETTINGS_PATH}?google=${result}`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

/**
 * GET /google/callback: where Google returns the browser. Reachable without a
 * session (the browser arrives from Google), so it does nothing at all until
 * it has used up a state row, and only the signed-in owner can create one.
 */
export const callback = httpAction(async (ctx, request) => {
  const params = new URL(request.url).searchParams;
  const state = params.get("state") ?? "";
  const code = params.get("code") ?? "";
  if (!NONCE.test(state)) return back("failed");

  const attempt = await ctx.runMutation(internal.google.takeState, { state });
  if (attempt === null) return back("expired");
  const { verifier, userId } = attempt;
  if (code === "") return back("declined");
  if (code.length > MAX_CODE_LENGTH || missingEnv().length > 0) return back("failed");

  // Held so that a grant this function cannot keep is handed back to Google.
  let received: string | null = null;
  try {
    const { status, json } = await ask({
      who: "Google",
      what: "the sign-in code",
      url: GOOGLE_TOKEN_URL,
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: process.env.GOOGLE_WORK_CLIENT_ID!,
        client_secret: process.env.GOOGLE_WORK_CLIENT_SECRET!,
        redirect_uri: redirectUri(),
      }).toString(),
    });
    const grant = parseGrant(status, json);
    // No lasting grant came back, so there is nothing to keep or to hand back.
    if (!("refreshToken" in grant)) return back(grant.kind);
    const refreshToken = grant.refreshToken;
    received = refreshToken;
    if (grant.kind !== "ok") {
      await revokeAtGoogle(refreshToken);
      return back(grant.kind);
    }
    // Whose mailbox this is, to the standard sign-in holds: an owner's
    // address, one Google is authoritative for (gmail.com, or the Workspace
    // the address's domain belongs to), on the very Google account the owner
    // signs in with. A click on the wrong entry of Google's account chooser,
    // or a second account that merely shows the owner's address, must not
    // have its inbox mirrored here.
    const kept =
      userId !== null &&
      isOwnerEmail(grant.email) &&
      googleVouchesFor(grant.email, grant.hd) &&
      (await ctx.runMutation(internal.google.save, {
        sealed: await seal(refreshToken, GOOGLE_TOKEN_PURPOSE),
        userId,
        sub: grant.sub,
      }));
    if (!kept) {
      await revokeAtGoogle(refreshToken);
      return back("wrong_account");
    }
    return back("connected");
  } catch {
    // Whatever was thrown may quote the request; the browser gets one word.
    if (received !== null) await revokeAtGoogle(received);
    return back("failed");
  }
});

/** Delete the grant and everything read with it, then ask Google to forget it. */
export const disconnect = ownerMutation({
  args: {},
  handler: async (ctx) => {
    const row = await connectionRow(ctx);
    await forgetGoogleRecords(ctx, CONNECT_GOOGLE_MESSAGE);
    for (const pending of await ctx.db.query("oauthStates").collect()) {
      await ctx.db.delete(pending._id);
    }
    if (row !== null) {
      await ctx.db.delete(row._id);
      // Passed sealed: the scheduler stores its arguments.
      await ctx.scheduler.runAfter(0, internal.google.revoke, { sealed: row.sealedRefreshToken });
    }
    return null;
  },
});

/**
 * The grant has died at Google (the owner removed access there, or it
 * expired): delete it and everything read with it, as `disconnect` does, and
 * leave both sources saying so. Nothing is revoked; there is nothing to.
 *
 * `sealed` is the value the refused read was holding. If the stored grant is
 * no longer that one (the owner has just connected again), nothing is touched.
 */
export const forgetDeadGrant = internalMutation({
  args: { sealed: v.string() },
  handler: async (ctx, { sealed }) => {
    const row = await connectionRow(ctx);
    if (row === null || row.sealedRefreshToken !== sealed) return null;
    await ctx.db.delete(row._id);
    await forgetGoogleRecords(ctx, GOOGLE_REMOVED_MESSAGE);
    return null;
  },
});

/** Google never confirmed a revoke: tell the owner where to finish it by hand. */
export const noteRevokeUnconfirmed = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Connected again since: the sources have a grant and a status of their own.
    if ((await connectionRow(ctx)) !== null) return null;
    for (const source of GOOGLE_SOURCES) {
      await markNotConfigured(ctx, source, REVOKE_UNCONFIRMED_MESSAGE);
    }
    return null;
  },
});

/**
 * Ask Google to forget a grant that has already been deleted here. Tried up
 * to three times, 30 seconds apart; if Google never confirms, both sources
 * say so, with where to remove the access by hand.
 */
export const revoke = internalAction({
  args: { sealed: v.string(), attempt: v.optional(v.number()) },
  handler: async (ctx, { sealed, attempt = 1 }) => {
    let refreshToken: string;
    try {
      refreshToken = await open(sealed, GOOGLE_TOKEN_PURPOSE);
    } catch {
      // The key changed, or the value was unreadable: there is nothing to
      // revoke with, now or on a later try, and the grant may still be live.
      await ctx.runMutation(internal.google.noteRevokeUnconfirmed, {});
      return null;
    }
    if (await revokeAtGoogle(refreshToken)) return null;
    if (attempt < REVOKE_TRIES) {
      // Passed sealed again: the scheduler stores its arguments.
      await ctx.scheduler.runAfter(REVOKE_RETRY_MS, internal.google.revoke, {
        sealed,
        attempt: attempt + 1,
      });
    } else {
      await ctx.runMutation(internal.google.noteRevokeUnconfirmed, {});
    }
    return null;
  },
});
