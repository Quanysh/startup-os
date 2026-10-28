// Made-up PostHog query answers in the documented shape. No real project,
// person or event property appears here.

import { vi } from "vitest";
import { msOfDay, weekIndex } from "../lib/weeks";

/** The number the queries give the week that starts on `monday`. */
export const W = (monday: string) => weekIndex(msOfDay(monday));

export const reply = (rows: unknown[][]) => ({
  results: rows,
  columns: ["week", "a", "b"],
  types: ["Int64", "UInt64", "UInt64"],
  hasMore: false,
  is_cached: false,
  error: null,
});

export const VISITS = reply([
  [W("2026-09-21"), 120],
  [W("2026-09-28"), 150],
  [W("2026-10-05"), 90],
]);

export const SEARCHES = reply([
  [W("2026-09-21"), 300, 40],
  [W("2026-09-28"), 410, 55],
  [W("2026-10-05"), 380, 50],
]);

// Nobody signed up in the week of October 5: PostHog sends no row for it.
export const SIGNUPS = reply([
  [W("2026-09-21"), 10, 4],
  [W("2026-09-28"), 12, 6],
]);

/**
 * The activation rule the signups query states, in TypeScript, so the cases
 * that matter can be written down: HogQL cannot be run here. The parser test
 * pins the query's own predicate to the same words. Times are Unix seconds.
 */
export const SEVEN_DAYS = 7 * 24 * 60 * 60;
export const activatedBy = (signedUp: number, searches: readonly number[]) =>
  searches.some((t) => t >= signedUp && t < signedUp + SEVEN_DAYS);

export type PostHogQuestion = "visits" | "searches" | "signups";

export type PostHogCall = {
  url: URL;
  method: string | undefined;
  authorization: string | null;
  redirect: RequestRedirect | undefined;
  signal: AbortSignal | null;
  /** Which question this was, from the query's `name`. */
  question: string | null;
  kind: string | null;
  /** The HogQL sent. */
  query: string;
};
type Route = (call: PostHogCall) => unknown;

/**
 * Replace global fetch with a fake PostHog. A route returns a body (sent as
 * JSON) or a Response, or throws to play a network failure. Returns the list
 * of calls made.
 */
export function stubPostHog(
  overrides: Partial<Record<PostHogQuestion, Route>> = {},
): PostHogCall[] {
  const calls: PostHogCall[] = [];
  const routes: Record<string, Route> = {
    visits: () => VISITS,
    searches: () => SEARCHES,
    signups: () => SIGNUPS,
    ...overrides,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const sent = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        name?: string;
        query?: { kind?: string; query?: string };
      };
      const call: PostHogCall = {
        url,
        method: init?.method,
        authorization: new Headers(init?.headers).get("Authorization"),
        redirect: init?.redirect,
        signal: init?.signal ?? null,
        question: sent.name?.replace(/^startup_os_/, "") ?? null,
        kind: sent.query?.kind ?? null,
        query: sent.query?.query ?? "",
      };
      calls.push(call);
      const route = call.question === null ? undefined : routes[call.question];
      if (!route || !/^\/api\/projects\/\d+\/query\/$/.test(url.pathname)) {
        return new Response("not found", { status: 404 });
      }
      const result = await route(call);
      return result instanceof Response ? result : Response.json(result);
    }),
  );
  return calls;
}
