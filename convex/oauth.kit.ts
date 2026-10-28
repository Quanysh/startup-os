// What the OAuth tests share: a client registering itself, the owner
// approving it on the consent page's functions, and the token endpoint. Two
// dots in the name, so Convex does not bundle it.
//
// Every name, address and secret here is made up.

import { api } from "./_generated/api";
import type { AgentScope } from "./lib/agentRules";
import { challengeOf } from "./lib/oauthRules";
import type { TestBackend } from "./test.setup";
import { signInAsOwner } from "./test.setup";

export const SITE = "https://os.example.test";
export const RESOURCE = `${SITE}/mcp/v1`;
export const REDIRECT = "https://claude.example.test/api/mcp/auth_callback";
export const VERIFIER = "made-up-pkce-verifier-0123456789-abcdefghijklmnop";
export const ENTROPY = "fake-browser-entropy-0123456789-abcdefghijklmn";
export const STATE = "made-up state & more=1";

type Owner = Awaited<ReturnType<typeof signInAsOwner>>;
export type Reply = { status: number; body: Record<string, unknown>; headers: Headers };

async function read(response: Response): Promise<Reply> {
  const text = await response.text();
  return { status: response.status, body: text === "" ? {} : JSON.parse(text), headers: response.headers };
}

export const get = async (t: TestBackend, path: string) => read(await t.fetch(path, { method: "GET" }));

/** POST /oauth/register with client metadata (RFC 7591). */
export const register = async (t: TestBackend, metadata: Record<string, unknown>) =>
  read(
    await t.fetch("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metadata),
    }),
  );

/** A public client, as claude.ai registers itself. */
export async function publicClient(t: TestBackend, redirect = REDIRECT) {
  const reply = await register(t, {
    client_name: "Made-up Claude",
    redirect_uris: [redirect],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
  if (reply.status !== 201) throw new Error(`registration was refused: ${JSON.stringify(reply.body)}`);
  return reply.body.client_id as string;
}

/** A form POST to one of the OAuth endpoints. */
export const formPost = async (
  t: TestBackend,
  path: "/oauth/token" | "/oauth/revoke",
  fields: Record<string, string | undefined>,
  headers: Record<string, string> = {},
) => {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) body.set(key, value);
  return read(
    await t.fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
      body: body.toString(),
    }),
  );
};

/** What the client sends to /oauth/authorize, as the consent page's functions take it. */
export async function authorizeRequest(clientId: string, over: Record<string, string | undefined> = {}) {
  return {
    clientId,
    redirectUri: REDIRECT,
    responseType: "code",
    codeChallenge: (await challengeOf(VERIFIER))!,
    codeChallengeMethod: "S256",
    scope: "read act",
    resource: RESOURCE,
    state: STATE,
    ...over,
  };
}

/** The owner approves; the code and the rest of the address the browser is sent to. */
export async function approve(
  owner: Owner,
  clientId: string,
  scope: AgentScope = "act",
  over: Record<string, string | undefined> = {},
) {
  const { redirect } = await owner.mutation(api.oauth.approve, {
    ...(await authorizeRequest(clientId, over)),
    granted: scope,
    entropy: ENTROPY,
  });
  const url = new URL(redirect);
  return { url, code: url.searchParams.get("code")! };
}

/** The code exchanged for tokens, as a public client does it. */
export const exchange = (t: TestBackend, clientId: string, code: string, over: Record<string, string | undefined> = {}) =>
  formPost(t, "/oauth/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: VERIFIER,
    resource: RESOURCE,
    ...over,
  });

/** Registered, approved and exchanged: a client signed in, with its two tokens. */
export async function connected(t: TestBackend, scope: AgentScope = "act") {
  const owner = await signInAsOwner(t);
  const clientId = await publicClient(t);
  const { code } = await approve(owner, clientId, scope);
  const reply = await exchange(t, clientId, code);
  if (reply.status !== 200) throw new Error(`the exchange was refused: ${JSON.stringify(reply.body)}`);
  return {
    owner,
    clientId,
    code,
    access: reply.body.access_token as string,
    refresh: reply.body.refresh_token as string,
    reply,
  };
}
