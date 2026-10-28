// OAuth 2.1 for the agent endpoint (POST /mcp/v1), so a client that signs in
// rather than taking a token (claude.ai on the web, the phone and in
// routines; the Grok app's connectors; any client of the MCP authorization
// specification) can reach the OS as the owner, with the owner's approval.
// The rules are convex/lib/oauthRules.ts.
//
// Where each part is. The public host is the app (SITE_URL, APP_URL); it
// passes the documents, registration, the token endpoint and revocation
// through to these routes unchanged (src/lib/os/pass-through-routes.ts), as
// it does POST /mcp/v1, so every secret is made, checked and kept here, in
// one place, beside the tables. The one part that is the app's is the
// consent page (src/app/oauth/authorize), which needs the owner's session:
// it calls `describe` and `approve` below, which are owner-only like the rest
// of the Assistant.
//
// The issuer and the protected resource are SITE_URL (the app's own origin,
// which Convex Auth reads too) and SITE_URL/mcp/v1. With SITE_URL unset or
// not plainly ours, nothing here names an address: it answers 503.
//
// Every secret is made from fresh random bytes (in an action, or in a
// mutation mixed with randomness the owner's browser drew, as a named token
// is), handed back once, and kept only as its SHA-256. A function is passed a
// hash, never a code, a token, a secret or a verifier (the PKCE challenge is
// worked out before the mutation is called). Nothing here logs, and no answer
// quotes what was sent: every refusal is a code and fixed words.

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { httpAction, internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { CLIENT_WORDS, MAX_CLIENT_NAME, type AgentScope } from "./lib/agentRules";
import { ownerBehind } from "./lib/agentToken";
import { secretsEqual } from "./lib/constantTime";
import { PRODUCT } from "./lib/identity";
import { cleanRemote } from "./lib/mirrorRules";
import {
  ACCESS_TOKEN_PREFIX,
  ACCESS_TOKEN_SECONDS,
  CHALLENGE_METHOD,
  CLIENT_ID_PREFIX,
  CLIENT_SECRET_PREFIX,
  CODE_CHALLENGE,
  CODE_PREFIX,
  CODE_SECONDS,
  CONSENT_WORDS,
  MAX_HAND_CLIENTS,
  MAX_OAUTH_BYTES,
  MAX_PENDING_CLIENTS,
  OAUTH_WORDS,
  PENDING_CLIENT_MS,
  PROTECTED_RESOURCE_PATH,
  REFRESH_TOKEN_PREFIX,
  REFRESH_TOKEN_SECONDS,
  RESPONSE_TYPE,
  authorizationServerMetadata,
  botOfResource,
  challengeOf,
  checkRedirectUris,
  parseBasic,
  parseScope,
  protectedResourceMetadata,
  redirectHostOf,
  resourceFor,
  scopeString,
  siteOrigin,
  withParams,
} from "./lib/oauthRules";
import { deleteGrant, deleteGrantsOf } from "./lib/oauthStore";
import { ownerMutation, ownerQuery } from "./lib/owner";
import { base64Url, hashToken } from "./lib/personalRules";
import { agentScopeValidator } from "./schema";

/** Random bytes in every secret made here: 256 bits. */
const SECRET_BYTES = 32;

const origin = () => siteOrigin(process.env.SITE_URL);

// ── Answers ─────────────────────────────────────────────────────────────────

const HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });

/** An OAuth error: its code (RFC 6749, 5.2; RFC 7591, 3.2.2) and fixed words. */
const oauthError = (status: number, error: string, words: string, extra: Record<string, string> = {}) =>
  json(status, { error, error_description: words }, extra);

const notConfigured = () => oauthError(503, "temporarily_unavailable", OAUTH_WORDS.notConfigured);

/** A body's text, or null once it is over the cap (declared or real). */
async function readCapped(request: Request): Promise<string | null> {
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_OAUTH_BYTES) return null;
  const text = await request.text();
  return new TextEncoder().encode(text).length > MAX_OAUTH_BYTES ? null : text;
}

