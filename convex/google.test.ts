import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { open } from "./lib/tokenCrypto";
import schema from "./schema";
import { OWNER, modules, signInAs, signInAsOwner, type TestBackend } from "./test.setup";
import { finishScheduled } from "./test.timers";

// Nothing here is real: no client, no secret, no token, no deployment.
const NOW = Date.UTC(2026, 9, 12, 6);
const SITE = "https://os.example.test";
const CONVEX_SITE = "https://fake-deployment.convex.site.test";
const REFRESH = "fake-refresh-token-not-real-0001";
const SECRET = "fake-client-secret-not-real";
const KEY = btoa("0123456789abcdef0123456789abcdef");
const STATE = "s".repeat(43);
const VERIFIER = "v".repeat(43);
const CHALLENGE = "c".repeat(43);
const GMAIL = "https://www.googleapis.com/auth/gmail.metadata";
const CALENDAR = "https://www.googleapis.com/auth/calendar.events.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

// The Google account the owner signs in with, and the Workspace it belongs to.
const SUB = "made-up-google-account-0001";
const HD = OWNER.split("@")[1]!;
const idToken = (claims: object) => `h.${btoa(JSON.stringify(claims))}.s`;
const ownerToken = (over: Record<string, unknown> = {}) =>
  idToken({ email: OWNER, email_verified: true, hd: HD, sub: SUB, ...over });
const grant = (over: Record<string, unknown> = {}) => ({
  access_token: "fake-access-token",
  refresh_token: REFRESH,
  scope: `openid https://www.googleapis.com/auth/userinfo.email ${GMAIL} ${CALENDAR}`,
  id_token: ownerToken(),
  ...over,
});

type GoogleCall = { url: string; body: string; redirect: unknown };

/** Stand in for Google. Records every request; answers the token endpoint with `body`. */
function stubGoogle(body: unknown = grant(), status = 200) {
  const calls: GoogleCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? ""), redirect: init?.redirect });
      const revoke = String(url).includes("/revoke");
      return new Response(JSON.stringify(revoke ? {} : body), { status: revoke ? 200 : status });
    }),
  );
  return calls;
}

/** Record which Google account a user signs in with, as Convex Auth does. */
const linkGoogle = (t: TestBackend, email: string, sub: string) =>
  t.run(async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .first();
    await ctx.db.insert("authAccounts", {
      userId: user!._id,
      provider: "google",
      providerAccountId: sub,
    });
  });

