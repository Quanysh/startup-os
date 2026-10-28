// The randomness behind "Connect Google", made in the owner's browser: a
// Convex mutation cannot be relied on for secure random values.

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** 32 random bytes, as 43 base64url characters. */
export function randomNonce(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The PKCE challenge for a verifier: its SHA-256, base64url (RFC 7636, S256). */
export async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}