/** A secret of fresh random bytes, in an action, where the runtime has a true source of them. */
function randomSecret(prefix: string): string {
  return `${prefix}${base64Url(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)))}`;
}

/** What the browser adds to a secret made in a mutation: 32 bytes or more, URL-safe base64. */
const ENTROPY = /^[A-Za-z0-9_-]{43,128}$/;

/**
 * A secret made in a mutation: SHA-256 over random bytes drawn here, the
 * owner's browser's randomness and a label (so two secrets made at once
 * differ), as a named token is made (convex/assistant.ts).
 */
async function mixedSecret(prefix: string, entropy: string, label: string): Promise<string> {
  let drawn: Uint8Array;
  try {
    drawn = crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
  } catch {
    drawn = new Uint8Array(0);
  }
  const material = new TextEncoder().encode(`${entropy}:${label}`);
  const mixed = new Uint8Array(drawn.length + material.length);
  mixed.set(drawn, 0);
  mixed.set(material, drawn.length);
  return `${prefix}${base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", mixed)))}`;
}

// ── Discovery ───────────────────────────────────────────────────────────────

/** GET /.well-known/oauth-protected-resource (and at the endpoint's own path): RFC 9728. */
export const protectedResource = httpAction(async () => {
  const at = origin();
  return at === null ? notConfigured() : json(200, protectedResourceMetadata(at));
});

/** GET /.well-known/oauth-protected-resource/mcp/v1/bot/<bot id>: one bot's own address, as a resource. */
export const protectedResourceBot = httpAction(async (_ctx, request) => {
  const at = origin();
  if (at === null) return notConfigured();
  const path = new URL(request.url).pathname.slice(PROTECTED_RESOURCE_PATH.length);
  const bot = botOfResource(`${at}${path}`, at);
  return bot === null ? json(404, { error: "not_found" }) : json(200, protectedResourceMetadata(at, bot));
});

/** GET /.well-known/oauth-authorization-server: RFC 8414. Complete, for a client that reads only this. */
export const authorizationServer = httpAction(async () => {
  const at = origin();
  return at === null ? notConfigured() : json(200, authorizationServerMetadata(at));
});

// ── Registration (RFC 7591) ─────────────────────────────────────────────────

const GRANT_TYPES = ["authorization_code", "refresh_token"];
const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * POST /oauth/register: a client registers itself, open to anyone, as the MCP
 * specification expects. It gets an id, and a secret unless it asks to be
 * public (`token_endpoint_auth_method: "none"`); leaving the method out means
 * `client_secret_basic`, as RFC 7591 says. It can do nothing until the owner
 * approves it on the consent page, and one never approved is forgotten after
 * PENDING_CLIENT_MS (an hour). Any https redirect URI is taken (and http on this
 * machine): on use it must equal a registered one exactly.
 */
export const registerV1 = httpAction(async (ctx, request) => {
  if (origin() === null) return notConfigured();
  const text = await readCapped(request);
  if (text === null) return oauthError(413, "invalid_request", OAUTH_WORDS.tooLarge);
  let meta: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    meta = parsed as Record<string, unknown>;
  } catch {
    return oauthError(400, "invalid_client_metadata", OAUTH_WORDS.metadata);
  }

  const redirectUris = checkRedirectUris(meta.redirect_uris);
  if (redirectUris === null) return oauthError(400, "invalid_redirect_uri", OAUTH_WORDS.redirectUris);
  const grants = meta.grant_types ?? GRANT_TYPES;
  const responses = meta.response_types ?? [RESPONSE_TYPE];
  const method = meta.token_endpoint_auth_method ?? "client_secret_basic";
  if (
    !isStringList(grants) ||
    !grants.includes("authorization_code") ||
    grants.some((grant) => !GRANT_TYPES.includes(grant)) ||
    !isStringList(responses) ||
    responses.length === 0 ||
    responses.some((type) => type !== RESPONSE_TYPE) ||
    typeof method !== "string" ||
    !(AUTH_METHODS as readonly string[]).includes(method)
  ) {
    return oauthError(400, "invalid_client_metadata", OAUTH_WORDS.metadata);
  }

  // The name a client gives itself is text from outside: cleaned, cut, shown as text.
  const name = cleanRemote(meta.client_name, MAX_CLIENT_NAME) || "Unnamed client";
  const clientId = randomSecret(CLIENT_ID_PREFIX);
  const secret = method === "none" ? null : randomSecret(CLIENT_SECRET_PREFIX);
  const now = Date.now();
  const made = await ctx.runMutation(internal.oauth.register, {
    clientId,
    name,
    redirectUris,
    ...(secret === null ? null : { secretHash: await hashToken(secret) }),
    now,
  });
  if (!made) return oauthError(429, "temporarily_unavailable", OAUTH_WORDS.busy);
  return json(201, {
    client_id: clientId,
    client_id_issued_at: Math.floor(now / 1000),
    client_name: name,
    redirect_uris: redirectUris,
    grant_types: GRANT_TYPES,
    response_types: [RESPONSE_TYPE],
    token_endpoint_auth_method: method,
    ...(secret === null ? null : { client_secret: secret, client_secret_expires_at: 0 }),
  });
});

