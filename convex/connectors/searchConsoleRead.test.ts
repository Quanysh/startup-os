import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConnectorError } from "./errors";
import {
  ACCESS_TOKEN,
  DAYS,
  QUERY_ROUTE,
  SITE,
  TOKEN_ROUTE,
  fakeServiceAccount,
  fromBase64Url,
  stubGoogle,
  week,
  type GoogleCall,
} from "./searchConsole.fixtures";
import { readSearchConsole } from "./searchConsole";

// 07:00 UTC, Monday 12 October 2026.
const NOW = Date.UTC(2026, 9, 12, 7);
let account: Awaited<ReturnType<typeof fakeServiceAccount>>;

beforeEach(async () => {
  account = await fakeServiceAccount();
  vi.stubEnv("GSC_CLIENT_EMAIL", account.email);
  vi.stubEnv("GSC_PRIVATE_KEY", account.pem);
  vi.stubEnv("GSC_SITE_URL", SITE);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const to = (calls: GoogleCall[], route: string) =>
  calls.filter((c) => `${c.url.origin}${c.url.pathname}` === route);
const lines = async (months?: number) =>
  (await readSearchConsole(NOW, months)).map((r) => `${r.key} ${r.periodStart} ${r.value}`).sort();
const failure = (run: Promise<unknown>) =>
  run.then(
    () => null,
    (error: unknown) => error as Error,
  );

describe("readSearchConsole", () => {
  test("returns three rows for each week Google has finished, and none for the week it has not", async () => {
    stubGoogle();
    expect(await lines()).toEqual([
      "search_clicks 2026-09-07 70",
      "search_clicks 2026-09-14 84",
      "search_clicks 2026-09-21 63",
      "search_clicks 2026-09-28 105",
      "search_impressions 2026-09-07 1400",
      "search_impressions 2026-09-14 1680",
      "search_impressions 2026-09-21 1260",
      "search_impressions 2026-09-28 2100",
      "search_position 2026-09-07 12",
      "search_position 2026-09-14 11.5",
      "search_position 2026-09-21 13",
      "search_position 2026-09-28 10",
    ]);
  });

  test("signs in with a short-lived RS256 assertion that the service account's key really signed", async () => {
    const calls = stubGoogle();
    await readSearchConsole(NOW);
    const [signIn] = to(calls, TOKEN_ROUTE);
    expect(signIn?.method).toBe("POST");
    const form = new URLSearchParams(signIn!.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");

    const [header, claims, signature] = form.get("assertion")!.split(".") as [
      string,
      string,
      string,
    ];
    const decode = (part: string) => JSON.parse(new TextDecoder().decode(fromBase64Url(part)));
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(claims)).toEqual({
      iss: account.email,
      scope: "https://www.googleapis.com/auth/webmasters.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: NOW / 1000,
      // Ten minutes: enough for one run, and well inside Google's one-hour limit.
      exp: NOW / 1000 + 600,
    });
    const genuine = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      account.publicKey,
      fromBase64Url(signature),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(genuine).toBe(true);
  });

  test("the assertion goes to Google's token endpoint only, the access token to the API only, and neither follows a redirect", async () => {
    const calls = stubGoogle();
    await readSearchConsole(NOW);
    expect(calls.map((c) => `${c.url.origin}${c.url.pathname}`)).toEqual([TOKEN_ROUTE, QUERY_ROUTE]);
    const [signIn] = to(calls, TOKEN_ROUTE);
    const [query] = to(calls, QUERY_ROUTE);
    expect(signIn?.authorization).toBeNull();
    expect(query?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(query?.body).not.toContain("assertion");
    for (const call of calls) {
      expect(call.redirect).toBe("manual");
      expect(call.url.search).toBe("");
    }
  });

  test("asks for final daily totals of web search and for nothing that names a query or a page", async () => {
    const calls = stubGoogle();
    await readSearchConsole(NOW);
    expect(JSON.parse(to(calls, QUERY_ROUTE)[0]!.body)).toEqual({
      startDate: "2026-09-07",
      endDate: "2026-10-12",
      dimensions: ["date"],
      type: "web",
      dataState: "final",
      rowLimit: 5000,
    });
  });

  test("a backfill reaches thirteen months back, to a Monday", async () => {
    const calls = stubGoogle();
    await readSearchConsole(NOW, 13);
    expect(JSON.parse(to(calls, QUERY_ROUTE)[0]!.body).startDate).toBe("2025-09-01");
  });

  test("a key pasted with its line breaks written as \\n is accepted", async () => {
    vi.stubEnv("GSC_PRIVATE_KEY", account.pem.replace(/\n/g, "\\n"));
    stubGoogle();
    expect(await lines()).toHaveLength(12);
  });

  test("a key that is not a key fails before anything is sent, and is not quoted", async () => {
    const junk = "-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5\n-----END PRIVATE KEY-----\n";
    vi.stubEnv("GSC_PRIVATE_KEY", junk);
    const calls = stubGoogle();
    const error = await failure(readSearchConsole(NOW));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error?.message).toBe(
      "GSC_PRIVATE_KEY is not a PKCS#8 private key (the private_key field of the service account's JSON file).",
    );
    expect(error?.message).not.toContain("bm90");
    expect(calls).toEqual([]);
  });

  test("a refused sign-in is reported by status, its body unquoted, and the API is never called", async () => {
    const calls = stubGoogle({
      [TOKEN_ROUTE]: () =>
        new Response(
          '{"error":"invalid_grant","error_description":"account os-reader is disabled"}',
          { status: 400 },
        ),
    });
    const error = await failure(readSearchConsole(NOW));
    expect(error?.message).toBe("Google answered 400 for sign-in.");
    expect(to(calls, QUERY_ROUTE)).toEqual([]);
  });

  test("a service account that is not a user of the property is reported by status", async () => {
    stubGoogle({
      [QUERY_ROUTE]: () =>
        new Response(`{"error":{"message":"User does not have access to ${SITE}"}}`, {
          status: 403,
        }),
    });
    const error = await failure(readSearchConsole(NOW));
    expect(error?.message).toBe("Search Console answered 403 for daily totals.");
    expect(error?.message).not.toContain("startup.test");
  });

  test("no days at all is no rows, for the runner to record as an empty run", async () => {
    stubGoogle({ [QUERY_ROUTE]: () => ({ responseAggregationType: "byProperty" }) });
    expect(await readSearchConsole(NOW)).toEqual([]);
  });

  test("a full page of days fails the read: the rest would be missing", async () => {
    const rows = Array.from({ length: 5000 }, () => DAYS.rows[0]);
    stubGoogle({ [QUERY_ROUTE]: () => ({ rows }) });
    const error = await failure(readSearchConsole(NOW));
    expect(error?.message).toBe(
      "Search Console returned a full page of days; the rest would be missing.",
    );
  });

  test("a part-week is never returned, whatever day the run happens on", async () => {
    // Google has reported through Saturday 10 October: still not the week of the 5th.
    stubGoogle({ [QUERY_ROUTE]: () => ({ rows: week("2026-10-05", 20, 400, 9, 6) }) });
    expect(await readSearchConsole(NOW)).toEqual([]);
  });
});
