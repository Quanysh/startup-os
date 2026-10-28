// Pure readers of Google's token endpoint. They return a verdict; they never
// throw and never build a message from what Google sent.

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.metadata";
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
/** Asked for at connect. `openid email` only says whose account it is. */
export const GOOGLE_SCOPES = ["openid", "email", GMAIL_SCOPE, CALENDAR_SCOPE] as const;
const REQUIRED = [GMAIL_SCOPE, CALENDAR_SCOPE];

/** Google's token endpoint, and what the stored refresh token is sealed as. */
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_TOKEN_PURPOSE = "google-refresh-token";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type Grant =
  | {
      kind: "ok";
      refreshToken: string;
      email: string;
      /** Google's id for the account: what makes it this account and no other. */
      sub: string;
      /** The Workspace domain the account belongs to, when Google states one. */
      hd: string | undefined;
    }
  | { kind: "failed" | "no_refresh_token" }
  | { kind: "missing_scope" | "wrong_account"; refreshToken: string };

// The ID token comes straight from Google's token endpoint over TLS, in
// answer to our own request, so its claims are read without checking the
// signature (Google's documented allowance for this exact case).
function idTokenClaims(token: unknown): Record<string, unknown> | null {
  if (typeof token !== "string") return null;
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const bytes = Uint8Array.from(
      atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isRecord(claims) ? claims : null;
  } catch {
    return null;
  }
}

export function parseGrant(status: number, json: unknown): Grant {
  if (status !== 200 || !isRecord(json)) return { kind: "failed" };
  const refreshToken = json.refresh_token;
  if (typeof refreshToken !== "string" || refreshToken === "") return { kind: "no_refresh_token" };
  const granted = new Set(typeof json.scope === "string" ? json.scope.split(" ") : []);
  if (!REQUIRED.every((scope) => granted.has(scope))) return { kind: "missing_scope", refreshToken };
  const claims = idTokenClaims(json.id_token);
  if (
    claims?.email_verified !== true ||
    typeof claims.email !== "string" ||
    typeof claims.sub !== "string" ||
    claims.sub === ""
  ) {
    return { kind: "wrong_account", refreshToken };
  }
  return {
    kind: "ok",
    refreshToken,
    email: claims.email.trim().toLowerCase(),
    sub: claims.sub,
    hd: typeof claims.hd === "string" ? claims.hd : undefined,
  };
}

export type Access = { kind: "ok"; token: string } | { kind: "revoked" | "failed" };

export function parseAccess(status: number, json: unknown): Access {
  if (status === 200 && isRecord(json) && typeof json.access_token === "string" && json.access_token !== "") {
    return { kind: "ok", token: json.access_token };
  }
  if (status === 400 && isRecord(json) && json.error === "invalid_grant") return { kind: "revoked" };
  return { kind: "failed" };
}
