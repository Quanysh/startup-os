// A project's token (`rap_…`), made where a project is connected or its
// token rotated (convex/agentProjects.ts), and checked on every call to
// Protocol v1 (convex/agentsApi.ts). Made as the owner's agent token is: SHA-256
// over 32 random bytes drawn here and 32 or more drawn by the caller's
// browser. Only its SHA-256 is ever stored; the token is returned once.
// Runs only inside Convex. Nothing here logs or throws.

import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { PROJECT_TOKEN_BYTES, projectTokenFrom } from "./agentProjects";
import { secretsEqual } from "./constantTime";

/** What the browser adds to the token's randomness: 32 bytes or more, URL-safe base64. */
export const ENTROPY_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

/** Random bytes from the runtime, or none where it has no source of them. */
function serverBytes(): Uint8Array {
  try {
    return crypto.getRandomValues(new Uint8Array(PROJECT_TOKEN_BYTES));
  } catch {
    return new Uint8Array(0);
  }
}

/** A new token from the browser's entropy and the runtime's, or null for entropy that is not. */
export async function mintProjectToken(entropy: string): Promise<string | null> {
  if (!ENTROPY_PATTERN.test(entropy)) return null;
  const material = new TextEncoder().encode(entropy);
  const drawn = serverBytes();
  const mixed = new Uint8Array(drawn.length + material.length);
  mixed.set(drawn, 0);
  mixed.set(material, drawn.length);
  return projectTokenFrom(new Uint8Array(await crypto.subtle.digest("SHA-256", mixed)));
}

/**
 * The project a token's SHA-256 belongs to, or null. Honoured only while
 * exactly one row has the hash (compared in constant time) and the project
 * is active: a rotated token's hash is gone, a disconnected project has none.
 */
export async function projectHolding(ctx: QueryCtx, tokenHash: string): Promise<Doc<"agentProjects"> | null> {
  const rows = await ctx.db
    .query("agentProjects")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
    .take(2);
  const row = rows.length === 1 ? rows[0]! : null;
  if (row === null || row.status !== "active") return null;
  return (await secretsEqual(tokenHash, row.tokenHash)) ? row : null;
}