async function begun(t: TestBackend, options: { linked?: string | null } = {}) {
  const owner = await signInAsOwner(t);
  const linked = options.linked === undefined ? SUB : options.linked;
  if (linked !== null) await linkGoogle(t, OWNER, linked);
  const url = await owner.mutation(api.google.begin, {
    state: STATE,
    verifier: VERIFIER,
    challenge: CHALLENGE,
  });
  return { owner, url: new URL(url) };
}
const callback = (t: TestBackend, query: string) => t.fetch(`/google/callback?${query}`);
const landed = (response: Response) => response.headers.get("Location");
const stored = (t: TestBackend) => t.run((ctx) => ctx.db.query("oauthConnections").collect());
const states = (t: TestBackend) => t.run((ctx) => ctx.db.query("oauthStates").collect());
const revokes = (calls: GoogleCall[]) => calls.filter((c) => c.url === REVOKE_URL);
const exchanges = (calls: GoogleCall[]) => calls.filter((c) => c.url === TOKEN_URL);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
  vi.stubEnv("SITE_URL", SITE);
  vi.stubEnv("CONVEX_SITE_URL", CONVEX_SITE);
  vi.stubEnv("GOOGLE_WORK_CLIENT_ID", "fake-client-id");
  vi.stubEnv("GOOGLE_WORK_CLIENT_SECRET", SECRET);
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", KEY);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("begin", () => {
  test("asks Google for exactly the read scopes, offline, bound to this attempt", async () => {
    const { url } = await begun(convexTest(schema, modules));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe(`openid email ${GMAIL} ${CALENDAR}`);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe(STATE);
    expect(url.searchParams.get("code_challenge")).toBe(CHALLENGE);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(`${CONVEX_SITE}/google/callback`);
    expect(url.searchParams.get("login_hint")).toBe(OWNER);
    expect(url.searchParams.get("client_id")).toBe("fake-client-id");
    // The verifier and the client secret never travel through the address bar.
    expect(url.toString()).not.toContain(VERIFIER);
    expect(url.toString()).not.toContain(SECRET);
  });

  test("stores the attempt for ten minutes, with who started it", async () => {
    const t = convexTest(schema, modules);
    await begun(t);
    const users = await t.run((ctx) => ctx.db.query("users").collect());
    expect(await states(t)).toMatchObject([
      { state: STATE, verifier: VERIFIER, expiresAt: NOW + 10 * 60 * 1000, userId: users[0]!._id },
    ]);
  });

  test("a signed-in non-owner cannot start a connection", async () => {
    const t = convexTest(schema, modules);
    const stranger = await signInAs(t, { email: "someone@else.test", emailVerificationTime: 1 });
    await expect(
      stranger.mutation(api.google.begin, { state: STATE, verifier: VERIFIER, challenge: CHALLENGE }),
    ).rejects.toThrow("not_owner");
    expect(await states(t)).toEqual([]);
  });

  test("a visitor with no session cannot start a connection", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.google.begin, { state: STATE, verifier: VERIFIER, challenge: CHALLENGE }),
    ).rejects.toThrow("not_owner");
    expect(await states(t)).toEqual([]);
  });

  test.each([
    ["a short state", { state: "short", verifier: VERIFIER, challenge: CHALLENGE }],
    ["a state with a space", { state: `${"s".repeat(42)} `, verifier: VERIFIER, challenge: CHALLENGE }],
    ["a short verifier", { state: STATE, verifier: "short", challenge: CHALLENGE }],
    ["an over-long challenge", { state: STATE, verifier: VERIFIER, challenge: "c".repeat(129) }],
  ])("%s is refused (guard: the NONCE check)", async (_name, args) => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(owner.mutation(api.google.begin, args)).rejects.toThrow(
      "That connect request was malformed. Try again.",
    );
    expect(await states(t)).toEqual([]);
  });

  test("without the client secret it says which variable to set", async () => {
    vi.stubEnv("GOOGLE_WORK_CLIENT_SECRET", "");
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(
      owner.mutation(api.google.begin, { state: STATE, verifier: VERIFIER, challenge: CHALLENGE }),
    ).rejects.toThrow("Set GOOGLE_WORK_CLIENT_SECRET on the Convex deployment first.");
    expect(await states(t)).toEqual([]);
  });

  test("a key that could not seal the grant is found before Google is asked", async () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", "not-a-key");
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(
      owner.mutation(api.google.begin, { state: STATE, verifier: VERIFIER, challenge: CHALLENGE }),
    ).rejects.toThrow("TOKEN_ENCRYPTION_KEY must be 32 random bytes, base64-encoded.");
    expect(await states(t)).toEqual([]);
  });
});

