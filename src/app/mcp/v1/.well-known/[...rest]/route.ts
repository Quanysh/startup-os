import { discoveryAlias } from "@/lib/os/discovery-alias";

// `https://<host>/mcp/v1/.well-known/...`: the same, for the versioned MCP URL.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const GET = discoveryAlias;
