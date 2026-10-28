// Made-up Search Console responses in the documented shape, a fake Google to
// serve them, and a service account whose key is generated on the spot. No
// real property, query, page or figure appears here, and no key is stored.

import { vi } from "vitest";

const DAY_MS = 24 * 60 * 60 * 1000;

export const dayAfter = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** One day's totals, as Google returns a row grouped by date. */
export const day = (date: string, clicks: number, impressions: number, position: number) => ({
  keys: [date],
  clicks,
  impressions,
  ctr: impressions === 0 ? 0 : clicks / impressions,
  position,
});

/** The first `days` days of a week, every day with the same figures. */
export const week = (
  monday: string,
  clicks: number,
  impressions: number,
  position: number,
  days = 7,
) => Array.from({ length: days }, (_, i) => day(dayAfter(monday, i), clicks, impressions, position));

// As read at 07:00 UTC on Monday 12 October 2026. Google's newest final day is
// Friday 9 October, three days back, so the week of 5 October is not finished.
export const DAYS = {
  rows: [
    ...week("2026-09-07", 10, 200, 12), // 70 clicks, 1,400 impressions
    ...week("2026-09-14", 12, 240, 11.5), // 84, 1,680
    ...week("2026-09-21", 9, 180, 13), // 63, 1,260
    ...week("2026-09-28", 15, 300, 10), // 105, 2,100
    ...week("2026-10-05", 20, 400, 9, 5), // Monday to Friday only
  ],
  responseAggregationType: "byProperty",
};

export const SITE = "sc-domain:startup.test";
export const TOKEN_ROUTE = "https://oauth2.googleapis.com/token";
export const QUERY_ROUTE =
  "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Astartup.test/searchAnalytics/query";
// Obviously not a real token.
export const ACCESS_TOKEN = "fake-google-access-token-for-tests-only";

/**
 * A service account that exists only for this test run: a fresh RSA key, in
 * the PEM form Google's JSON key file carries, and its public half so a test
 * can check a signature.
 */
export async function fakeServiceAccount() {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let binary = "";
  for (const byte of der) binary += String.fromCharCode(byte);
  const lines = btoa(binary).match(/.{1,64}/g)!.join("\n");
  return {
    email: "os-reader@fake-project.iam.gserviceaccount.test",
    pem: `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`,
    publicKey: pair.publicKey,
  };
}

/** Bytes of a base64url string (a JWT part). */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded =
    text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export type GoogleCall = {
  url: URL;
  method: string;
  authorization: string | null;
  redirect: RequestRedirect | undefined;
  signal: AbortSignal | null;
  body: string;
};
type Route = (call: GoogleCall) => unknown;

/**
 * Replace global fetch with a fake Google: the token endpoint and the Search
 * Analytics query for SITE. A route returns a body (sent as JSON) or a
 * Response, or throws to play a network failure. Returns the calls made.
 */
export function stubGoogle(overrides: Record<string, Route> = {}): GoogleCall[] {
  const calls: GoogleCall[] = [];
  const routes: Record<string, Route> = {
    [TOKEN_ROUTE]: () => ({ access_token: ACCESS_TOKEN, token_type: "Bearer", expires_in: 3600 }),
    [QUERY_ROUTE]: () => DAYS,
    ...overrides,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const call: GoogleCall = {
        url,
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("Authorization"),
        redirect: init?.redirect,
        signal: init?.signal ?? null,
        body: typeof init?.body === "string" ? init.body : "",
      };
      calls.push(call);
      const route = routes[`${url.origin}${url.pathname}`];
      if (!route) return new Response("not found", { status: 404 });
      const result = await route(call);
      return result instanceof Response ? result : Response.json(result);
    }),
  );
  return calls;
}
