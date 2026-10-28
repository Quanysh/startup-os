import { describe, expect, test } from "vitest";
import {
  ACCESS_TOKEN_PREFIX,
  CLIENT_ID_PREFIX,
  CLIENT_SECRET_PREFIX,
  CODE_PREFIX,
  REFRESH_TOKEN_PREFIX,
  authorizationServerMetadata,
  checkRedirectUri,
  checkRedirectUris,
  challengeOf,
  isAccessToken,
  parseBasic,
  parseScope,
  protectedResourceMetadata,
  resourceFor,
  scopeString,
  siteOrigin,
  withParams,
  wwwAuthenticate,
} from "./oauthRules";
import { AGENT_TOKEN_PREFIX } from "./agentRules";
import { PERSONAL_TOKEN_PREFIX } from "./personalRules";

const SITE = "https://os.example.test";

describe("the site's origin", () => {
  test("is SITE_URL without a closing slash, https or a local http", () => {
    expect(siteOrigin("https://os.example.test/")).toBe(SITE);
    expect(siteOrigin("http://localhost:3100")).toBe("http://localhost:3100");
    expect(siteOrigin("http://127.0.0.1:3100/")).toBe("http://127.0.0.1:3100");
  });

  test("anything else is no origin at all", () => {
    for (const bad of [undefined, "", "not a url", "http://os.example.test", "https://user:pass@os.example.test", "https://os.example.test/app"]) {
      expect(siteOrigin(bad), String(bad)).toBeNull();
    }
  });
});

