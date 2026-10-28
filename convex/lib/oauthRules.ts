// OAuth 2.1 for the agent endpoint (POST /mcp/v1), as the Model Context
// Protocol's authorization specification asks of a server (2025-06-18 and
// 2025-11-25): the documents a client discovers (RFC 9728, RFC 8414), the
// redirect URIs a client may register (RFC 7591), scopes, the resource a
// token is for (RFC 8707), PKCE S256 (RFC 7636), what each secret begins
// with, and the fixed words of every refusal. Pure, so the consent page
// quotes the words the server uses. The endpoints are convex/oauth.ts.
//
// The authorization server and the protected resource are one: the OS at
// its public origin (SITE_URL; APP_URL in convex/lib/identity.ts). Its only user is the
// owner.
//
// Nothing here quotes what a client sent: every sentence is fixed words.

import type { AgentScope } from "./agentRules";
import { BOT_ID, isAgentId } from "./agents";
import { PRODUCT, TOKEN_STEM } from "./identity";
import { base64Url } from "./personalRules";

// ── Secrets and lifetimes ───────────────────────────────────────────────────
// Each begins with its own prefix, so none is ever taken for another, nor for
// an agent token (`sosa_`) or a personal one (`sos_`): the fourth character
// is a letter other than "a", never "_".

/** An access token: presented at POST /mcp/v1 as a bearer token. */
export const ACCESS_TOKEN_PREFIX = `${TOKEN_STEM}o_` as const;
/** A refresh token: presented at POST /oauth/token only, rotated on each use. */
export const REFRESH_TOKEN_PREFIX = `${TOKEN_STEM}r_` as const;
/** An authorization code: in the redirect back to the client, used once. */
export const CODE_PREFIX = `${TOKEN_STEM}x_` as const;
/** A client's id: public, the one value of a client that is not secret. */
export const CLIENT_ID_PREFIX = `${TOKEN_STEM}c_` as const;
/** A confidential client's secret. */
export const CLIENT_SECRET_PREFIX = `${TOKEN_STEM}k_` as const;

export const isAccessToken = (given: string): boolean => given.startsWith(ACCESS_TOKEN_PREFIX);

/** How long an access token lasts. */
export const ACCESS_TOKEN_SECONDS = 60 * 60;
/** How long a refresh token lasts unused. Each use replaces it with a new one, of the same life. */
export const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;
/** How long an authorization code lasts: long enough for a client to exchange it at once, no longer. */
export const CODE_SECONDS = 120;

/** Clients registered by themselves that the owner has not approved yet, at most. */
export const MAX_PENDING_CLIENTS = 100;
/**
 * A client that registered itself and was never approved is forgotten after
 * this long. Short: a real client is approved within minutes of registering,
 * and an open registration filled with junk must not block one for days.
 */
export const PENDING_CLIENT_MS = 60 * 60 * 1000;
/** Clients the owner adds by hand, at most. */
export const MAX_HAND_CLIENTS = 20;
/** Redirect URIs one client may register. */
export const MAX_REDIRECT_URIS = 5;
export const MAX_REDIRECT_URI_LENGTH = 512;
/** The most bytes of a body at /oauth/register, /oauth/token and /oauth/revoke. */
export const MAX_OAUTH_BYTES = 8 * 1024;

// ── Where things are ────────────────────────────────────────────────────────

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The path of the agent endpoint, the one protected resource. */
export const MCP_PATH = "/mcp/v1";
/** Where the owner approves a client: a page of the app (src/app/oauth/authorize). */
export const AUTHORIZE_PATH = "/oauth/authorize";
export const TOKEN_PATH = "/oauth/token";
export const REGISTER_PATH = "/oauth/register";
export const REVOKE_PATH = "/oauth/revoke";
export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
export const AUTHORIZATION_SERVER_PATH = "/.well-known/oauth-authorization-server";

/**
 * The app's public origin from SITE_URL: https, or http on this machine, with
 * no path and no credentials. Null for anything else, so nothing is said to
 * be at an address that is not plainly ours.
 */
