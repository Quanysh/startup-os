// "Connect your Claude": a teammate's personal push token, and what is held
// of their own mail, calendar, meeting notes and assigned issues.
//
// Every public function here is for the Today area and answers about the
// caller alone: there is no argument that names another person, and "the
// caller" is their `users` row, not only their address (a row left under the
// address by an identity that held it before is not theirs). The token is
// returned once, by `createToken`, and only its SHA-256 is stored. Nothing
// here returns, throws or logs a token, a hash, an address or anything a
// record holds.
//
// The deployment owner has no personal token. The owner's records are the
// rows with no `owner`, which are the shared mirror too (the Linear board),
// so a personal push as the owner would replace what the whole team reads.
// The owner's tools are set up under Settings → Work tools.

import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { MAX_RUN_MESSAGE_LENGTH } from "./lib/limits";
import { MIRROR_SOURCES, type MirrorSource } from "./lib/mirrorRules";
import { mirrorSourceValidator } from "./lib/mirrorValidators";
import { memberMutation, memberQuery, type Member } from "./lib/owner";
import {
  deleteTokens,
  forgetTool,
  holderOf,
  isHeldBy,
  patchPersonalStatus,
  personalStatus,
  tokenHolder,
  tokenOf,
  type Teammate,
} from "./lib/personal";
import {
  OWNER_HAS_NO_PERSONAL_TOKEN,
  PERSONAL_TOKEN_BYTES,
  hashToken,
  nextPushWindow,
  tokenFrom,
} from "./lib/personalRules";

/** The caller as a teammate: their address and their own `users` row. The owner is refused in fixed words. */
function teammate(member: Member): Teammate {
  const holder = holderOf(member);
  if (holder.kind === "owner") throw new ConvexError(OWNER_HAS_NO_PERSONAL_TOKEN);
  return holder;
}

/**
 * How the caller's own connection stands: whether they have a token, when it
 * was made and last used, and per tool the last push that was stored and how
 * many records are held. Nothing else, and nothing of anyone else's. For the
 * owner it says only that the owner's tools are set up elsewhere.
 */
export const status = memberQuery("today")({
  args: {},
  handler: async (ctx) => {
    const holder = holderOf(ctx.member);
    if (holder.kind === "owner") return { owner: true as const, token: null, tools: [] };
    const token = await tokenOf(ctx, holder);
    const tools = [];
    for (const source of MIRROR_SOURCES) {
      const row = await personalStatus(ctx, holder, source);
      const held = await ctx.db
        .query("mirrorRecords")
        .withIndex("by_owner_and_source_and_externalId", (q) =>
          q.eq("owner", holder.email).eq("source", source),
        )
        .collect();
      tools.push({
        source,
        lastOkAt: row?.lastOkAt ?? null,
        held: held.filter((doc) => isHeldBy(holder, doc)).length,
      });
    }
    return {
      owner: false as const,
      token:
        token === null
          ? null
          : { createdAt: token.createdAt, lastUsedAt: token.lastUsedAt ?? null },
      tools,
    };
  },
});

/** What the browser adds to the token's randomness: 32 bytes or more, URL-safe base64. */
const ENTROPY = /^[A-Za-z0-9_-]{43,128}$/;

/** Random bytes from the runtime, or none where it has no source of them. */
function serverBytes(): Uint8Array {
  try {
    return crypto.getRandomValues(new Uint8Array(PERSONAL_TOKEN_BYTES));
  } catch {
    return new Uint8Array(0);
  }
}

/**
 * Make the caller's token, replacing any they had (the old one stops working
 * in this transaction), and return it: the one time it can be read. Only its
 * SHA-256 is stored.
 *
 * The token is 32 bytes: SHA-256 over 32 random bytes drawn here and 32 or
 * more drawn by the caller's browser. Either alone is enough; the two are
 * mixed so the token is unguessable whichever random source is the better.
 */
export const createToken = memberMutation("today")({
  args: { entropy: v.string() },
  handler: async (ctx, { entropy }) => {
    const holder = teammate(ctx.member);
    if (!ENTROPY.test(entropy)) throw new ConvexError("That token could not be made. Try again.");

    const material = new TextEncoder().encode(entropy);
    const drawn = serverBytes();
    const mixed = new Uint8Array(drawn.length + material.length);
    mixed.set(drawn, 0);
    mixed.set(material, drawn.length);
    const token = tokenFrom(new Uint8Array(await crypto.subtle.digest("SHA-256", mixed)));

    await deleteTokens(ctx, holder.email);
    await ctx.db.insert("personalTokens", {
      owner: holder.email,
      userId: holder.userId,
      tokenHash: await hashToken(token),
      createdAt: Date.now(),
    });
    return { token };
  },
});

/**
 * Delete the caller's token: the next push with it is refused, one in flight
 * included. What was already received stays until they forget it or it ages
 * out (30 days without a push; meeting notes 90 days after the meeting).
 */
export const revokeToken = memberMutation("today")({
  args: {},
  handler: async (ctx) => {
    await deleteTokens(ctx, teammate(ctx.member).email);
    return null;
  },
});

/** Delete the caller's own records of one tool. */
export const forget = memberMutation("today")({
  args: { source: mirrorSourceValidator },
  handler: async (ctx, { source }) => {
    await forgetTool(ctx, teammate(ctx.member), source);
    return null;
  },
});

/** Delete the caller's own records of every tool. Their token stays. */
export const forgetAll = memberMutation("today")({
  args: {},
  handler: async (ctx) => {
    const holder = teammate(ctx.member);
    for (const source of MIRROR_SOURCES) await forgetTool(ctx, holder, source);
    return null;
  },
});

// ── For POST /ingest/v1 ─────────────────────────────────────────────────────
// The endpoint hands these the SHA-256 of the bearer token, never the token.

/** Whether a token is one a teammate with the Today area holds right now. */
export const knows = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => (await tokenHolder(ctx, tokenHash)) !== null,
});

/**
 * Count one push of one tool against the token's hourly limit. The token is
 * looked up again, so one revoked since the request began is refused here.
 */
export const admit = internalMutation({
  args: { tokenHash: v.string(), source: mirrorSourceValidator },
  handler: async (ctx, { tokenHash, source }) => {
    const known = await tokenHolder(ctx, tokenHash);
    if (known === null) return "unauthorized" as const;
    const { token, holder } = known;
    const now = Date.now();
    const row = await personalStatus(ctx, holder, source);
    const next = nextPushWindow(row ?? {}, now);
    if (!next.allowed) return "limited" as const;
    await patchPersonalStatus(ctx, holder, source, {
      windowStart: next.windowStart,
      pushes: next.pushes,
    });
    await ctx.db.patch(token._id, { lastUsedAt: now });
    return "ok" as const;
  },
});

/**
 * Note that a person's push of one tool was refused, on their own status row
 * and nowhere else: the run log and `sourceStatus` are the deployment's, and
 * the owner reads them. `message` is an error name, a path and fixed words.
 * What they hold, and when it was last received, stay as they were.
 */
export const noteRefused = internalMutation({
  args: { tokenHash: v.string(), source: mirrorSourceValidator, message: v.string() },
  handler: async (ctx, { tokenHash, source, message }) => {
    const known = await tokenHolder(ctx, tokenHash);
    if (known === null) return null;
    await patchPersonalStatus(ctx, known.holder, source as MirrorSource, {
      state: "error",
      message: message.slice(0, MAX_RUN_MESSAGE_LENGTH),
      lastRunAt: Date.now(),
    });
    return null;
  },
});
