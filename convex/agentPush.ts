"use node";

// The legacy way the OS steers Vertical Startup's agents (the project
// `vertical-startup`), kept until Vertical Startup moves to the package and fetches its
// config on Protocol v1 like every other project (GET /agents/v1/config,
// docs/agents-protocol.md): the whole config, signed, posted to Vertical Startup
// (POST ${VERTICAL_STARTUP_URL}/api/admin/agent-config).
//
//   x-startup-timestamp: <unix seconds>
//   x-startup-signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + rawBody)>
//
// The secret (VERTICAL_AGENT_CONFIG_SECRET) is a Convex env variable: it is
// never stored in a table, returned, logged or thrown, and nothing of
// Vertical Startup's answer is kept but whether it was 2xx and the version it says
// it applied. A failure is a key (PUSH_FAILURES), never a message.
//
// Node's crypto, so a "use node" file, holding this action and nothing else.

import { createHmac } from "node:crypto";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { featureOn } from "./lib/featureGates";
import { HEADERS } from "./lib/identity";
import {
  VERTICAL_AGENT_CONFIG_SECRET,
  VERTICAL_STARTUP_URL,
  failureOfStatus,
  pushAnswerOf,
  settleAnswer,
  steeringEndpoint,
  steeringMissing,
  type PushFailure,
} from "./lib/agentControl";

/** How long Vertical Startup has to answer. */
const PUSH_TIMEOUT_MS = 15_000;

/** "sha256=<hex>" of HMAC-SHA256(secret, `${timestamp}.${body}`). */
export function signatureOf(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export type PushResult =
  | { outcome: "sent"; appliedVersion: number }
  | { outcome: "failed"; failure: "stale"; remoteVersion: number }
  | { outcome: "failed" | "not_connected"; failure: PushFailure };

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Post one config, signed. Never throws: the answer is a result. `fetch` is
 * handed in, so a test never reaches a real endpoint.
 */
export async function pushConfig({
  env,
  body,
  now,
  fetch,
}: {
  env: Record<string, string | undefined>;
  body: { version: number; agents: unknown[] };
  now: number;
  fetch: Fetch;
}): Promise<PushResult> {
  const url = steeringEndpoint(env[VERTICAL_STARTUP_URL]);
  const secret = env[VERTICAL_AGENT_CONFIG_SECRET];
  if (steeringMissing(env).length > 0 || url === null || secret === undefined) {
    return { outcome: "not_connected", failure: "not_connected" };
  }
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(now / 1000));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = typeof AbortController === "function" ? new AbortController() : undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(new Error("timeout"));
      }, PUSH_TIMEOUT_MS);
    });
    const response = await Promise.race([
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [HEADERS.timestamp.toLowerCase()]: timestamp,
          [HEADERS.signature.toLowerCase()]: signatureOf(secret, timestamp, raw),
        },
        body: raw,
        // The signature goes to this one address: a redirect is a failure.
        redirect: "manual",
        signal: controller?.signal,
      }),
      deadline,
    ]);
    // The status code says why, as a key: nothing of the body is read.
    if (!response.ok) return { outcome: "failed", failure: failureOfStatus(response.status) };
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return { outcome: "failed", failure: "bad_answer" };
    }
    const answer = pushAnswerOf(parsed);
    return answer === null ? { outcome: "failed", failure: "bad_answer" } : settleAnswer(answer, body.version);
  } catch {
    // Nothing of the error is kept: it could carry the address.
    return { outcome: "failed", failure: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/** Send the latest config to Vertical Startup and record how it went. */
export const push = internalAction({
  args: {},
  handler: async (ctx) => {
    // Vertical Startup's older way in is switched off (convex/lib/features.ts): nothing is sent.
    if (!featureOn("verticalStartupAgents")) return;
    const state = await ctx.runQuery(internal.agentControl.pushState, {});
    if (state === null) return;
    const result = await pushConfig({
      env: process.env,
      body: state,
      now: Date.now(),
      fetch: (url, init) => fetch(url, init),
    });
    await ctx.runMutation(internal.agentControl.recordPush, {
      version: state.version,
      outcome: result.outcome,
      ...(result.outcome === "sent"
        ? { appliedVersion: result.appliedVersion }
        : { failure: result.failure, ...("remoteVersion" in result ? { remoteVersion: result.remoteVersion } : {}) }),
    });
  },
});
