import { describe, expect, test } from "vitest";
import {
  CALENDAR_SCOPE,
  GMAIL_SCOPE,
  GOOGLE_SCOPES,
  parseAccess,
  parseGrant,
} from "./googleParse";

// Obviously fake values throughout.
const REFRESH = "fake-refresh-token-not-real-0001";
const idToken = (claims: unknown) => `h.${btoa(JSON.stringify(claims))}.s`;
const grant = (over: Record<string, unknown> = {}) => ({
  access_token: "fake-access",
  refresh_token: REFRESH,
  scope: `openid https://www.googleapis.com/auth/userinfo.email ${GMAIL_SCOPE} ${CALENDAR_SCOPE}`,
  id_token: idToken({
    email: "founder@example.test",
    email_verified: true,
    sub: "made-up-google-account-id",
    hd: "example.test",
  }),
  ...over,
});

describe("the scopes asked for", () => {
  test("are read-only, and exactly four", () => {
    expect(GOOGLE_SCOPES).toEqual([
      "openid",
      "email",
      "https://www.googleapis.com/auth/gmail.metadata",
      "https://www.googleapis.com/auth/calendar.events.readonly",
    ]);
  });
});

describe("parseGrant", () => {
  test("a full grant for a verified address", () => {
    expect(parseGrant(200, grant())).toEqual({
      kind: "ok",
      refreshToken: REFRESH,
      email: "founder@example.test",
      sub: "made-up-google-account-id",
      hd: "example.test",
    });
  });

  test("the Workspace domain is passed on only when Google states one", () => {
    const personal = grant({
      id_token: idToken({ email: "someone@gmail.com", email_verified: true, sub: "s1" }),
    });
    expect(parseGrant(200, personal)).toEqual({
      kind: "ok",
      refreshToken: REFRESH,
      email: "someone@gmail.com",
      sub: "s1",
      hd: undefined,
    });
    const odd = grant({
      id_token: idToken({ email: "a@example.test", email_verified: true, sub: "s1", hd: 7 }),
    });
    expect(parseGrant(200, odd)).toMatchObject({ kind: "ok", hd: undefined });
  });

  test.each([[undefined], [""], [7], [null]])(
    "an id token whose account id is %j is not an account that can be matched",
    (sub) => {
      const body = grant({
        id_token: idToken({ email: "founder@example.test", email_verified: true, hd: "example.test", sub }),
      });
      expect(parseGrant(200, body)).toEqual({ kind: "wrong_account", refreshToken: REFRESH });
    },
  );

  test("the address is trimmed and lower-cased", () => {
    const body = grant({ id_token: idToken({ email: " Founder@Example.TEST ", email_verified: true, sub: "s1" }) });
    expect(parseGrant(200, body)).toMatchObject({ kind: "ok", email: "founder@example.test" });
  });

  test("an ID token in base64url, without padding, is read", () => {
    const payload = btoa(JSON.stringify({ email: "founder@example.test", email_verified: true, sub: "s1", x: "??>>" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(parseGrant(200, grant({ id_token: `h.${payload}.s` }))).toMatchObject({ kind: "ok" });
  });

  test.each([[400], [401], [500], [302]])("status %i is a failure whatever the body", (status) => {
    expect(parseGrant(status, grant())).toEqual({ kind: "failed" });
    expect(parseGrant(status, { error: "invalid_grant", error_description: "REMOTE-TEXT" })).toEqual({
      kind: "failed",
    });
  });

  test.each([[null], [undefined], ["text"], [[grant()]], [7]])(
    "a 200 whose body is %j is a failure",
    (body) => {
      expect(parseGrant(200, body)).toEqual({ kind: "failed" });
    },
  );

  test.each([[undefined], [""], [7]])("no refresh token (%j)", (value) => {
    expect(parseGrant(200, grant({ refresh_token: value }))).toEqual({ kind: "no_refresh_token" });
  });

  test.each([
    ["no mail scope", `openid ${CALENDAR_SCOPE}`],
    ["no calendar scope", `openid ${GMAIL_SCOPE}`],
    ["neither", "openid email"],
    ["no scope string", undefined],
    ["a scope that only starts like the mail one", `${GMAIL_SCOPE}.other ${CALENDAR_SCOPE}`],
  ])("%s is a missing scope, and the token is handed back for revoking", (_name, scope) => {
    expect(parseGrant(200, grant({ scope }))).toEqual({ kind: "missing_scope", refreshToken: REFRESH });
  });

  test.each([
    ["no ID token", undefined],
    ["an ID token that is not a string", 7],
    ["an ID token with one part", "only-one-part"],
    ["an ID token that is not base64", "h.%%%.s"],
    ["an ID token that is not JSON", `h.${btoa("not json")}.s`],
    ["claims that are not an object", idToken(["founder@example.test"])],
    ["an unverified address", idToken({ email: "founder@example.test", email_verified: false })],
    ["verified as the string 'true'", idToken({ email: "founder@example.test", email_verified: "true" })],
    ["no verification claim", idToken({ email: "founder@example.test" })],
    ["no address", idToken({ email_verified: true })],
    ["an address that is not a string", idToken({ email: 7, email_verified: true })],
  ])("%s is the wrong account", (_name, token) => {
    expect(parseGrant(200, grant({ id_token: token }))).toEqual({
      kind: "wrong_account",
      refreshToken: REFRESH,
    });
  });
});

describe("parseAccess", () => {
  test("an access token", () => {
    expect(parseAccess(200, { access_token: "fake-access", expires_in: 3599 })).toEqual({
      kind: "ok",
      token: "fake-access",
    });
  });

  test("a grant Google no longer accepts", () => {
    expect(parseAccess(400, { error: "invalid_grant" })).toEqual({ kind: "revoked" });
  });

  test.each([
    [400, { error: "invalid_client" }],
    [400, null],
    [401, { error: "invalid_grant" }],
    [200, {}],
    [200, { access_token: "" }],
    [200, { access_token: 7 }],
    [200, "fake-access"],
    [500, { access_token: "fake-access" }],
  ])("status %i with %j is a failure", (status, body) => {
    expect(parseAccess(status, body)).toEqual({ kind: "failed" });
  });
});
