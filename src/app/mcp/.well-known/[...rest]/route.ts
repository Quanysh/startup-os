import { discoveryAlias } from "@/lib/os/discovery-alias";

// `https://<host>/mcp/.well-known/...`: a client that appends the well-known
// path to the MCP URL. JSON, never the app's HTML page.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const GET = discoveryAlias;
