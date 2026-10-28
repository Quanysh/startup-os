// The pure parts of `pnpm dev:signin` and of the local backend's first-run
// setup: reading the command line, making and reading signing keys, signing a
// session token, and the cookies that carry it. Nothing here touches a file,
// a process or the network.

import { createPrivateKey, createSign, generateKeyPairSync } from "node:crypto";
import {
  LOCAL_COMPANY_CHOICES,
  LOCAL_ROLES,
  isLocalUrl,
  type LocalCompanyChoice,
  type LocalRole,
} from "../../convex/lib/devLocal";

export const USAGE =
  "pnpm dev:signin [owner|cofounder|sales|engineer|marketing|success] [--company us|kz|both] [--no-open]";

export type SigninArgs = { role: LocalRole; companies: LocalCompanyChoice; open: boolean };

/**
 * What was asked for: a role (the owner unless said), a company (both unless
 * said), and whether to open the browser. Anything else is refused rather
 * than ignored: there is no flag for an address, a URL or a deployment, and a
 * typo must not quietly sign in as the owner.
 */
export function parseSigninArgs(
  argv: readonly string[],
): { ok: true; args: SigninArgs } | { ok: false; reason: string } {
  const refuse = (reason: string) => ({ ok: false as const, reason: `${reason} Usage: ${USAGE}` });
  let role: LocalRole | null = null;
  let companies: LocalCompanyChoice | null = null;
  let open = true;
  for (let i = 0; i < argv.length; i += 1) {
    const word = argv[i]!;
    if (word === "--no-open") {
      open = false;
      continue;
    }
    if (word === "--company" || word.startsWith("--company=")) {
      const value = word === "--company" ? argv[(i += 1)] : word.slice("--company=".length);
      if (companies !== null) return refuse("--company was given twice.");
      if (!LOCAL_COMPANY_CHOICES.includes(value as LocalCompanyChoice)) {
        return refuse("--company takes us, kz or both.");
      }
      companies = value as LocalCompanyChoice;
      continue;
    }
    if (word.startsWith("-")) return refuse("That option is not one this command has.");
    if (role !== null) return refuse("One role at a time.");
    if (!LOCAL_ROLES.includes(word as LocalRole)) {
      return refuse("The role is one of owner, cofounder, sales, engineer, marketing, success.");
    }
    role = word as LocalRole;
  }
  return { ok: true, args: { role: role ?? "owner", companies: companies ?? "both", open } };
}

// ── Signing keys ────────────────────────────────────────────────────────────

/** A fresh key pair as Convex Auth wants it: the private key on one line, and the public JWKS. */
export function newSigningKeys(): { JWT_PRIVATE_KEY: string; JWKS: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    // A Convex env value is one line: the PEM's newlines become spaces.
    JWT_PRIVATE_KEY: pem.trimEnd().replace(/\n/g, " "),
    JWKS: JSON.stringify({
      keys: [{ use: "sig", alg: "RS256", ...publicKey.export({ format: "jwk" }) }],
    }),
  };
}

/** The PEM a stored one-line private key came from. */
export function pemOf(stored: string): string {
  const body = stored.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  if (body === "" || !/^[A-Za-z0-9+/=]+$/.test(body)) throw new Error("That is not a private key.");
  return `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

/**
 * A dotenv file for `convex env set --from-file`. Each value is quoted with
 * whichever quote it does not contain (a JWKS is JSON, full of double quotes).
 */
export function envFileText(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([name, value]) => {
      if (/[\r\n]/.test(value)) throw new Error(`${name} must be one line.`);
      const quote = value.includes('"') ? "'" : '"';
      if (value.includes(quote)) throw new Error(`${name} cannot be written to an env file.`);
      return `${name}=${quote}${value}${quote}\n`;
    })
    .join("");
}

/** The names in what `convex env list` prints (`NAME=value` lines). Values are never kept. */
export function envNames(listing: string): string[] {
  return listing
    .split(/\r?\n/)
    .map((line) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
}

// ── The session ─────────────────────────────────────────────────────────────

/** What `devSession.create` returns. */
export type MadeSession = {
  email: string;
  userId: string;
  sessionId: string;
  refreshTokenId: string;
  issuer: string;
};

/** The made session out of what `convex run` printed, or null when that is not one. */
export function parseMadeSession(output: string): MadeSession | null {
  // The CLI may print notices before the result; the result is the last JSON object.
  const start = output.lastIndexOf("\n{") + 1;
  try {
    const value = JSON.parse(output.slice(output.indexOf("{", start))) as Record<string, unknown>;
    const fields = ["email", "userId", "sessionId", "refreshTokenId", "issuer"] as const;
    if (fields.some((field) => typeof value[field] !== "string" || value[field] === "")) return null;
    return Object.fromEntries(fields.map((field) => [field, value[field]])) as MadeSession;
  } catch {
    return null;
  }
}

const TOKEN_SECONDS = 60 * 60;
const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * A session token as Convex Auth issues one, signed with the LOCAL backend's
 * key. The issuer must be a local address: a token is never made for a
 * backend that is not on this machine.
 */
export function signSessionToken(input: {
  pem: string;
  session: Pick<MadeSession, "userId" | "sessionId" | "issuer">;
  now: number;
}): string {
  const { pem, session, now } = input;
  if (!isLocalUrl(session.issuer)) {
    throw new Error("Refusing to sign: the backend that answered is not a local one.");
  }
  const issuedAt = Math.floor(now / 1000);
  const unsigned = `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url({
    sub: `${session.userId}|${session.sessionId}`,
    iat: issuedAt,
    iss: session.issuer.replace(/\/$/, ""),
    aud: "convex",
    exp: issuedAt + TOKEN_SECONDS,
  })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(createPrivateKey(pem));
  return `${unsigned}.${signature.toString("base64url")}`;
}

/** Where the app runs locally. The one place a sign-in link leads. */
export const APP_URL = "http://localhost:3100/";

/**
 * The two cookies Convex Auth's Next.js middleware reads on localhost. They
 * name no domain, so the browser keeps them for `localhost` alone, whatever
 * port set them.
 */
export function sessionCookies(input: {
  token: string;
  session: Pick<MadeSession, "refreshTokenId" | "sessionId">;
}): string[] {
  const cookie = (name: string, value: string, maxAge: number) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
  return [
    cookie("__convexAuthJWT", input.token, TOKEN_SECONDS),
    cookie(
      "__convexAuthRefreshToken",
      `${input.session.refreshTokenId}|${input.session.sessionId}`,
      30 * 24 * 60 * 60,
    ),
  ];
}
