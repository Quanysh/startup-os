/** Where /today/connect, /settings/work-tools and /assistant/connection now are. */
export const CONNECTIONS = "/settings/connections";

/**
 * The Connections address an old one redirects to, keeping only the one
 * parameter that page reads (`google`, a connect attempt's result word, which
 * `GoogleResult` checks against its own list). Nothing else is carried over.
 */
export function connectionsAddress(params: Record<string, string | string[] | undefined>): string {
  const google = params.google;
  return typeof google === "string" && /^[a-z_]{1,40}$/.test(google)
    ? `${CONNECTIONS}?google=${google}`
    : CONNECTIONS;
}
