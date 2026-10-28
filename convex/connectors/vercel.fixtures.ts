// Made-up Vercel API responses in the documented shapes. No real project,
// deployment, branch or person appears here.

import { vi } from "vitest";

const DAY = 24 * 60 * 60 * 1000;

export const dep = (
  uid: string,
  created: string,
  readyState = "READY",
  target: string | null = "production",
) => ({
  uid,
  name: "example-app",
  url: `${uid}.example.vercel.app`,
  created: Date.parse(created),
  createdAt: Date.parse(created),
  readyState,
  state: readyState,
  target,
  type: "LAMBDAS",
  creator: { uid: "user-1", username: "someone" },
  inspectorUrl: null,
  projectId: "prj_fake456",
  meta: { githubCommitMessage: "a commit message that must never be stored" },
});

export const page = (deployments: ReturnType<typeof dep>[], next: number | null = null) => ({
  deployments,
  pagination: { count: deployments.length, next, prev: null },
});

// Newest first, as Vercel lists them. "Now" in the tests is Wednesday,
// October 14, so the week in progress began on Monday the 12th.
export const DEPLOYMENTS = page([
  // The week in progress: never counted.
  dep("d-f", "2026-10-13T10:00:00Z"),
  dep("d-c", "2026-10-08T10:00:00Z"),
  dep("d-b", "2026-10-07T10:00:00Z", "ERROR"),
  dep("d-a", "2026-10-06T10:00:00Z"),
  // A preview: not a production deployment.
  dep("d-g", "2026-10-06T09:00:00Z", "READY", null),
  dep("d-d", "2026-09-30T10:00:00Z"),
  // Cancelled is neither a deploy nor a failure.
  dep("d-e", "2026-09-29T10:00:00Z", "CANCELED"),
  // Nothing in the week of September 21: a real zero.
  dep("d-h", "2026-09-16T10:00:00Z"),
]);

/** `counts` as daily rows from `monday` on, one per day. */
export const daysFrom = (monday: string, counts: readonly number[]) =>
  counts.map((pageviews, i) => ({
    timestamp: new Date(Date.parse(`${monday}T00:00:00Z`) + i * DAY).toISOString(),
    pageviews,
    visitors: pageviews,
  }));

/**
 * The seven days of the week asked for, 150 page views in all, and then the
 * Monday after it: `until` is that Monday, and whether Vercel includes the
 * day it names is not documented.
 */
export const pageviewsFor = (url: URL) => ({
  version: 1,
  query: {},
  data: daysFrom(url.searchParams.get("since") ?? "", [100, 50, 0, 0, 0, 0, 0, 999]),
});

export const DEPLOYMENTS_PATH = "/v7/deployments";
export const PAGEVIEWS_PATH = "/v1/query/web-analytics/visits/aggregate";

export type VercelCall = {
  url: URL;
  method: string | undefined;
  authorization: string | null;
  redirect: RequestRedirect | undefined;
  signal: AbortSignal | null;
};
type Route = (url: URL) => unknown;

/**
 * Replace global fetch with a fake Vercel. A route returns a body (sent as
 * JSON) or a Response, or throws to play a network failure. Returns the list
 * of calls made.
 */
export function stubVercel(overrides: Record<string, Route> = {}): VercelCall[] {
  const calls: VercelCall[] = [];
  const routes: Record<string, Route> = {
    [DEPLOYMENTS_PATH]: () => DEPLOYMENTS,
    [PAGEVIEWS_PATH]: pageviewsFor,
    ...overrides,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      calls.push({
        url,
        method: init?.method,
        authorization: new Headers(init?.headers).get("Authorization"),
        redirect: init?.redirect,
        signal: init?.signal ?? null,
      });
      const route = routes[url.pathname];
      if (!route) return new Response("not found", { status: 404 });
      const result = await route(url);
      return result instanceof Response ? result : Response.json(result);
    }),
  );
  return calls;
}