/** Whether a client has a grant on record: an approved one is not "pending". */
const hasGrant = async (ctx: QueryCtx, clientId: string) =>
  (await ctx.db
    .query("oauthGrants")
    .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
    .first()) !== null;

/** Store a client that registered itself, unless too many are waiting for the owner. */
export const register = internalMutation({
  args: {
    clientId: v.string(),
    name: v.string(),
    redirectUris: v.array(v.string()),
    secretHash: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, { now, ...client }) => {
    const recent = await ctx.db
      .query("oauthClients")
      .withIndex("by_createdBy_and_createdAt", (q) =>
        q.eq("createdBy", "dynamic").gte("createdAt", now - PENDING_CLIENT_MS),
      )
      .take(MAX_PENDING_CLIENTS * 2);
    let pending = 0;
    for (const row of recent) if (!(await hasGrant(ctx, row.clientId))) pending += 1;
    if (pending >= MAX_PENDING_CLIENTS) return false;
    await ctx.db.insert("oauthClients", { ...client, createdBy: "dynamic", createdAt: now });
    return true;
  },
});

// ── The owner's consent (the page at /oauth/authorize) ──────────────────────

/** What a client sent to /oauth/authorize, as the page hands it on. */
const requestArgs = {
  clientId: v.string(),
  redirectUri: v.string(),
  responseType: v.optional(v.string()),
  codeChallenge: v.optional(v.string()),
  codeChallengeMethod: v.optional(v.string()),
  scope: v.optional(v.string()),
  resource: v.optional(v.string()),
  state: v.optional(v.string()),
};
type AuthorizeRequest = {
  clientId: string;
  redirectUri: string;
  responseType?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  scope?: string;
  resource?: string;
  state?: string;
};

async function clientNamed(ctx: QueryCtx, clientId: string): Promise<Doc<"oauthClients"> | null> {
  const rows = await ctx.db
    .query("oauthClients")
    .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
    .take(2);
  return rows.length === 1 ? rows[0]! : null;
}

type Checked =
  /** Shown on the page, and nobody is redirected: the client or its address cannot be trusted. */
  | { status: "invalid"; words: string }
  /** The browser goes back to the client with the error (RFC 6749, 4.1.2.1). */
  | { status: "error"; redirect: string }
  | {
      status: "ok";
      client: Doc<"oauthClients">;
      asked: AgentScope | null;
      resource: string;
      challenge: string;
      issuer: string;
    };

