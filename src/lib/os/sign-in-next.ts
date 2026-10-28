// Where sign-in returns to. Every page but one sends a signed-out visitor to
// /signin and, once signed in, to "/". The one is OAuth's consent page
// (/oauth/authorize, src/app/oauth/authorize): a client such as claude.ai or
// the Grok app opens it with its request in the address, and the owner who
// is not signed in on that browser must come back to the same request.
//
// The return address is held to that page on this site, whole, so the
// redirect cannot be pointed anywhere else. No imports: src/proxy.ts reads it.

export const SIGN_IN = "/signin";
const CONSENT = "/oauth/authorize";
/** Longer than any request a client sends; an address past it is not one. */
const MAX_NEXT = 4_000;

/** Where to send a signed-out visitor of `pathname` (with its `search`, "?…" or ""). */
export function signInPathFor(pathname: string, search: string): string {
  if (pathname !== CONSENT) return SIGN_IN;
  return `${SIGN_IN}?next=${encodeURIComponent(`${CONSENT}${search}`)}`;
}

/** The consent page and its request, if `value` is exactly that; else null. */
export function safeNext(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length > MAX_NEXT) return null;
  if (value !== CONSENT && !value.startsWith(`${CONSENT}?`)) return null;
  // Nothing a browser could read as another place or another line.
  if (/[\s\\#]/.test(value)) return null;
  return value;
}