export function siteOrigin(siteUrl: string | undefined): string | null {
  if (siteUrl === undefined || siteUrl.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(siteUrl.trim());
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  return url.origin;
}

/** The protected resource's identifier: the endpoint's address. */
export const mcpResourceOf = (origin: string) => `${origin}${MCP_PATH}`;

/** Where each bot's own address begins (docs/assistant.md, "Bots"): `/mcp/v1/bot/<bot id>`. */
export const BOT_PATH_PREFIX = `${MCP_PATH}/bot/`;

/** Whether a value could be a bot's id: BOT_ID's shape, and not one of Startup OS's own four. */
const isBotShape = (value: string) => BOT_ID.test(value) && !isAgentId(value);

/**
 * A bot's own address as a protected resource: `${origin}/mcp/v1/bot/<id>`.
 * A grant made for it is that bot's alone.
 */
export const botResourceOf = (origin: string, botId: string) => `${origin}${BOT_PATH_PREFIX}${botId}`;

/** The bot a resource is the address of, or null for the plain endpoint (or anything else). */
export function botOfResource(resource: string, origin: string): string | null {
  const prefix = `${origin}${BOT_PATH_PREFIX}`;
  if (!resource.startsWith(prefix)) return null;
  const id = resource.slice(prefix.length);
  return isBotShape(id) ? id : null;
}

/** The two scopes, as a client asks for them. */
export const SCOPES_SUPPORTED = ["read", "act"] as const;

/** The protected resource's metadata (RFC 9728): the endpoint's, or one bot's own address. */
export function protectedResourceMetadata(origin: string, botId: string | null = null) {
  return {
    resource: botId === null ? mcpResourceOf(origin) : botResourceOf(origin, botId),
    authorization_servers: [origin],
    scopes_supported: [...SCOPES_SUPPORTED],
    bearer_methods_supported: ["header"],
    resource_name: PRODUCT.name,
  };
}

/** The authorization server's metadata (RFC 8414). Authorization code with PKCE S256 only. */
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${AUTHORIZE_PATH}`,
    token_endpoint: `${origin}${TOKEN_PATH}`,
    registration_endpoint: `${origin}${REGISTER_PATH}`,
    revocation_endpoint: `${origin}${REVOKE_PATH}`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: [...SCOPES_SUPPORTED],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false,
    service_documentation: `${origin}/assistant`,
  };
}

/** The header a 401 from the endpoint (or a bot's address) carries: where the resource's metadata is. */
export function wwwAuthenticate(origin: string | null, botId: string | null = null): string {
  if (origin === null) return "Bearer";
  const path = botId === null ? MCP_PATH : `${BOT_PATH_PREFIX}${botId}`;
  return `Bearer resource_metadata="${origin}${PROTECTED_RESOURCE_PATH}${path}"`;
}

// ── What a client sends ─────────────────────────────────────────────────────

/**
 * A redirect URI a client may register, as given, or null: an absolute https
 * address on any host, or http on this machine for a native client (RFC
 * 8252); no fragment, no credentials, at most MAX_REDIRECT_URI_LENGTH. On
 * use it must equal a registered one exactly.
 */
export function checkRedirectUri(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_REDIRECT_URI_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.hash !== "" || value.includes("#")) return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.protocol === "https:") return value;
  if (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname)) return value;
  return null;
}

/** A client's redirect URIs: one to MAX_REDIRECT_URIS, each good, none twice; or null. */
export function checkRedirectUris(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REDIRECT_URIS) return null;
  const kept: string[] = [];
  for (const item of value) {
    const uri = checkRedirectUri(item);
    if (uri === null) return null;
    if (!kept.includes(uri)) kept.push(uri);
  }
  return kept;
}

/**
 * What a `scope` parameter asks for: "act" if it names act, "read" if only
 * read, null if it names nothing. A scope this server does not have is
 * refused, as RFC 6749 asks.
 */
export function parseScope(value: unknown): { ok: true; scope: AgentScope | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, scope: null };
  if (typeof value !== "string") return { ok: false };
  const asked = value.split(" ").filter((part) => part !== "");
  if (asked.length === 0) return { ok: true, scope: null };
  if (asked.some((part) => !(SCOPES_SUPPORTED as readonly string[]).includes(part))) return { ok: false };
  return { ok: true, scope: asked.includes("act") ? "act" : "read" };
}

/** A grant's scope as a token response says it. */
export const scopeString = (scope: AgentScope): string => (scope === "act" ? "read act" : "read");

/**
 * The resource a token is for (RFC 8707): the endpoint, whether the client
 * named it or left it out (some clients only read the authorization server's
 * metadata and never learn it), or one bot's own address (`/mcp/v1/bot/<id>`).
 * One closing slash is forgiven. Anything else
 * is null: a token is never made for another resource.
 */
export function resourceFor(given: unknown, origin: string): string | null {
  const resource = mcpResourceOf(origin);
  if (given === undefined || given === null || given === "") return resource;
  if (typeof given !== "string") return null;
  if (given === resource || given === `${resource}/`) return resource;
  // A bot's own address: the token is for that bot alone.
  const trimmed = given.endsWith("/") ? given.slice(0, -1) : given;
  const bot = botOfResource(trimmed, origin);
  return bot === null ? null : botResourceOf(origin, bot);
}

/** A PKCE code challenge as S256 makes it: 43 characters of base64url. */
export const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** The S256 challenge of a verifier, or null for a verifier RFC 7636 does not allow. */
export async function challengeOf(verifier: string): Promise<string | null> {
  if (!VERIFIER.test(verifier)) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** The client id and secret of an `Authorization: Basic` header, form-decoded (RFC 6749, 2.3.1), or null. */
export function parseBasic(header: string | null): { clientId: string; secret: string } | null {
  if (header === null || !header.startsWith("Basic ")) return null;
  let decoded: string;
  try {
    decoded = atob(header.slice("Basic ".length).trim());
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  try {
    const part = (value: string) => decodeURIComponent(value.replace(/\+/g, " "));
    return { clientId: part(decoded.slice(0, colon)), secret: part(decoded.slice(colon + 1)) };
  } catch {
    return null;
  }
}

/** An address with parameters added to those it holds; one whose value is undefined is left out. */
export function withParams(address: string, params: Record<string, string | undefined>): string {
  const url = new URL(address);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.append(key, value);
  }
  return url.toString();
}

/** The host a redirect goes to, as the consent page names it. */
export const redirectHostOf = (uri: string): string => new URL(uri).host;

// ── The words ───────────────────────────────────────────────────────────────

/** `error_description` for each refusal of the endpoints: fixed words, never what was sent. */
export const OAUTH_WORDS = {
  notConfigured: `${PRODUCT.name} has no public address set (SITE_URL), so it cannot sign clients in.`,
  badRequest: "The request is missing a parameter or holds one that is not valid.",
  tooLarge: `A request may be at most ${MAX_OAUTH_BYTES / 1024} KB.`,
  grantType: "Only authorization_code and refresh_token are supported.",
  badClient: "That client is not registered here, or its secret is wrong.",
  badGrant: "That code or refresh token is not valid: it is unknown, used, expired or revoked, or was issued to another client.",
  badRedirect: "That redirect_uri is not the one the code was issued for.",
  badVerifier: "The code_verifier does not match the code_challenge.",
  badTarget: "That resource is not this server's: tokens are issued for its MCP endpoint only.",
  badScope: 'The scopes are "read" and "act".',
  redirectUris: `Give one to ${MAX_REDIRECT_URIS} redirect_uris: https, or http on localhost for a native client, with no fragment.`,
  metadata: "That client metadata is not supported: authorization_code with PKCE, and the response type code, only.",
  busy: "Too many clients are waiting to be approved. Try again later.",
} as const;

/** What the consent page says, and what the owner's own functions refuse with. */
export const CONSENT_WORDS = {
  ownerOnly: `Only the owner of ${PRODUCT.name} can connect a client, for now. Ask the owner.`,
  unknownClient: `This client is not registered with ${PRODUCT.name}. Go back to it and connect again.`,
  badRedirect: "This client asked to be sent back to an address it did not register. Nothing was approved.",
  badRequest: "This sign-in request is incomplete or not valid, so it cannot be approved. Go back to the client and connect again.",
  approveFailed: "That could not be approved. Try again.",
  nameMissing: "Give the client a name.",
  tooManyClients: `At most ${MAX_HAND_CLIENTS} clients added by hand. Remove one first.`,
} as const;

/** What the response type and challenge method must be. */
export const RESPONSE_TYPE = "code";
export const CHALLENGE_METHOD = "S256";
