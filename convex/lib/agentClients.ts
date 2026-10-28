// The clients the owner connects to the agent endpoint (POST /mcp/v1): what
// the page and the server both say of them. Pure, so the UI imports it; the
// lookups that decide who a client is are convex/lib/agentToken.ts, which
// runs only inside Convex.

/** What a token from before clients had names (one at a time) is called on the page and in the audit. */
export const LEGACY_TOKEN_NAME = "Your first token";
