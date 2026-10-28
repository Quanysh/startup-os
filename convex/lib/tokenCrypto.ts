// Sealing a secret before it is stored. AES-256-GCM with a key that lives
// only in the deployment's environment, so a copy of the database is not a
// copy of the grant. The key is read at call time, never at module scope.
//
// Format: "v1.<12-byte IV>.<ciphertext and tag>", base64url. `purpose` is
// bound in as associated data: a value sealed for one use cannot be opened as
// another. Neither function ever puts the secret or the key in a message.

import { ConnectorError } from "../connectors/errors";

const KEY_ENV = "TOKEN_ENCRYPTION_KEY";
const BAD_KEY = `${KEY_ENV} must be 32 random bytes, base64-encoded.`;
const encoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64 = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/**
 * The key's 32 bytes, or null when the variable does not hold exactly that.
 * Thirty-two zero bytes are refused as well: a placeholder, not a key.
 */
function keyBytes(): Uint8Array<ArrayBuffer> | null {
  try {
    const raw = fromBase64((process.env[KEY_ENV] ?? "").trim());
    return raw.length === 32 && raw.some((byte) => byte !== 0) ? raw : null;
  } catch {
    return null;
  }
}

/** What is wrong with the key, in a sentence that names the variable and nothing else; or null. */
export function keyProblem(): string | null {
  return keyBytes() === null ? BAD_KEY : null;
}

async function key(): Promise<CryptoKey> {
  const raw = keyBytes();
  if (raw === null) throw new ConnectorError(BAD_KEY);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(secret: string, purpose: string): Promise<string> {
  const cryptoKey = await key();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(purpose) },
    cryptoKey,
    encoder.encode(secret),
  );
  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(sealed))}`;
}

export async function open(sealed: string, purpose: string): Promise<string> {
  const [version, iv, data, ...rest] = sealed.split(".");
  const cryptoKey = await key(); // its own message, when the key is the problem
  try {
    if (version !== "v1" || !iv || !data || rest.length > 0) throw new Error("format");
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(iv), additionalData: encoder.encode(purpose) },
      cryptoKey,
      fromBase64(data),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new ConnectorError("The stored Google grant could not be read. Connect Google again.");
  }
}
