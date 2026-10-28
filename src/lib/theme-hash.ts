import { createHash } from "node:crypto";
import { THEME_SCRIPT } from "./theme";

/**
 * The pre-paint theme script's SHA-256 (`THEME_SCRIPT`, src/lib/theme.ts), as
 * a CSP source. Not in the policy today: script-src allows inline scripts
 * ('unsafe-inline', for Next.js's own), and a browser drops that keyword the
 * moment a hash is listed beside it, which would stop Next.js's. Worked out
 * from the script's text rather than written down, so it is right whatever
 * the text holds (the storage key names the product), on the day the policy
 * moves to hashes or a nonce. Node only: next.config.ts and the tests.
 */
export const THEME_SCRIPT_SHA256 = `sha256-${createHash("sha256").update(THEME_SCRIPT).digest("base64")}`;
