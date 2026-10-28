// Where a teammate's Claude sends their records: the ingest endpoint, worked
// out from the site's own configuration. Pure; the page and the pass-through
// routes pass the public variables in.
//
// The endpoint has two addresses. The deployment's own (*.convex.site) is
// held to the rules the push scripts hold STARTUP_OS_INGEST_URL to
// (scripts/ingestUrl.ts): https on a *.convex.site host, or http on this
// machine, and no credentials. The app's public origin (NEXT_PUBLIC_OS_URL),
// where one is configured, passes the same token routes through to it
// (src/lib/os/pass-through.ts) and is the one shown: it stays the same if the
// deployment behind it ever changes. The prompt tells a token where to go, so
// an address that fails the rules is not shown at all.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const INGEST_PATH = "/ingest/v1";
/** The owner's agent endpoint (convex/mcp.ts), passed through at the same path. */
const MCP_PATH = "/mcp/v1";

function parse(value: string | undefined): URL | null {
  if (value === undefined || value.trim() === "") return null;
  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
}

/**
 * The HTTP-actions address for a Convex client address: `*.convex.cloud` is
 * served at `*.convex.site`, and a local backend's actions are on the port
 * after its own (3210 → 3211).
 */
function siteOf(convex: URL): URL | null {
  const site = new URL(convex.origin);
  if (LOCAL_HOSTS.has(convex.hostname)) {
    const port = Number(convex.port);
    if (!Number.isInteger(port) || port <= 0) return null;
    site.port = String(port + 1);
    return site;
  }
  if (!convex.hostname.endsWith(".convex.cloud")) return null;
  site.hostname = convex.hostname.replace(/\.convex\.cloud$/, ".convex.site");
  return site;
}

function allowed(url: URL): boolean {
  if (url.username !== "" || url.password !== "") return false;
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return false;
  return local || url.hostname.endsWith(".convex.site");
}

/**
 * Which deployment an address is: the host without `.convex.cloud` or
 * `.convex.site` (a regional host keeps its region), or the local host and
 * port. Null when it is neither.
 */
function deploymentKey(url: URL): string | null {
  const host = url.hostname;
  if (host.endsWith(".convex.cloud")) return host.slice(0, -".convex.cloud".length);
  if (host.endsWith(".convex.site")) return host.slice(0, -".convex.site".length);
  if (LOCAL_HOSTS.has(host)) return `local:${host}:${url.port}`;
  return null;
}

/**
 * The origin of the deployment's HTTP actions, or null when the configuration
 * does not give one a token may be sent to.
 *
 * Derived from `convexUrl` (NEXT_PUBLIC_CONVEX_URL: `.convex.cloud` becomes
 * `.convex.site`, and a local backend's actions are the next port). `siteUrl`
 * (NEXT_PUBLIC_CONVEX_SITE_URL) is used when it is that same deployment, or
 * when no client URL was given. A site URL that names a different deployment
 * is ignored: the client URL is the one `convex deploy` injects for this
 * build, and a dev address left in the project would otherwise send every
 * pass-through — including OAuth discovery and token refresh — at a backend
 * that does not have those routes.
 */
export function convexSiteOrigin(config: { siteUrl?: string; convexUrl?: string }): string | null {
  const given = parse(config.siteUrl);
  const convex = parse(config.convexUrl);
  const derived = convex === null ? null : siteOf(convex);
  if (given !== null && derived !== null && allowed(given) && allowed(derived)) {
    const givenKey = deploymentKey(given);
    const derivedKey = deploymentKey(derived);
    if (givenKey === null || derivedKey === null || givenKey !== derivedKey) return derived.origin;
  }
  const site = given ?? derived;
  return site === null || !allowed(site) ? null : site.origin;
}

/**
 * The app's public origin (NEXT_PUBLIC_OS_URL, e.g. https://os.example.test),
 * or null when the value is unset or is anything but an https origin: no
 * path, no query, no fragment, no credentials.
 */
export function publicOrigin(value: string | undefined): string | null {
  const url = parse(value);
  if (url === null || url.protocol !== "https:") return null;
  // Whatever else the value carried would show in its serialised form.
  return url.href === `${url.origin}/` ? url.origin : null;
}

/**
 * Whether a token may be told to go to this address: the configured public
 * origin's own /ingest/v1, or an address on *.convex.site or this machine.
 * Never "any https address".
 */
export function ingestAddressAllowed(address: string, osUrl?: string): boolean {
  return addressAllowed(address, INGEST_PATH, osUrl);
}

/** The same rule for any one of the token routes: this exact path, on an address a token may go to. */
function addressAllowed(address: string, path: string, osUrl?: string): boolean {
  const url = parse(address);
  if (url === null || url.pathname !== path || url.search !== "" || url.hash !== "") {
    return false;
  }
  const os = publicOrigin(osUrl);
  if (os !== null && url.href === `${os}${path}`) return true;
  return allowed(url);
}

type Addresses = { siteUrl?: string; convexUrl?: string; osUrl?: string };

/** A token route's address to show, or null: the public origin's where one is configured, else the deployment's. */
function endpointOf(config: Addresses, path: string): string | null {
  const site = convexSiteOrigin(config);
  if (site === null) return null;
  const osSet = config.osUrl !== undefined && config.osUrl.trim() !== "";
  const os = publicOrigin(config.osUrl);
  if (osSet && os === null) return null;
  const address = `${os ?? site}${path}`;
  return addressAllowed(address, path, config.osUrl) ? address : null;
}

/**
 * The ingest endpoint to show, or null when the configuration does not give
 * one that a token may be sent to. With `osUrl` (NEXT_PUBLIC_OS_URL) set it is
 * that origin's /ingest/v1, and only while there is a deployment for it to
 * pass the request to; a value that is not a public origin gives nothing
 * rather than the other address in its place. Unset, it is the deployment's.
 */
export function ingestUrlOf(config: Addresses): string | null {
  return endpointOf(config, INGEST_PATH);
}

/**
 * Where the owner's Claude is pointed: the agent endpoint (POST /mcp/v1), by
 * the very rules the ingest address is held to. With `osUrl` set it is that
 * origin's /mcp/v1, passed through to the deployment; a value that is not a
 * public origin gives nothing rather than the other address in its place;
 * unset, it is the deployment's own. The page puts this address beside the
 * owner's token, so one that fails the rules is not shown at all.
 */
export function mcpUrlOf(config: Addresses): string | null {
  return endpointOf(config, MCP_PATH);
}
