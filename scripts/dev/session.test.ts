// @vitest-environment node
import { createPublicKey, createVerify } from "node:crypto";
import { describe, expect, test } from "vitest";
import { parseEnv } from "./guard";
import {
  APP_URL,
  envFileText,
  envNames,
  newSigningKeys,
  parseMadeSession,
  parseSigninArgs,
  pemOf,
  sessionCookies,
  signSessionToken,
} from "./session";

// One key pair for the file: making one takes a moment.
const KEYS = newSigningKeys();
const SESSION = {
  email: "sales.us@startup-os.test",
  userId: "user123",
  sessionId: "session456",
  refreshTokenId: "refresh789",
  issuer: "http://127.0.0.1:3211",
};
const NOW = Date.parse("2026-10-13T12:00:00Z");

describe("the command line of dev:signin", () => {
  test("nothing asked is the owner, on both companies, opening the browser", () => {
    expect(parseSigninArgs([])).toEqual({
      ok: true,
      args: { role: "owner", companies: "both", open: true },
    });
  });

  test.each([
    [["sales"], { role: "sales", companies: "both", open: true }],
    [["engineer", "--company", "kz"], { role: "engineer", companies: "kz", open: true }],
    [["--company=us", "cofounder"], { role: "cofounder", companies: "us", open: true }],
    [["owner", "--no-open"], { role: "owner", companies: "both", open: false }],
    // Two roles the made-up owner named, each with a focus of its own.
    [["marketing"], { role: "marketing", companies: "both", open: true }],
    [["success", "--company", "kz"], { role: "success", companies: "kz", open: true }],
    [["--company", "both", "--no-open", "sales"], { role: "sales", companies: "both", open: false }],
  ])("%j", (argv, args) => {
    expect(parseSigninArgs(argv)).toEqual({ ok: true, args });
  });

  // Everything that tries to point it somewhere, or name someone, is refused
  // rather than ignored.
  test.each([
    [["--prod"]],
    [["--url", "https://happy-animal-123.convex.cloud"]],
    [["--url=https://happy-animal-123.convex.cloud"]],
    [["--env-file", ".env.push"]],
    [["--deployment", "prod:happy-animal-123"]],
    [["--admin-key", "x"]],
    [["--email", "someone@example.com"]],
    [["-p"]],
    [["owner", "--"]],
    [["someone@example.com"]],
    [["admin"]],
    [["Owner"]],
    [["owner", "sales"]],
    [["--company"]],
    [["--company", "de"]],
    [["--company", "us", "--company", "kz"]],
    [["--company=us,kz"]],
    [["--company", "--no-open"]],
  ])("%j is refused, with the usage", (argv) => {
    const parsed = parseSigninArgs(argv);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("Usage: pnpm dev:signin");
  });

  test("a refusal never repeats what was typed", () => {
    const parsed = parseSigninArgs(["--url", "https://happy-animal-123.convex.cloud"]);
    if (parsed.ok) throw new Error("accepted");
    expect(parsed.reason).not.toContain("happy-animal");
  });
});

describe("signing keys for a local backend", () => {
  test("the private key is one line, and its PEM comes back whole", () => {
    expect(KEYS.JWT_PRIVATE_KEY).not.toMatch(/[\r\n]/);
    const pem = pemOf(KEYS.JWT_PRIVATE_KEY);
    expect(pem.startsWith("-----BEGIN PRIVATE KEY-----\n")).toBe(true); // gitleaks:allow (a PEM header, no key)
    expect(pem.endsWith("\n-----END PRIVATE KEY-----\n")).toBe(true);
    expect(pem.split("\n").every((line) => line.length <= 64)).toBe(true);
  });

  test("the JWKS is the matching public key, for RS256 signatures", () => {
    const jwks = JSON.parse(KEYS.JWKS) as { keys: Record<string, string>[] };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ use: "sig", alg: "RS256", kty: "RSA" });
    // The public half only.
    expect(jwks.keys[0]).not.toHaveProperty("d");
  });

  test("each call makes a new pair", () => {
    expect(newSigningKeys().JWT_PRIVATE_KEY).not.toBe(KEYS.JWT_PRIVATE_KEY);
  });

  test.each(["", "   ", "not a key!", "-----BEGIN PRIVATE KEY----- -----END PRIVATE KEY-----"])( // gitleaks:allow (an empty PEM, no key)
    "%j is not a private key",
    (stored) => {
      expect(() => pemOf(stored)).toThrow("That is not a private key.");
    },
  );

  test("the env file round-trips every value, the key's spaces and the JWKS's quotes included", () => {
    const vars = { OWNER_EMAILS: "owner@startup-os.test", SITE_URL: "http://localhost:3100", ...KEYS };
    const text = envFileText(vars);
    expect(parseEnv(text)).toEqual(vars);
    expect(text.split("\n").filter(Boolean)).toHaveLength(4);
  });

  test("a value that could break out of its line is refused", () => {
    expect(() => envFileText({ A: "one\ntwo" })).toThrow("A must be one line.");
    expect(() => envFileText({ A: `both " and '` })).toThrow("A cannot be written to an env file.");
  });

  test("the names of a listing, and never a value", () => {
    const listing = `JWKS={"keys":[]}\nJWT_PRIVATE_KEY=-----BEGIN PRIVATE KEY----- abc\nOWNER_EMAILS=owner@startup-os.test\n`;
    expect(envNames(listing)).toEqual(["JWKS", "JWT_PRIVATE_KEY", "OWNER_EMAILS"]);
    expect(envNames("No environment variables set (on anonymous deployment anonymous-agent)\n")).toEqual([]);
  });
});