/** A request checked as RFC 6749 and the MCP specification ask, in their order. */
async function checkRequest(ctx: QueryCtx, request: AuthorizeRequest): Promise<Checked> {
  const issuer = origin();
  if (issuer === null) return { status: "invalid", words: OAUTH_WORDS.notConfigured };
  const client = await clientNamed(ctx, request.clientId);
  if (client === null) return { status: "invalid", words: CONSENT_WORDS.unknownClient };
  // Exactly one of the registered addresses, character for character.
  if (!client.redirectUris.includes(request.redirectUri)) return { status: "invalid", words: CONSENT_WORDS.badRedirect };
  const back = (error: string): Checked => ({
    status: "error",
    redirect: withParams(request.redirectUri, { error, state: request.state, iss: issuer }),
  });
  if (request.responseType !== RESPONSE_TYPE) return back("unsupported_response_type");
  // PKCE is required of every client, public or confidential, and only S256.
  if (request.codeChallengeMethod !== CHALLENGE_METHOD || !CODE_CHALLENGE.test(request.codeChallenge ?? "")) {
    return back("invalid_request");
  }
  const scope = parseScope(request.scope);
  if (!scope.ok) return back("invalid_scope");
  const resource = resourceFor(request.resource, issuer);
  if (resource === null) return back("invalid_target");
  return { status: "ok", client, asked: scope.scope, resource, challenge: request.codeChallenge!, issuer };
}

/**
 * What the consent page shows: who is asking and where the browser will be
 * sent, what it asked for, and where Deny sends it. Or the words to show
 * instead, or the error to send it back with. Owner only: a teammate's page
 * never asks (it says only the owner can connect a client, for now).
 */
export const describe = ownerQuery({
  args: requestArgs,
  handler: async (ctx, request) => {
    const checked = await checkRequest(ctx, request);
    if (checked.status !== "ok") return checked;
    return {
      status: "ask" as const,
      // A name a client gave itself: text, rendered as text.
      clientName: checked.client.name,
      redirectHost: redirectHostOf(request.redirectUri),
      asked: checked.asked,
      denyUrl: withParams(request.redirectUri, {
        error: "access_denied",
        state: request.state,
        iss: checked.issuer,
      }),
    };
  },
});

/**
 * The owner approves a request, with what the client may do (`granted`):
 * the request is checked again, a code is made (used once, within
 * CODE_SECONDS) and the address the browser goes to next is returned, with
 * the code, the state exactly as sent and the issuer. Only the code's
 * SHA-256 is kept. The grant itself is made when the code is exchanged.
 */
export const approve = ownerMutation({
  args: { ...requestArgs, granted: agentScopeValidator, entropy: v.string() },
  handler: async (ctx, { granted, entropy, ...request }) => {
    if (!ENTROPY.test(entropy)) throw new ConvexError(CONSENT_WORDS.approveFailed);
    const checked = await checkRequest(ctx, request);
    if (checked.status === "invalid") throw new ConvexError(checked.words);
    if (checked.status === "error") throw new ConvexError(CONSENT_WORDS.badRequest);
    const code = await mixedSecret(CODE_PREFIX, entropy, "code");
    const now = Date.now();
    await ctx.db.insert("oauthCodes", {
      codeHash: await hashToken(code),
      clientId: checked.client.clientId,
      userId: ctx.owner._id,
      redirectUri: request.redirectUri,
      codeChallenge: checked.challenge,
      scope: granted,
      resource: checked.resource,
      expiresAt: now + CODE_SECONDS * 1000,
    });
    return {
      redirect: withParams(request.redirectUri, { code, state: request.state, iss: checked.issuer }),
    };
  },
});

// ── Clients the owner adds by hand ──────────────────────────────────────────
// For a client whose settings ask for a client id and secret instead of
// registering itself (some connector screens do): a confidential client, its
// secret shown once. It still signs in with PKCE and the owner's approval.

/** The clients the owner added by hand: names, ids and addresses. Never a secret. */
export const handClients = ownerQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("oauthClients")
      .withIndex("by_createdBy_and_createdAt", (q) => q.eq("createdBy", "owner"))
      .take(MAX_HAND_CLIENTS + 5);
    return rows.map((row) => ({
      id: row._id,
      clientId: row.clientId,
      name: row.name,
      redirectUris: row.redirectUris,
      createdAt: row.createdAt,
    }));
  },
});

