// Vertical Startup (the specialty product): weekly active people, active
// practices and work items handled, from its own /os/health endpoint.
//
// Vertical Startup holds patient data. This connector asks one endpoint that
// answers with counts and nothing else, and stores those counts.

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { ConnectorError } from "./errors";
import { requestJson } from "./http";
import { toSnapshots } from "./verticalHealthParse";
import { runConnector } from "./run";

/** Shorter than this is a placeholder or a typo, not a secret. */
const MIN_SECRET_LENGTH = 32;

/**
 * The endpoint, or a failure that echoes nothing of the variable. The secret
 * goes to this URL, so it must be exactly an Vertical Startup Convex deployment's
 * /os/health over https: a typo must not send it somewhere else.
 */
function endpoint(): string {
  let url: URL | null = null;
  try {
    url = new URL(process.env.VERTICAL_HEALTH_URL ?? "");
  } catch {
    // Falls through to the one message below.
  }
  const exact =
    url !== null &&
    url.protocol === "https:" &&
    url.hostname.endsWith(".convex.site") &&
    url.pathname === "/os/health" &&
    url.port === "" &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === "";
  if (url === null || !exact) {
    throw new ConnectorError("VERTICAL_HEALTH_URL must be https://<deployment>.convex.site/os/health.");
  }
  return url.href;
}

function secret(): string {
  const value = process.env.VERTICAL_HEALTH_SECRET ?? "";
  if (value.length < MIN_SECRET_LENGTH) {
    throw new ConnectorError(
      `VERTICAL_HEALTH_SECRET must be ${MIN_SECRET_LENGTH} characters or more.`,
    );
  }
  return value;
}

export const sync = internalAction({
  // `months` is accepted because every sync is started the same way; this
  // one has no longer history to ask for (the manifest says `backfill: false`).
  args: { months: v.optional(v.number()) },
  handler: async (ctx) =>
    // `now` is the runner's clock: one per run, shared with the run record.
    runConnector(ctx, "vertical_startup", async (now) => {
      const url = endpoint();
      const raw = await requestJson({
        who: "Vertical Startup",
        what: "health",
        url,
        headers: { Authorization: `Bearer ${secret()}`, Accept: "application/json" },
      });
      return toSnapshots(raw, now);
    }),
});
