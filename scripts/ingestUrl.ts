import { APP_HOST, APP_URL } from "../convex/lib/identity";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** The OS's own domain, port included (so the default one only). */
const OS_HOST = APP_HOST;

/**
 * Why this token cannot be sent, or null when it can. The endpoint refuses
 * anything under 32 characters, and the plain character set keeps out whatever
 * a shell or a .env parser treats specially, and whatever makes fetch reject a
 * header with an error that quotes it, token included. The message is fixed so
 * it never echoes the value.
 */
export function ingestTokenProblem(
  value: string,
  variable = "INGEST_TOKEN_CFO_WORKBOOK",
): string | null {
  return /^[A-Za-z0-9_-]{32,}$/.test(value)
    ? null
    : `${variable} must be 32 or more letters, digits, "-" or "_".`;
}

/** Why this URL must not be sent the ingest token, or null when it may be. */
export function ingestUrlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "STARTUP_OS_INGEST_URL is not a URL.";
  }
  // Fixed messages from here on: the URL may carry what must not be printed.
  if (url.username !== "" || url.password !== "") {
    return "STARTUP_OS_INGEST_URL must not contain credentials.";
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    return "STARTUP_OS_INGEST_URL must be https (http is allowed only for localhost).";
  }
  // The deployment's HTTP actions live on *.convex.site, and the OS's own
  // domain passes these routes through to them. That one host is named whole:
  // any other address of the app would redirect a POST to its sign-in page,
  // and "any https host" could be sent the token by a typing slip.
  if (!local && !url.hostname.endsWith(".convex.site") && url.host !== OS_HOST) {
    return `STARTUP_OS_INGEST_URL must be a *.convex.site address, ${APP_URL}, or localhost.`;
  }
  if (url.pathname !== "/ingest/v1") return "STARTUP_OS_INGEST_URL must end in /ingest/v1.";
  return null;
}