/** Add a confidential client and return its id and secret: the one time the secret can be read. */
export const createClient = ownerMutation({
  args: { name: v.string(), redirectUris: v.array(v.string()), entropy: v.string() },
  handler: async (ctx, { name, redirectUris, entropy }) => {
    if (!ENTROPY.test(entropy)) throw new ConvexError(CONSENT_WORDS.approveFailed);
    const cleaned = cleanRemote(name, MAX_CLIENT_NAME + 2);
    if (cleaned === "") throw new ConvexError(CONSENT_WORDS.nameMissing);
    if (cleaned.length > MAX_CLIENT_NAME) throw new ConvexError(CLIENT_WORDS.nameTooLong);
    const uris = checkRedirectUris(redirectUris.map((uri) => uri.trim()).filter((uri) => uri !== ""));
    if (uris === null) throw new ConvexError(OAUTH_WORDS.redirectUris);
    const held = await ctx.db
      .query("oauthClients")
      .withIndex("by_createdBy_and_createdAt", (q) => q.eq("createdBy", "owner"))
      .take(MAX_HAND_CLIENTS);
    if (held.length >= MAX_HAND_CLIENTS) throw new ConvexError(CONSENT_WORDS.tooManyClients);
    const clientId = await mixedSecret(CLIENT_ID_PREFIX, entropy, "id");
    const clientSecret = await mixedSecret(CLIENT_SECRET_PREFIX, entropy, "secret");
    await ctx.db.insert("oauthClients", {
      clientId,
      name: cleaned,
      redirectUris: uris,
      secretHash: await hashToken(clientSecret),
      createdBy: "owner",
      createdAt: Date.now(),
    });
    return { clientId, clientSecret };
  },
});

/** Remove a client the owner added: its sign-ins end with it. One already gone is no error. */
export const removeClient = ownerMutation({
  args: { id: v.id("oauthClients") },
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (row === null) return null;
    await deleteGrantsOf(ctx, row.clientId);
    await ctx.db.delete(id);
    return null;
  },
});

// ── The token endpoint ──────────────────────────────────────────────────────

/** The form a token or revocation request sends, or null for a body that is not one. */
async function readForm(request: Request): Promise<URLSearchParams | "too_large" | null> {
  const text = await readCapped(request);
  if (text === null) return "too_large";
  const type = request.headers.get("Content-Type") ?? "";
  if (!type.toLowerCase().startsWith("application/x-www-form-urlencoded")) return null;
  try {
    return new URLSearchParams(text);
  } catch {
    return null;
  }
}

/** Who the client says it is: by Basic, or in the body; and its secret's hash, if it sent one. */
async function clientOf(request: Request, form: URLSearchParams) {
  const basic = parseBasic(request.headers.get("Authorization"));
  const inBody = form.get("client_id");
  if (basic !== null && inBody !== null && inBody !== basic.clientId) return { status: "mismatch" as const };
  const clientId = basic?.clientId ?? inBody;
  const secret = basic?.secret || form.get("client_secret") || null;
  return {
    status: "ok" as const,
    clientId,
    basic: basic !== null,
    ...(secret === null ? null : { secretHash: await hashToken(secret) }),
  };
}

type Issued = { ok: true; scope: AgentScope } | { ok: false; status: number; error: string; words: string };

const BAD_CLIENT: Issued = { ok: false, status: 401, error: "invalid_client", words: OAUTH_WORDS.badClient };
const BAD_GRANT: Issued = { ok: false, status: 400, error: "invalid_grant", words: OAUTH_WORDS.badGrant };

/**
 * POST /oauth/token: a code for tokens (with its PKCE verifier and the
 * redirect URI it was issued for), or a refresh token for new ones (rotated:
 * the old one is spent). A confidential client sends its secret in the body
 * or by Basic; a public one sends its id. An access token lasts an hour.
 */
