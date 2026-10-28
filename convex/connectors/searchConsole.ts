// Google Search Console: clicks, impressions and average position by week.
//
// Signs in as a service account the owner has added to the property as a
// read-only user. The sign-in is a JWT signed here with WebCrypto, in Convex's
// default runtime: no Node-only library, no "use node" file.
//
// Stores weekly totals for the whole property and nothing finer: the request
// groups by date only, so no search term and no page URL is ever fetched.

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { BACKFILL_MONTHS, clampLimit } from "../lib/limits";
import type { SnapshotInput } from "../lib/snapshotRules";
import { ConnectorError } from "./errors";
import { requestJson } from "./marketingRequest";
import { runConnector } from "./run";
import {
  parseDays,
  parseToken,
  requestWindow,
  toSnapshots,
  weeklyTotals,
} from "./searchConsoleParse";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/webmasters/v3";
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

/**
 * The week in progress and the five before it, re-read daily. Google's figures
 * arrive two to three days late, so the newest finished week is one or two
 * back; the rest are re-read in case a final figure moved.
 */
const DEFAULT_WEEKS = 6;
/** More days than any window here holds. A full page means some are missing. */
const ROW_LIMIT = 5000;
/** How long the sign-in assertion is good for. Google allows up to an hour. */
const ASSERTION_SECONDS = 600;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const encoded = (value: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(value)));

/**
 * The service account's private key, ready to sign with. Whatever goes wrong
 * is reported in one fixed sentence: an import error must not be allowed to
 * describe the key.
 */
async function signingKey(): Promise<CryptoKey> {
  try {
    // A key pasted from Google's JSON file can carry "\n" as two characters.
    const pem = (process.env.GSC_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
    const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
    const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
    return await crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new ConnectorError(
      "GSC_PRIVATE_KEY is not a PKCS#8 private key (the private_key field of the service account's JSON file).",
    );
  }
}

/** The signed JWT Google exchanges for an access token. */
async function assertion(now: number): Promise<string> {
  const key = await signingKey();
  const iat = Math.floor(now / 1000);
  const unsigned = `${encoded({ alg: "RS256", typ: "JWT" })}.${encoded({
    iss: process.env.GSC_CLIENT_EMAIL,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat,
    exp: iat + ASSERTION_SECONDS,
  })}`;
  let signature: ArrayBuffer;
  try {
    signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(unsigned),
    );
  } catch {
    throw new ConnectorError("The Search Console sign-in request could not be signed.");
  }
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

/**
 * Every finished week in the window, as snapshot rows. `now` is the runner's
 * clock. `months` is set by a backfill.
 */
export async function readSearchConsole(now: number, months?: number): Promise<SnapshotInput[]> {
  const weeks =
    months === undefined
      ? DEFAULT_WEEKS
      : Math.ceil((clampLimit(months, 1, BACKFILL_MONTHS) * 31) / 7) + 1;
  const window = requestWindow(now, weeks);

  // Signed before anything is sent: a key that is not a key calls nothing.
  const signed = await assertion(now);
  const accessToken = parseToken(
    await requestJson({
      service: "Google",
      what: "sign-in",
      url: TOKEN_URL,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: signed,
      }).toString(),
    }),
  );

  const site = encodeURIComponent(process.env.GSC_SITE_URL ?? "");
  const days = parseDays(
    await requestJson({
      service: "Search Console",
      what: "daily totals",
      url: `${API}/sites/${site}/searchAnalytics/query`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        startDate: window.startDate,
        endDate: window.endDate,
        // By date and nothing else: no query, no page.
        dimensions: ["date"],
        type: "web",
        // Final figures only. Fresh ones change, and a week built on them
        // would be rewritten downwards or upwards a day later.
        dataState: "final",
        rowLimit: ROW_LIMIT,
      }),
    }),
  );
  // Stopping quietly at a full page would understate the weeks cut off.
  if (days.length >= ROW_LIMIT) {
    throw new ConnectorError(
      "Search Console returned a full page of days; the rest would be missing.",
    );
  }
  return toSnapshots(weeklyTotals(days, window));
}

export const sync = internalAction({
  args: { months: v.optional(v.number()) },
  handler: async (ctx, args) =>
    runConnector(ctx, "search_console", (now) => readSearchConsole(now, args.months)),
});
