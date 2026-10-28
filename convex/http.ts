import { httpRouter } from "convex/server";
import {
  configV1 as agentsConfigV1,
  jobsV1 as agentsJobsV1,
  resultsV1 as agentsResultsV1,
  usageV1 as agentsUsageV1,
} from "./agentsApi";
import { auth } from "./auth";
import { callback as googleCallback } from "./google";
import { ingestV1 } from "./ingest";
import { getBotV1 as mcpGetBotV1, getV1 as mcpGetV1, mcpBotV1, mcpV1 } from "./mcp";
import {
  authorizationServer as oauthAuthorizationServer,
  protectedResource as oauthProtectedResource,
  protectedResourceBot as oauthProtectedResourceBot,
  registerV1 as oauthRegister,
  revokeV1 as oauthRevoke,
  tokenV1 as oauthToken,
} from "./oauth";
import { openV1 as standupOpenV1, tasksV1 as standupTasksV1 } from "./standup";
import { webhookV1 as telegramWebhookV1 } from "./telegramInbound";
import { ackV1 as visibleAckV1, outboxV1 as visibleOutboxV1 } from "./visibleOutbox";

const http = httpRouter();

// Convex Auth's routes: OAuth callbacks and token endpoints.
auth.addHttpRoutes(http);

http.route({ path: "/ingest/v1", method: "POST", handler: ingestV1 });

// Visible write-back (convex/visibleOutbox.ts, docs/ingest.md): the investor
// changes queued here, and the daily run's ack of each. Both need
// INGEST_TOKEN_VISIBLE and refuse every other token. Not passed through the
// app: the run calls the deployment's own *.convex.site address.
http.route({ path: "/ingest/v1/visible/outbox", method: "GET", handler: visibleOutboxV1 });
http.route({ path: "/ingest/v1/visible/outbox/ack", method: "POST", handler: visibleAckV1 });

// The daily standup's tasks (docs/ingest.md, "Standup tasks"): what the board
// already holds, and the tasks that were missing. Both need INGEST_TOKEN_STANDUP.
http.route({ path: "/standup/v1/open", method: "GET", handler: standupOpenV1 });
http.route({ path: "/standup/v1/tasks", method: "POST", handler: standupTasksV1 });

// Where Telegram sends what is said to the bot in a group (convex/telegramInbound.ts).
// Refuses anything without the secret derived from the bot's token.
http.route({ path: "/telegram/v1/webhook", method: "POST", handler: telegramWebhookV1 });

// The owner's agent (convex/mcp.ts): the Model Context Protocol, for the
// owner's Claude and nobody else's. POST refuses anything but the owner's
// agent token; GET says there is no stream to open (405).
http.route({ path: "/mcp/v1", method: "POST", handler: mcpV1 });
http.route({ path: "/mcp/v1", method: "GET", handler: mcpGetV1 });
// Each bot's own address, `/mcp/v1/bot/<bot id>`: the same endpoint, every
// call there that bot's. The handler takes exactly one segment of a bot id's
// shape after the prefix and answers 404 for anything else.
http.route({ pathPrefix: "/mcp/v1/bot/", method: "POST", handler: mcpBotV1 });
http.route({ pathPrefix: "/mcp/v1/bot/", method: "GET", handler: mcpGetBotV1 });

// OAuth 2.1 for that endpoint (convex/oauth.ts), so a client that signs in
// (claude.ai, the Grok app's connectors) reaches it as the owner, with the
// owner's approval on the app's consent page. The documents name SITE_URL;
// registration is open, as the MCP specification expects, and a client so
// registered can do nothing until the owner approves it. The token endpoint
// and revocation take a client's own credentials and nothing else.
http.route({ path: "/.well-known/oauth-protected-resource", method: "GET", handler: oauthProtectedResource });
http.route({ path: "/.well-known/oauth-protected-resource/mcp/v1", method: "GET", handler: oauthProtectedResource });
// A bot's own address as a protected resource: a grant made for it is that bot's alone.
http.route({
  pathPrefix: "/.well-known/oauth-protected-resource/mcp/v1/bot/",
  method: "GET",
  handler: oauthProtectedResourceBot,
});
http.route({ path: "/.well-known/oauth-authorization-server", method: "GET", handler: oauthAuthorizationServer });
http.route({ path: "/oauth/register", method: "POST", handler: oauthRegister });
http.route({ path: "/oauth/token", method: "POST", handler: oauthToken });
http.route({ path: "/oauth/revoke", method: "POST", handler: oauthRevoke });

// Agents Protocol v1.1 (convex/agentsApi.ts, docs/agents-protocol.md): a
// connected project fetches what its agents should run and reports what they
// did. Each route refuses anything but that project's own token (`rap_…`),
// which reads its own config and jobs and writes its own project's totals and
// results, and nothing else.
http.route({ path: "/agents/v1/config", method: "GET", handler: agentsConfigV1 });
http.route({ path: "/agents/v1/usage", method: "POST", handler: agentsUsageV1 });
// v1.1: test jobs. The project polls for jobs (each leased to the poll that
// takes it) and posts each one's results to /agents/v1/jobs/{id}/results.
http.route({ path: "/agents/v1/jobs", method: "GET", handler: agentsJobsV1 });
http.route({ pathPrefix: "/agents/v1/jobs/", method: "POST", handler: agentsResultsV1 });

// Where Google returns the browser after "Connect Google". Trusts only a state row the owner created.
http.route({ path: "/google/callback", method: "GET", handler: googleCallback });

export default http;