describe("the documents a client discovers", () => {
  test("the protected resource names the endpoint, the authorization server and the two scopes (RFC 9728)", () => {
    expect(protectedResourceMetadata(SITE)).toEqual({
      resource: `${SITE}/mcp/v1`,
      authorization_servers: [SITE],
      scopes_supported: ["read", "act"],
      bearer_methods_supported: ["header"],
      resource_name: "Startup OS",
    });
  });

  test("the authorization server says code with PKCE S256 only, both client kinds, registration and revocation (RFC 8414)", () => {
    const doc = authorizationServerMetadata(SITE);
    expect(doc).toMatchObject({
      issuer: SITE,
      authorization_endpoint: `${SITE}/oauth/authorize`,
      token_endpoint: `${SITE}/oauth/token`,
      registration_endpoint: `${SITE}/oauth/register`,
      revocation_endpoint: `${SITE}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: ["read", "act"],
      authorization_response_iss_parameter_supported: true,
    });
    // No implicit flow and no password grant are offered.
    expect(JSON.stringify(doc)).not.toMatch(/"password"|"implicit"|"plain"|"client_credentials"/);
  });

  test("a 401 points the client at the resource's document", () => {
    expect(wwwAuthenticate(SITE)).toBe(
      `Bearer resource_metadata="${SITE}/.well-known/oauth-protected-resource/mcp/v1"`,
    );
    expect(wwwAuthenticate(null)).toBe("Bearer");
  });
});

describe("redirect URIs", () => {
  test("any https address, and http on this machine for a native client", () => {
    for (const uri of [
      "https://claude.ai/api/mcp/auth_callback",
      "https://grok.example.test/connectors/callback?x=1",
      "http://localhost:33418/callback",
      "http://127.0.0.1:5000/cb",
      "http://[::1]:5000/cb",
    ]) {
      expect(checkRedirectUri(uri), uri).toBe(uri);
    }
  });

  test("refused: plain http elsewhere, a fragment, credentials, another scheme, too long", () => {
    for (const uri of [
      "http://claude.example.test/cb",
      "https://claude.example.test/cb#frag",
      "https://user:pw@claude.example.test/cb",
      "javascript:alert(1)",
      "custom-app://callback",
      "https://claude.example.test/" + "x".repeat(600),
      "not a url",
      "",
    ]) {
      expect(checkRedirectUri(uri), uri).toBeNull();
    }
  });

  test("a list is one to five of them, all good, none twice", () => {
    expect(checkRedirectUris(["https://a.example.test/cb"])).toEqual(["https://a.example.test/cb"]);
    expect(checkRedirectUris([])).toBeNull();
    expect(checkRedirectUris(["https://a.example.test/cb", "http://a.example.test/cb"])).toBeNull();
    expect(checkRedirectUris(Array.from({ length: 6 }, (_, n) => `https://a.example.test/${n}`))).toBeNull();
    expect(checkRedirectUris(["https://a.example.test/cb", "https://a.example.test/cb"])).toEqual(["https://a.example.test/cb"]);
    expect(checkRedirectUris("https://a.example.test/cb" as unknown)).toBeNull();
  });
});

describe("scope", () => {
  test("read and act, in any order; nothing asked is null; anything else is refused", () => {
    expect(parseScope("read")).toEqual({ ok: true, scope: "read" });
    expect(parseScope("act read")).toEqual({ ok: true, scope: "act" });
    expect(parseScope("act")).toEqual({ ok: true, scope: "act" });
    expect(parseScope(undefined)).toEqual({ ok: true, scope: null });
    expect(parseScope("  ")).toEqual({ ok: true, scope: null });
    expect(parseScope("read admin")).toEqual({ ok: false });
    expect(scopeString("read")).toBe("read");
    expect(scopeString("act")).toBe("read act");
  });
});

describe("the resource a token is for (RFC 8707)", () => {
  test("left out, it is the endpoint; given, it must be the endpoint", () => {
    expect(resourceFor(undefined, SITE)).toBe(`${SITE}/mcp/v1`);
    expect(resourceFor("", SITE)).toBe(`${SITE}/mcp/v1`);
    expect(resourceFor(`${SITE}/mcp/v1`, SITE)).toBe(`${SITE}/mcp/v1`);
    expect(resourceFor(`${SITE}/mcp/v1/`, SITE)).toBe(`${SITE}/mcp/v1`);
    expect(resourceFor("https://elsewhere.example.test/mcp/v1", SITE)).toBeNull();
    expect(resourceFor(`${SITE}/ingest/v1`, SITE)).toBeNull();
  });
});

describe("PKCE S256", () => {
  test("the challenge is the base64url SHA-256 of the verifier (RFC 7636, appendix B)", async () => {
    expect(await challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  test("a verifier that is not 43 to 128 of its characters has no challenge", async () => {
    for (const bad of ["short", "x".repeat(129), `${"x".repeat(42)} `, `${"x".repeat(43)}!`]) {
      expect(await challengeOf(bad), bad).toBeNull();
    }
  });
});

describe("what each secret begins with", () => {
  test("none is taken for another: not an agent token, not a personal token, not each other", () => {
    const prefixes = [ACCESS_TOKEN_PREFIX, REFRESH_TOKEN_PREFIX, CODE_PREFIX, CLIENT_ID_PREFIX, CLIENT_SECRET_PREFIX];
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const prefix of prefixes) {
      const sample = `${prefix}${"x".repeat(43)}`;
      expect(sample.startsWith(AGENT_TOKEN_PREFIX), prefix).toBe(false);
      expect(sample.startsWith(PERSONAL_TOKEN_PREFIX), prefix).toBe(false);
      expect(isAccessToken(sample)).toBe(prefix === ACCESS_TOKEN_PREFIX);
    }
  });
});

describe("the redirect back", () => {
  test("adds the parameters to what the address already holds, encoded", () => {
    expect(withParams("https://claude.example.test/cb?x=1", { code: "abc", state: "a b&c", iss: SITE })).toBe(
      "https://claude.example.test/cb?x=1&code=abc&state=a+b%26c&iss=https%3A%2F%2Fos.example.test",
    );
    expect(withParams("https://claude.example.test/cb", { error: "access_denied", state: undefined })).toBe(
      "https://claude.example.test/cb?error=access_denied",
    );
  });
});

describe("HTTP Basic client authentication", () => {
  test("is the client id and secret, form-decoded (RFC 6749, 2.3.1)", () => {
    const header = `Basic ${btoa("sosc_client%3Aid:se%2Bcret")}`;
    expect(parseBasic(header)).toEqual({ clientId: "sosc_client:id", secret: "se+cret" });
  });

  test("anything else is not Basic", () => {
    expect(parseBasic(null)).toBeNull();
    expect(parseBasic("Bearer x")).toBeNull();
    expect(parseBasic("Basic !!!")).toBeNull();
    expect(parseBasic(`Basic ${btoa("no-colon")}`)).toBeNull();
  });
});