export const tokenV1 = httpAction(async (ctx, request) => {
  if (origin() === null) return notConfigured();
  const form = await readForm(request);
  if (form === "too_large") return oauthError(413, "invalid_request", OAUTH_WORDS.tooLarge);
  if (form === null) return oauthError(400, "invalid_request", OAUTH_WORDS.badRequest);
  const grantType = form.get("grant_type");
  if (grantType !== "authorization_code" && grantType !== "refresh_token") {
    return oauthError(400, "unsupported_grant_type", OAUTH_WORDS.grantType);
  }
  const client = await clientOf(request, form);
  if (client.status === "mismatch") return oauthError(400, "invalid_request", OAUTH_WORDS.badRequest);
  if (client.clientId === null) return oauthError(401, "invalid_client", OAUTH_WORDS.badClient);
  const who = { clientId: client.clientId, ...(client.secretHash === undefined ? null : { secretHash: client.secretHash }) };

  const access = randomSecret(ACCESS_TOKEN_PREFIX);
  const refresh = randomSecret(REFRESH_TOKEN_PREFIX);
  const fresh = { accessHash: await hashToken(access), refreshHash: await hashToken(refresh), now: Date.now() };
  const resource = form.get("resource");
  let issued: Issued;
  if (grantType === "authorization_code") {
    const code = form.get("code");
    const redirectUri = form.get("redirect_uri");
    const verifier = form.get("code_verifier");
    if (code === null || redirectUri === null || verifier === null) {
      return oauthError(400, "invalid_request", OAUTH_WORDS.badRequest);
    }
    issued = await ctx.runMutation(internal.oauth.exchange, {
      ...who,
      ...fresh,
      codeHash: await hashToken(code),
      redirectUri,
      // A verifier RFC 7636 does not allow has no challenge, and matches none.
      challenge: (await challengeOf(verifier)) ?? "",
      ...(resource === null ? null : { resource }),
    });
  } else {
    const given = form.get("refresh_token");
    if (given === null) return oauthError(400, "invalid_request", OAUTH_WORDS.badRequest);
    const scope = parseScope(form.get("scope") ?? undefined);
    if (!scope.ok) return oauthError(400, "invalid_scope", OAUTH_WORDS.badScope);
    issued = await ctx.runMutation(internal.oauth.refresh, {
      ...who,
      ...fresh,
      oldRefreshHash: await hashToken(given),
      scope: scope.scope,
      ...(resource === null ? null : { resource }),
    });
  }
  if (!issued.ok) {
    return oauthError(
      issued.status,
      issued.error,
      issued.words,
      issued.error === "invalid_client" && client.basic ? { "WWW-Authenticate": `Basic realm="${PRODUCT.name}"` } : {},
    );
  }
  return json(200, {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_SECONDS,
    refresh_token: refresh,
    scope: scopeString(issued.scope),
  });
});

/** The client, if it is registered and, for a confidential one, its secret is right. */
async function authenticate(ctx: QueryCtx, clientId: string, secretHash: string | undefined) {
  const client = await clientNamed(ctx, clientId);
  if (client === null) return null;
  if (client.secretHash !== undefined) {
    if (secretHash === undefined || !(await secretsEqual(secretHash, client.secretHash))) return null;
  }
  return client;
}

/** A row of `oauthTokens` by its hash: one, or none. */
async function tokenRow(ctx: QueryCtx, tokenHash: string) {
  const rows = await ctx.db
    .query("oauthTokens")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
    .take(2);
  return rows.length === 1 ? rows[0]! : null;
}

/** A grant's fresh pair of tokens. */
async function issuePair(
  ctx: MutationCtx,
  grantId: Id<"oauthGrants">,
  fresh: { accessHash: string; refreshHash: string; now: number },
) {
  await ctx.db.insert("oauthTokens", {
    grantId,
    kind: "access",
    tokenHash: fresh.accessHash,
    expiresAt: fresh.now + ACCESS_TOKEN_SECONDS * 1000,
  });
  await ctx.db.insert("oauthTokens", {
    grantId,
    kind: "refresh",
    tokenHash: fresh.refreshHash,
    expiresAt: fresh.now + REFRESH_TOKEN_SECONDS * 1000,
  });
}

const freshArgs = {
  clientId: v.string(),
  secretHash: v.optional(v.string()),
  accessHash: v.string(),
  refreshHash: v.string(),
  now: v.number(),
  resource: v.optional(v.string()),
};

