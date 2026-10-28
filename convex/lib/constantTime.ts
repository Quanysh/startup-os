// Timing-safe secret comparison for the Convex default runtime, which has no
// node:crypto.timingSafeEqual. Both sides are hashed first so the comparison
// always runs over 32 bytes regardless of input length.

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return new Uint8Array(digest);
}

/**
 * True only when `expected` is a non-empty secret and `given` matches it.
 * An unset or empty expected secret never matches, so a missing env var can
 * not be satisfied by an empty bearer token.
 */
export async function secretsEqual(
  given: string,
  expected: string | undefined,
): Promise<boolean> {
  if (!expected) return false;
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