describe("the session token", () => {
  const sign = (session = SESSION) =>
    signSessionToken({ pem: pemOf(KEYS.JWT_PRIVATE_KEY), session, now: NOW });
  const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>;

  test("is a JWT the local backend's public key verifies", () => {
    const [header, payload, signature] = sign().split(".");
    const jwk = (JSON.parse(KEYS.JWKS) as { keys: object[] }).keys[0]!;
    const verified = createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(createPublicKey({ key: jwk as never, format: "jwk" }), signature!, "base64url");
    expect(verified).toBe(true);
    expect(decode(header!)).toEqual({ alg: "RS256", typ: "JWT" });
  });

  test("says who and which session, for an hour, issued by the local backend's site", () => {
    const payload = decode(sign().split(".")[1]!);
    const issuedAt = NOW / 1000;
    expect(payload).toEqual({
      sub: "user123|session456",
      iat: issuedAt,
      iss: "http://127.0.0.1:3211",
      aud: "convex",
      exp: issuedAt + 3600,
    });
  });

  test("a trailing slash on the issuer is not part of it", () => {
    const payload = decode(sign({ ...SESSION, issuer: "http://127.0.0.1:3211/" }).split(".")[1]!);
    expect(payload.iss).toBe("http://127.0.0.1:3211");
  });

  // The signing itself refuses a backend that is not on this machine,
  // whatever let the answer through to here.
  test.each([
    "https://happy-animal-123.convex.site",
    "https://127.0.0.1:3211",
    "http://127.0.0.1.example.com:3211",
    "http://127.0.0.1@happy-animal-123.convex.site",
    "",
  ])("nothing is signed for the issuer %j", (issuer) => {
    expect(() => sign({ ...SESSION, issuer })).toThrow(
      "Refusing to sign: the backend that answered is not a local one.",
    );
  });

  test("a token signed with another key does not verify", () => {
    const other = newSigningKeys();
    const [header, payload, signature] = signSessionToken({
      pem: pemOf(other.JWT_PRIVATE_KEY),
      session: SESSION,
      now: NOW,
    }).split(".");
    const jwk = (JSON.parse(KEYS.JWKS) as { keys: object[] }).keys[0]!;
    expect(
      createVerify("RSA-SHA256")
        .update(`${header}.${payload}`)
        .verify(createPublicKey({ key: jwk as never, format: "jwk" }), signature!, "base64url"),
    ).toBe(false);
  });
});

describe("the cookies and the link", () => {
  test("the two cookies Convex Auth reads on localhost, for the host alone", () => {
    const cookies = sessionCookies({ token: "a.b.c", session: SESSION });
    expect(cookies).toEqual([
      "__convexAuthJWT=a.b.c; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600",
      "__convexAuthRefreshToken=refresh789|session456; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000",
    ]);
    // No Domain: the browser keeps them for the host that set them, nothing wider.
    for (const cookie of cookies) expect(cookie).not.toMatch(/Domain=/i);
  });

  test("the browser is sent to the local app and nowhere else", () => {
    expect(APP_URL).toBe("http://localhost:3100/");
  });
});

describe("reading what the backend answered", () => {
  const printed = JSON.stringify(SESSION, null, 2);

  test("the session, whatever the CLI printed before it", () => {
    expect(parseMadeSession(printed)).toEqual(SESSION);
    expect(parseMadeSession(`A notice from the CLI.\nAnother line {not json}\n${printed}\n`)).toEqual(SESSION);
  });

  test.each([
    "",
    "not json",
    "{}",
    JSON.stringify({ ...SESSION, issuer: "" }),
    JSON.stringify({ ...SESSION, sessionId: 5 }),
    JSON.stringify([SESSION]),
  ])("%j is not a session", (output) => {
    expect(parseMadeSession(output)).toBeNull();
  });
});