/**
 * A code for a grant and its first pair of tokens. The code is spent by the
 * first attempt, whatever its outcome; one presented again revokes the grant
 * it made (RFC 6749, 4.1.2). Connecting the same client again replaces its
 * grant: one a client.
 */
export const exchange = internalMutation({
  args: { ...freshArgs, codeHash: v.string(), redirectUri: v.string(), challenge: v.string() },
  handler: async (ctx, args): Promise<Issued> => {
    const client = await authenticate(ctx, args.clientId, args.secretHash);
    if (client === null) return BAD_CLIENT;
    const rows = await ctx.db
      .query("oauthCodes")
      .withIndex("by_codeHash", (q) => q.eq("codeHash", args.codeHash))
      .take(2);
    const code = rows.length === 1 ? rows[0]! : null;
    if (code === null || !(await secretsEqual(args.codeHash, code.codeHash))) return BAD_GRANT;
    if (code.usedAt !== undefined) {
      if (code.grantId !== undefined) await deleteGrant(ctx, code.grantId);
      return BAD_GRANT;
    }
    await ctx.db.patch(code._id, { usedAt: args.now });
    if (code.expiresAt <= args.now || code.clientId !== client.clientId) return BAD_GRANT;
    if (code.redirectUri !== args.redirectUri) {
      return { ok: false, status: 400, error: "invalid_grant", words: OAUTH_WORDS.badRedirect };
    }
    if (!(await secretsEqual(args.challenge, code.codeChallenge))) {
      return { ok: false, status: 400, error: "invalid_grant", words: OAUTH_WORDS.badVerifier };
    }
    const issuer = origin();
    const resource = issuer === null ? null : resourceFor(args.resource, issuer);
    if (resource === null || resource !== code.resource) {
      return { ok: false, status: 400, error: "invalid_target", words: OAUTH_WORDS.badTarget };
    }
    if ((await ownerBehind(ctx, code.userId)) === null) return BAD_GRANT;
    const bot = botOfResource(resource, issuer!);

    await deleteGrantsOf(ctx, client.clientId, code.userId);
    const grantId = await ctx.db.insert("oauthGrants", {
      userId: code.userId,
      clientId: client.clientId,
      clientName: client.name,
      redirectHost: redirectHostOf(code.redirectUri),
      scope: code.scope,
      resource,
      // Only the owner's bots may use a client approved from now on, until the owner says otherwise.
      botsOnly: true,
      // A grant made at a bot's own address is that bot's alone (convex/lib/agentToken.ts).
      ...(bot === null ? null : { onlyBot: bot }),
      createdAt: args.now,
    });
    await ctx.db.patch(code._id, { grantId });
    await issuePair(ctx, grantId, args);
    return { ok: true, scope: code.scope };
  },
});

/**
 * A refresh token for a new pair. The one presented is spent (rotated), and
 * the grant's earlier access tokens end. One presented again after it was
 * spent revokes the whole grant (RFC 9700, 4.14.2). It cannot widen what was
 * granted.
 */
export const refresh = internalMutation({
  args: { ...freshArgs, oldRefreshHash: v.string(), scope: v.union(agentScopeValidator, v.null()) },
  handler: async (ctx, args): Promise<Issued> => {
    const client = await authenticate(ctx, args.clientId, args.secretHash);
    if (client === null) return BAD_CLIENT;
    const token = await tokenRow(ctx, args.oldRefreshHash);
    if (token === null || token.kind !== "refresh") return BAD_GRANT;
    const grant = await ctx.db.get(token.grantId);
    if (grant === null || grant.clientId !== client.clientId) return BAD_GRANT;
    if (token.rotatedAt !== undefined) {
      await deleteGrant(ctx, grant._id);
      return BAD_GRANT;
    }
    if (token.expiresAt <= args.now) return BAD_GRANT;
    if (args.resource !== undefined) {
      const issuer = origin();
      if (issuer === null || resourceFor(args.resource, issuer) !== grant.resource) {
        return { ok: false, status: 400, error: "invalid_target", words: OAUTH_WORDS.badTarget };
      }
    }
    if (args.scope === "act" && grant.scope !== "act") {
      return { ok: false, status: 400, error: "invalid_scope", words: OAUTH_WORDS.badScope };
    }
    if ((await ownerBehind(ctx, grant.userId)) === null) return BAD_GRANT;

    await ctx.db.patch(token._id, { rotatedAt: args.now });
    const held = await ctx.db
      .query("oauthTokens")
      .withIndex("by_grantId", (q) => q.eq("grantId", grant._id))
      .take(2_000);
    for (const row of held) if (row.kind === "access") await ctx.db.delete(row._id);
    await issuePair(ctx, grant._id, args);
    return { ok: true, scope: grant.scope };
  },
});