describe("callback", () => {
  test("stores the grant sealed, and sends the browser home", async () => {
    const t = convexTest(schema, modules);
    await begun(t);
    const calls = stubGoogle();
    const response = await callback(t, `code=fake-code&state=${STATE}`);

    expect(response.status).toBe(302);
    expect(landed(response)).toBe(`${SITE}/settings/connections?google=connected`);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const [exchange] = calls;
    expect(exchange?.url).toBe(TOKEN_URL);
    expect(exchange?.redirect).toBe("manual");
    const sent = new URLSearchParams(exchange?.body);
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code")).toBe("fake-code");
    expect(sent.get("code_verifier")).toBe(VERIFIER);
    expect(sent.get("redirect_uri")).toBe(`${CONVEX_SITE}/google/callback`);
    expect(revokes(calls)).toEqual([]);

    const [row] = await stored(t);
    expect(row?.sealedRefreshToken).toMatch(/^v1\./);
    expect(row?.sealedRefreshToken).not.toContain(REFRESH);
    expect(JSON.stringify(row)).not.toContain(REFRESH);
    expect(await open(row!.sealedRefreshToken, "google-refresh-token")).toBe(REFRESH);
    expect(await states(t)).toEqual([]);
  });

  test("without a state the owner created, nothing is asked of Google (guard: takeState)", async () => {
    const t = convexTest(schema, modules);
    const calls = stubGoogle();
    const response = await callback(t, `code=fake-code&state=${"x".repeat(43)}`);
    expect(landed(response)).toBe(`${SITE}/settings/connections?google=expired`);
    expect(calls).toEqual([]);
    expect(await stored(t)).toEqual([]);
  });

  test("another attempt's state does not open this one", async () => {
    const t = convexTest(schema, modules);
    await begun(t);
    const calls = stubGoogle();
    const response = await callback(t, `code=fake-code&state=${"x".repeat(43)}`);
    expect(landed(response)).toBe(`${SITE}/settings/connections?google=expired`);
    expect(calls).toEqual([]);
    expect(await stored(t)).toEqual([]);
    // The owner's own attempt is still usable.
    expect(await states(t)).toHaveLength(1);
  });

  test.each([
    ["no state at all", "code=fake-code"],
    ["a state that is not a nonce", "code=fake-code&state=short"],
    ["nothing", ""],
  ])("%s does nothing at all", async (_name, query) => {
    const t = convexTest(schema, modules);
    await begun(t);
    const calls = stubGoogle();
    const response = await callback(t, query);
    expect(landed(response)).toBe(`${SITE}/settings/connections?google=failed`);
    expect(calls).toEqual([]);
    expect(await stored(t)).toEqual([]);
    expect(await states(t)).toHaveLength(1);
  });

  test("a state works once (guard: the delete in takeState)", async () => {
    const t = convexTest(schema, modules);
    await begun(t);
    const calls = stubGoogle();
    await callback(t, `code=fake-code&state=${STATE}`);
    const again = await callback(t, `code=another-code&state=${STATE}`);
    expect(landed(again)).toBe(`${SITE}/settings/connections?google=expired`);
    expect(exchanges(calls)).toHaveLength(1);
    expect(await stored(t)).toHaveLength(1);
  });

  test("a state is good for ten minutes and not a millisecond more (guard: the expiry check)", async () => {
    const t = convexTest(schema, modules);
    await begun(t);
    const calls = stubGoogle();
    vi.setSystemTime(NOW + 10 * 60 * 1000 + 1);
    const response = await callback(t, `code=fake-code&state=${STATE}`);
    expect(landed(response)).toBe(`${SITE}/settings/connections?google=expired`);
    expect(calls).toEqual([]);
    expect(await stored(t)).toEqual([]);
    // Used up all the same.
    expect(await states(t)).toEqual([]);
  });

  test("just inside ten minutes it still works", async () => {
    const t = convexTest(schema, modules);
    await begun(t);
    stubGoogle();
    vi.setSystemTime(NOW + 10 * 60 * 1000 - 1);
    const response = await callback(t, `code=fake-code&state=${STATE}`);
    expect(landed(response)).toBe(`${SITE}/settings/connections?google=connected`);
  });

  test("starting again cancels the attempt before", async () => {
    const t = convexTest(schema, modules);
    const { owner } = await begun(t);
    const second = "t".repeat(43);
    await owner.mutation(api.google.begin, { state: second, verifier: VERIFIER, challenge: CHALLENGE });
    const calls = stubGoogle();
    const first = await callback(t, `code=fake-code&state=${STATE}`);
    expect(landed(first)).toBe(`${SITE}/settings/connections?google=expired`);
    expect(calls).toEqual([]);
    const response = await callback(t, `code=fake-code&state=${second}`);
    expect(landed(response)).toBe(`${SITE}/settings/connections?google=connected`);
  });

  test("a declined request stores nothing and asks Google nothing", async () => {
    const t = convexTest(schema, modules);
    await begun(t);
    const calls = stubGoogle();
    const response = await callback(t, `error=access_denied&state=${STATE}`);
    expect(landed(response)).toBe(`${SITE}/settings/connections?google=declined`);
    expect(calls).toEqual([]);
    expect(await stored(t)).toEqual([]);
  });

  test("an answer with no refresh token stores nothing", async () => {
    const t = convexTest(schema, modules);
    await begun(t);
    stubGoogle(grant({ refresh_token: undefined }));
    const response = await callback(t, `code=fake-code&state=${STATE}`);
    expect(landed(response)).toBe(`${SITE}/settings/connections?google=no_refresh_token`);
    expect(await stored(t)).toEqual([]);
  });

  test("what Google says about a failure never reaches the browser", async () => {
    const t = convexTest(schema, modules);
    await begun(t);
    stubGoogle({ error: "invalid_grant", error_description: "REMOTE-TEXT" }, 400);
    const response = await callback(t, `code=fake-code&state=${STATE}`);
    expect(landed(response)).toBe(`${SITE}/settings/connections?google=failed`);
    expect(landed(response)).not.toContain("REMOTE-TEXT");
    expect(await response.text()).toBe("");
    expect(await stored(t)).toEqual([]);
  });

  test("an over-long code is not sent anywhere", async () => {
    const t = convexTest(schema, modules);
    await begun(t);
    const calls = stubGoogle();
    const response = await callback(t, `code=${"a".repeat(2049)}&state=${STATE}`);
    expect(landed(response)).toBe(`${SITE}/settings/connections?google=failed`);
    expect(calls).toEqual([]);
  });

  test("the browser is only ever sent to the settings page: no open redirect", async () => {
    const t = convexTest(schema, modules);
    await begun(t);
    const calls = stubGoogle();
    const response = await callback(
      t,
      `code=fake-code&state=${STATE}&redirect=https://evil.test&redirect_uri=https://evil.test/cb&next=//evil.test&google=https://evil.test`,
    );
    expect(landed(response)).toBe(`${SITE}/settings/connections?google=connected`);
    // And the redirect URI named to Google is the fixed one, whatever the request said.
    expect(new URLSearchParams(calls[0]?.body).get("redirect_uri")).toBe(
      `${CONVEX_SITE}/google/callback`,
    );
    expect(calls.every((c) => !c.url.includes("evil.test"))).toBe(true);
  });

  test("with no SITE_URL the browser is sent nowhere", async () => {
    const t = convexTest(schema, modules);
    await begun(t);
    const calls = stubGoogle();
    vi.stubEnv("SITE_URL", "");
    const response = await callback(t, `code=fake-code&state=${STATE}`);
    expect(response.status).toBe(500);
    expect(landed(response)).toBeNull();
    expect(calls).toEqual([]);
    expect(await stored(t)).toEqual([]);
  });

  test("only GET is routed", async () => {
    const t = convexTest(schema, modules);
    await begun(t);
    const calls = stubGoogle();
    const response = await t.fetch(`/google/callback?code=fake-code&state=${STATE}`, {
      method: "POST",
    });
    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
    expect(await stored(t)).toEqual([]);
  });

  test.each([
    [
      "another account's grant",
      grant({ id_token: ownerToken({ email: "other@example.test" }) }),
      "wrong_account",
    ],
    ["an unverified address", grant({ id_token: ownerToken({ email_verified: false }) }), "wrong_account"],
    // The owner's address on an account Google does not vouch for: a personal
    // Google account can be made with any address, verified by a code sent to it.
    [
      "the owner's address with no Workspace domain",
      grant({ id_token: ownerToken({ hd: undefined }) }),
      "wrong_account",
    ],
    [
      "the owner's address under another Workspace",
      grant({ id_token: ownerToken({ hd: "elsewhere.test" }) }),
      "wrong_account",
    ],
    // The right address, vouched for, but not the account the owner signs in with.
    [
      "the owner's address on a different Google account",
      grant({ id_token: ownerToken({ sub: "made-up-google-account-9999" }) }),
      "wrong_account",
    ],
    ["an id token with no account id", grant({ id_token: ownerToken({ sub: undefined }) }), "wrong_account"],
    ["a grant without the mail scope", grant({ scope: `openid ${CALENDAR}` }), "missing_scope"],
    ["a grant without the calendar scope", grant({ scope: `openid ${GMAIL}` }), "missing_scope"],
  ])(
    "%s is not stored, and is handed back to Google (guard: the owner and scope checks)",
    async (_name, body, result) => {
      const t = convexTest(schema, modules);
      await begun(t);
      const calls = stubGoogle(body);
      const response = await callback(t, `code=fake-code&state=${STATE}`);
      expect(landed(response)).toBe(`${SITE}/settings/connections?google=${result}`);
      expect(await stored(t)).toEqual([]);
      const [revoke] = revokes(calls);
      expect(new URLSearchParams(revoke?.body).get("token")).toBe(REFRESH);
      expect(revoke?.redirect).toBe("manual");
    },
  );

  test("a different Google account stores nothing at all, and starts no read", async () => {
    const t = convexTest(schema, modules);
    await begun(t);
    const calls = stubGoogle(grant({ id_token: ownerToken({ sub: "made-up-google-account-9999" }) }));
    const response = await callback(t, `code=fake-code&state=${STATE}`);
    expect(landed(response)).toBe(`${SITE}/settings/connections?google=wrong_account`);
    expect(await stored(t)).toEqual([]);
    expect(await states(t)).toEqual([]);
    expect(revokes(calls)).toHaveLength(1);
    expect(new URLSearchParams(revokes(calls)[0]?.body).get("token")).toBe(REFRESH);
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toEqual([]);
    const left = JSON.stringify(
      await t.run(async (ctx) => [
        ...(await ctx.db.query("sourceStatus").collect()),
        ...(await ctx.db.query("syncRuns").collect()),
      ]),
    );
    expect(left).not.toContain(REFRESH);
  });

  test("the account is the one the user who started the attempt signs in with", async () => {
    // The owner has never signed in with Google here (no linked account), so
    // there is no identity for the grant to match.
    const t = convexTest(schema, modules);
    await begun(t, { linked: null });
    const calls = stubGoogle();
    const response = await callback(t, `code=fake-code&state=${STATE}`);
    expect(landed(response)).toBe(`${SITE}/settings/connections?google=wrong_account`);
    expect(await stored(t)).toEqual([]);
    expect(revokes(calls)).toHaveLength(1);
  });

  test("another user's linked account does not vouch for this attempt", async () => {
    const t = convexTest(schema, modules);
    await begun(t, { linked: "made-up-google-account-9999" });
    // Someone else on the deployment is linked to the account in the grant.
    await signInAs(t, { email: "someone@else.test", emailVerificationTime: 1 });
    await linkGoogle(t, "someone@else.test", SUB);
    stubGoogle();
    const response = await callback(t, `code=fake-code&state=${STATE}`);
    expect(landed(response)).toBe(`${SITE}/settings/connections?google=wrong_account`);
    expect(await stored(t)).toEqual([]);
  });

  test("an owner removed from the allow-list mid-attempt is refused", async () => {
    const t = convexTest(schema, modules);
    await begun(t);
    vi.stubEnv("OWNER_EMAILS", "someone@else.test");
    const calls = stubGoogle();
    const response = await callback(t, `code=fake-code&state=${STATE}`);
    expect(landed(response)).toBe(`${SITE}/settings/connections?google=wrong_account`);
    expect(await stored(t)).toEqual([]);
    expect(revokes(calls)).toHaveLength(1);
  });

  test("the matching identity is accepted: the address, Google's word for it, and the account", async () => {
    const t = convexTest(schema, modules);
    await begun(t);
    const calls = stubGoogle();
    const response = await callback(t, `code=fake-code&state=${STATE}`);
    expect(landed(response)).toBe(`${SITE}/settings/connections?google=connected`);
    expect(await stored(t)).toHaveLength(1);
    expect(revokes(calls)).toEqual([]);
  });

  test("a gmail.com owner needs no Workspace domain: Google issues the address itself", async () => {
    const personal = "made-up-owner@gmail.com";
    vi.stubEnv("OWNER_EMAILS", personal);
    const t = convexTest(schema, modules);
    const owner = await signInAs(t, { email: personal, emailVerificationTime: 1 });
    await linkGoogle(t, personal, SUB);
    await owner.mutation(api.google.begin, { state: STATE, verifier: VERIFIER, challenge: CHALLENGE });
    stubGoogle(grant({ id_token: idToken({ email: personal, email_verified: true, sub: SUB }) }));
    const response = await callback(t, `code=fake-code&state=${STATE}`);
    expect(landed(response)).toBe(`${SITE}/settings/connections?google=connected`);
    expect(await stored(t)).toHaveLength(1);
  });

  test("a grant that cannot be sealed is handed back to Google, not kept in the clear", async () => {
    const t = convexTest(schema, modules);
    await begun(t);
    const calls = stubGoogle();
    // The key is broken between starting and finishing.
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", btoa("too short"));
    const response = await callback(t, `code=fake-code&state=${STATE}`);
    expect(landed(response)).toBe(`${SITE}/settings/connections?google=failed`);
    expect(await stored(t)).toEqual([]);
    expect(new URLSearchParams(revokes(calls)[0]?.body).get("token")).toBe(REFRESH);
    const everything = JSON.stringify(
      await t.run(async (ctx) => [
        ...(await ctx.db.query("oauthConnections").collect()),
        ...(await ctx.db.query("oauthStates").collect()),
        ...(await ctx.db.query("sourceStatus").collect()),
        ...(await ctx.db.query("syncRuns").collect()),
      ]),
    );
    expect(everything).not.toContain(REFRESH);
  });

  test("connecting again replaces the grant: there is only ever one", async () => {
    const t = convexTest(schema, modules);
    const { owner } = await begun(t);
    stubGoogle();
    await callback(t, `code=fake-code&state=${STATE}`);
    const second = "t".repeat(43);
    await owner.mutation(api.google.begin, { state: second, verifier: VERIFIER, challenge: CHALLENGE });
    stubGoogle(grant({ refresh_token: "fake-refresh-token-not-real-0002" }));
    await callback(t, `code=fake-code&state=${second}`);
    const rows = await stored(t);
    expect(rows).toHaveLength(1);
    expect(await open(rows[0]!.sealedRefreshToken, "google-refresh-token")).toBe(
      "fake-refresh-token-not-real-0002",
    );
  });
});

