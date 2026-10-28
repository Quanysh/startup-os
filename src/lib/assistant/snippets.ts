// What the Assistant page gives the owner to paste into Claude Code: the
// server entry for a `.mcp.json`, and the same thing as a command. Pure.
//
// The token goes in the file's text and nowhere else. The command never
// takes one: a command line is kept in the shell's history and shown in the
// list of running programs.

import { PRODUCT } from "@convex/lib/identity";


/** What Claude calls the connection, and what its tools are listed under. */
export const MCP_SERVER_NAME = PRODUCT.slug;

/** Where the token goes in a snippet shown without one. */
export const TOKEN_PLACEHOLDER = "<YOUR_TOKEN>";

/**
 * The `.mcp.json` entry for the OS's agent endpoint. With `token` null it
 * holds the placeholder: that is what the page shows once the token just
 * made is gone from its memory.
 */
export function mcpJson({ url, token }: { url: string; token: string | null }): string {
  return JSON.stringify(
    {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: "http",
          url,
          headers: { Authorization: `Bearer ${token ?? TOKEN_PLACEHOLDER}` },
        },
      },
    },
    null,
    2,
  );
}

/** `claude mcp add …` for the same connection, with the placeholder where the token goes. */
export function mcpAddCommand(url: string): string {
  return `claude mcp add --scope user --transport http ${MCP_SERVER_NAME} ${url} --header "Authorization: Bearer ${TOKEN_PLACEHOLDER}"`;
}

/**
 * The remote MCP tool entry for xAI's API (a Grok bot): the endpoint's
 * address, a label, and the value of the `Authorization` header it sends on
 * every request. With `token` null it holds the placeholder.
 */
export function grokTools({ url, token }: { url: string; token: string | null }): string {
  return JSON.stringify(
    {
      tools: [
        {
          type: "mcp",
          server_url: url,
          server_label: MCP_SERVER_NAME,
          authorization: `Bearer ${token ?? TOKEN_PLACEHOLDER}`,
        },
      ],
    },
    null,
    2,
  );
}

/**
 * Connecting claude.ai (the web, the phone apps, routines): a custom
 * connector at the endpoint's address, which signs in to Startup OS with OAuth.
 * No token is made or pasted: the owner approves the connection on Startup OS's
 * own page, and it then appears among the connected clients.
 */
export const CLAUDE_AI_STEPS = [
  "In claude.ai, open Settings, then Connectors, and choose Add custom connector.",
  "Paste the address below as the connector's URL and add it.",
  `Choose Connect. ${PRODUCT.name} opens: sign in as the owner, pick what it may do, and approve.`,
] as const;

/**
 * Connecting the Grok app (grok.com and its apps): a custom MCP connector at
 * the endpoint's address that signs in like claude.ai. A connector screen
 * that asks for a client ID and secret instead gets a client added by hand on
 * the connection page.
 */
export const GROK_APP_STEPS = [
  "In Grok (grok.com or the app), open its connector settings and add a custom MCP connector.",
  "Paste the address below as the connector's URL.",
  `Connect it. ${PRODUCT.name} opens: sign in as the owner, pick what it may do, and approve.`,
  "If it asks for a client ID and a client secret instead, add a client by hand below, with the redirect URI Grok shows, and paste the two it gives you.",
] as const;