// ── Revocation (RFC 7009) ───────────────────────────────────────────────────

/**
 * POST /oauth/revoke: a client ends its own grant by presenting either of its
 * tokens. An unknown token, or another client's, is answered 200 all the
 * same and changes nothing.
 */
export const revokeV1 = httpAction(async (ctx, request) => {
  if (origin() === null) return notConfigured();
  const form = await readForm(request);
  if (form === "too_large") return oauthError(413, "invalid_request", OAUTH_WORDS.tooLarge);
  if (form === null || form.get("token") === null) return oauthError(400, "invalid_request", OAUTH_WORDS.badRequest);
  const client = await clientOf(request, form);
  if (client.status === "mismatch") return oauthError(400, "invalid_request", OAUTH_WORDS.badRequest);
  if (client.clientId === null) return oauthError(401, "invalid_client", OAUTH_WORDS.badClient);
  const known = await ctx.runMutation(internal.oauth.revoke, {
    clientId: client.clientId,
    ...(client.secretHash === undefined ? null : { secretHash: client.secretHash }),
    tokenHash: await hashToken(form.get("token")!),
  });
  if (!known) return oauthError(401, "invalid_client", OAUTH_WORDS.badClient);
  return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
});

/** End the grant a token belongs to, if it is this client's. False only when the client is not who it says. */
export const revoke = internalMutation({
  args: { clientId: v.string(), secretHash: v.optional(v.string()), tokenHash: v.string() },
  handler: async (ctx, { clientId, secretHash, tokenHash }) => {
    const client = await authenticate(ctx, clientId, secretHash);
    if (client === null) return false;
    const token = await tokenRow(ctx, tokenHash);
    const grant = token === null ? null : await ctx.db.get(token.grantId);
    if (grant !== null && grant.clientId === client.clientId) await deleteGrant(ctx, grant._id);
    return true;
  },
});

// ── Keeping the tables small ────────────────────────────────────────────────

const PRUNE_BATCH = 500;

/**
 * Daily (convex/crons.ts): codes and tokens past their life, grants with no
 * token left (nothing can refresh them), and clients that registered
 * themselves and were never approved, after PENDING_CLIENT_MS. A run with
 * more to do schedules its own next one, with no arguments.
 */
export const prune = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const codes = await ctx.db
      .query("oauthCodes")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(PRUNE_BATCH);
    for (const row of codes) await ctx.db.delete(row._id);
    const tokens = await ctx.db
      .query("oauthTokens")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(PRUNE_BATCH);
    for (const row of tokens) await ctx.db.delete(row._id);

    const grants = await ctx.db.query("oauthGrants").take(PRUNE_BATCH);
    for (const grant of grants) {
      const left = await ctx.db
        .query("oauthTokens")
        .withIndex("by_grantId", (q) => q.eq("grantId", grant._id))
        .first();
      if (left === null) await ctx.db.delete(grant._id);
    }

    const stale = await ctx.db
      .query("oauthClients")
      .withIndex("by_createdBy_and_createdAt", (q) =>
        q.eq("createdBy", "dynamic").lt("createdAt", now - PENDING_CLIENT_MS),
      )
      .take(PRUNE_BATCH);
    for (const client of stale) if (!(await hasGrant(ctx, client.clientId))) await ctx.db.delete(client._id);

    if ([codes, tokens, stale].some((rows) => rows.length === PRUNE_BATCH)) {
      await ctx.scheduler.runAfter(0, internal.oauth.prune, {});
    }
    return null;
  },
});