describe("the token stays put", () => {
  async function connected() {
    const t = convexTest(schema, modules);
    const { owner } = await begun(t);
    stubGoogle();
    await callback(t, `code=fake-code&state=${STATE}`);
    return { t, owner };
  }

  test("no public function returns it, sealed or not", async () => {
    const { t, owner } = await connected();
    const [row] = await stored(t);
    const seen = JSON.stringify([
      await owner.query(api.google.connection, {}),
      await owner.query(api.workTools.settings, {}),
      await owner.query(api.workTools.needsReply, {}),
      await owner.query(api.workTools.issues, {}),
      await owner.query(api.workTools.meetings, {}),
      await owner.query(api.sources.list, {}),
      await owner.query(api.sources.recentRuns, {}),
      await owner.query(api.metrics.scorecard, {}),
    ]);
    expect(seen).not.toContain(REFRESH);
    expect(seen).not.toContain(row!.sealedRefreshToken);
    expect(seen).not.toContain(KEY);
    expect(seen).not.toContain(SECRET);
    expect(await owner.query(api.google.connection, {})).toEqual({
      missingEnv: [],
      connected: true,
      connectedAt: row!.connectedAt,
    });
  });

  test("the sealed value is handed to internal callers only", async () => {
    const { t } = await connected();
    const [row] = await stored(t);
    expect(await t.query(internal.google.sealedToken, {})).toBe(row!.sealedRefreshToken);
    // There is no public function of that name to call.
    expect(Object.keys(api.google)).not.toContain("sealedToken");
  });

  test("nothing is logged: no console line, run or status holds a token", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => void lines.push(JSON.stringify(args)));
    }
    const { t, owner } = await connected();
    await finishScheduled(t);
    await owner.mutation(api.google.disconnect, {});
    await finishScheduled(t);
    const rows = await t.run(async (ctx) => [
      ...(await ctx.db.query("syncRuns").collect()),
      ...(await ctx.db.query("sourceStatus").collect()),
      ...(await ctx.db.query("mirrorRecords").collect()),
      ...(await ctx.db.system.query("_scheduled_functions").collect()),
    ]);
    const everything = lines.join("\n") + JSON.stringify(rows);
    for (const secret of [REFRESH, "fake-access-token", SECRET, "fake-code", VERIFIER, KEY]) {
      expect(everything).not.toContain(secret);
    }
  });

  test("a non-owner cannot see whether Google is connected, or disconnect it", async () => {
    const { t } = await connected();
    const stranger = await signInAs(t, { email: "someone@else.test", emailVerificationTime: 1 });
    await expect(stranger.query(api.google.connection, {})).rejects.toThrow("not_owner");
    await expect(stranger.mutation(api.google.disconnect, {})).rejects.toThrow("not_owner");
    await expect(t.query(api.google.connection, {})).rejects.toThrow("not_owner");
    await expect(t.mutation(api.google.disconnect, {})).rejects.toThrow("not_owner");
    expect(await stored(t)).toHaveLength(1);
  });

  test("disconnect deletes the grant and both sources' records, then revokes", async () => {
    const { t, owner } = await connected();
    await t.run(async (ctx) => {
      await ctx.db.insert("mirrorRecords", {
        source: "gmail",
        externalId: "a1",
        sortAt: NOW,
        syncedAt: NOW,
        record: {
          kind: "mail",
          threadId: "a1",
          fromName: "Ada Example",
          fromAddress: "ada@example.test",
          subject: "Made up",
          lastMessageAt: NOW,
        },
      });
      await ctx.db.insert("mirrorRecords", {
        source: "google_calendar",
        externalId: "e1",
        sortAt: NOW,
        syncedAt: NOW,
        record: {
          kind: "event",
          eventId: "e1",
          title: "Made-up meeting",
          startsAt: NOW,
          endsAt: NOW + 1,
          allDay: false,
          attendees: [],
          attendeeCount: 0,
          hasMeetingLink: false,
        },
      });
      await ctx.db.insert("mirrorRecords", {
        source: "fireflies",
        externalId: "m1",
        sortAt: NOW,
        syncedAt: NOW,
        record: {
          kind: "meeting",
          meetingId: "m1",
          title: "Made-up meeting",
          heldAt: NOW,
          durationMinutes: 30,
          participants: [],
          overview: "",
          actionItems: [],
        },
      });
      await ctx.db.insert("sourceStatus", {
        source: "gmail",
        state: "ok",
        lastRunAt: NOW,
        lastOkAt: NOW,
      });
      await ctx.db.insert("oauthStates", { state: "pending", verifier: "v", expiresAt: NOW + 1 });
    });
    const calls = stubGoogle();
    await owner.mutation(api.google.disconnect, {});
    expect(await stored(t)).toEqual([]);
    // Google's two sources are emptied; another tool's records are not this button's to delete.
    const left = await t.run((ctx) => ctx.db.query("mirrorRecords").collect());
    expect(left.map((doc) => doc.source)).toEqual(["fireflies"]);
    expect(await states(t)).toEqual([]);
    expect(await owner.query(api.google.connection, {})).toMatchObject({
      connected: false,
      connectedAt: null,
    });
    expect((await owner.query(api.workTools.needsReply, {})).source).toEqual({
      state: "not_configured",
      message: "Connect Google under Settings → Work tools.",
      lastOkAt: null,
    });

    await finishScheduled(t);
    const [revoke] = revokes(calls);
    expect(new URLSearchParams(revoke?.body).get("token")).toBe(REFRESH);
    expect(await t.query(internal.google.sealedToken, {})).toBeNull();
  });

  // ── Knowing whether a revoke worked ──────────────────────────────────────
  const UNCONFIRMED =
    'Google could not confirm that access was removed. Remove "Startup OS" in your Google Account\'s third-party access page.';
  const CONNECT = "Connect Google under Settings → Work tools.";
  const messages = (t: TestBackend) =>
    t.run(async (ctx) => {
      const rows = await ctx.db.query("sourceStatus").collect();
      return Object.fromEntries(rows.map((row) => [row.source, row.message]));
    });
  /** Google's revoke endpoint answering in turn; the last answer repeats. */
  function stubRevoke(answers: ({ status: number; body?: unknown } | "offline")[]) {
    const times: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        if (!String(url).includes("/revoke")) return new Response("{}", { status: 404 });
        times.push(Date.now());
        const answer = answers[Math.min(times.length - 1, answers.length - 1)]!;
        if (answer === "offline") throw new Error("offline");
        return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status });
      }),
    );
    return times;
  }

  test("a revoke Google confirms is asked once, and leaves no warning", async () => {
    const { t, owner } = await connected();
    const times = stubRevoke([{ status: 200 }]);
    await owner.mutation(api.google.disconnect, {});
    await finishScheduled(t);
    expect(times).toHaveLength(1);
    expect(await messages(t)).toEqual({ gmail: CONNECT, google_calendar: CONNECT });
  });

  test("a grant Google says is already dead counts as revoked", async () => {
    const { t, owner } = await connected();
    const times = stubRevoke([{ status: 400, body: { error: "invalid_token" } }]);
    await owner.mutation(api.google.disconnect, {});
    await finishScheduled(t);
    expect(times).toHaveLength(1);
    expect(await messages(t)).toEqual({ gmail: CONNECT, google_calendar: CONNECT });
  });

  test.each([
    ["500 every time", { status: 500 } as const],
    ["a 400 that is not 'already dead'", { status: 400, body: { error: "invalid_request" } } as const],
    ["a 403", { status: 403 } as const],
    ["a 302", { status: 302 } as const],
    ["no answer at all", "offline" as const],
  ])("%s: three tries, 30 seconds apart, then both sources say so", async (_name, answer) => {
    const { t, owner } = await connected();
    const times = stubRevoke([answer]);
    await owner.mutation(api.google.disconnect, {});
    // What is stored here went at once, whatever Google goes on to say.
    expect(await stored(t)).toEqual([]);
    expect(await t.query(internal.google.sealedToken, {})).toBeNull();
    await finishScheduled(t);
    // Three tries. (A try that gets no answer, or a 5xx, is itself asked twice.)
    const tries = times.filter((at, i) => i === 0 || at - times[i - 1]! >= 30_000);
    expect(tries).toHaveLength(3);
    expect(tries[1]! - tries[0]!).toBeGreaterThanOrEqual(30_000);
    expect(tries[2]! - tries[1]!).toBeGreaterThanOrEqual(30_000);
    expect(await messages(t)).toEqual({ gmail: UNCONFIRMED, google_calendar: UNCONFIRMED });
    expect(JSON.stringify(await messages(t))).not.toContain(REFRESH);
    // And nothing is left waiting to try a fourth time.
    const pending = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (job) => job.state.kind === "pending",
      ),
    );
    expect(pending).toEqual([]);
  });

  test("a revoke that works on the second try leaves no warning", async () => {
    const { t, owner } = await connected();
    const times = stubRevoke([{ status: 403 }, { status: 200 }]);
    await owner.mutation(api.google.disconnect, {});
    await finishScheduled(t);
    expect(times).toHaveLength(2);
    expect(await messages(t)).toEqual({ gmail: CONNECT, google_calendar: CONNECT });
  });

  test("the warning outlasts the next scheduled reads, which only know Google is not connected", async () => {
    const { t, owner } = await connected();
    stubRevoke([{ status: 403 }]);
    await owner.mutation(api.google.disconnect, {});
    await finishScheduled(t);
    await t.action(internal.connectors.gmail.sync, {});
    await t.action(internal.connectors.googleCalendar.sync, {});
    expect(await messages(t)).toEqual({ gmail: UNCONFIRMED, google_calendar: UNCONFIRMED });
  });

  test("a failed revoke still leaves nothing stored here", async () => {
    const { t, owner } = await connected();
    stubRevoke(["offline"]);
    await owner.mutation(api.google.disconnect, {});
    await finishScheduled(t);
    expect(await stored(t)).toEqual([]);
    expect(await t.query(internal.google.sealedToken, {})).toBeNull();
  });

  test("disconnecting when nothing is connected is harmless", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const calls = stubGoogle();
    await owner.mutation(api.google.disconnect, {});
    await finishScheduled(t);
    expect(calls).toEqual([]);
  });
});
