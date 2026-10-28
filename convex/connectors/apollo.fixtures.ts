// Made-up Apollo responses in the shape of "Search for Sequences". The names
// and ids are invented: they are here so tests can prove none is kept.

import { vi } from "vitest";

export const sequence = (
  id: string,
  delivered: number,
  opened: number,
  replied: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  name: `Fixture Sequence ${id}`,
  archived: false,
  active: true,
  created_at: "2026-03-13T23:25:14.042Z",
  last_used_at: "2026-10-09T15:43:48.809+00:00",
  user_id: "user-fixture-1",
  num_steps: 2,
  emailer_steps: [{ id: `${id}-step-1`, position: 1, type: "manual_email" }],
  unique_scheduled: 0,
  unique_delivered: delivered,
  unique_bounced: 1,
  unique_opened: opened,
  unique_replied: replied,
  unique_demoed: 0,
  unique_clicked: 0,
  unique_unsubscribed: 0,
  bounce_rate: 0.04,
  open_rate: delivered === 0 ? 0 : opened / delivered,
  reply_rate: delivered === 0 ? 0 : replied / delivered,
  loaded_stats: true,
  ...extra,
});

export const SEQUENCES = [
  sequence("a", 120, 60, 5),
  sequence("b", 80, 20, 3),
  // Archived, never deleted: its emails were still sent.
  sequence("c", 40, 10, 0, { archived: true, active: false }),
];

export const page = (
  list: unknown[],
  number: number,
  totalPages: number,
  totalEntries: number,
) => ({
  pagination: { page: number, per_page: 100, total_entries: totalEntries, total_pages: totalPages },
  breadcrumbs: [],
  emailer_campaigns: list,
});

export const SEARCH_ROUTE = "/api/v1/emailer_campaigns/search";

export type ApolloCall = {
  url: URL;
  method: string;
  apiKey: string | null;
  authorization: string | null;
  redirect: RequestRedirect | undefined;
};

/**
 * Replace global fetch with a fake Apollo. `answer` is given the page number
 * asked for and returns a body (sent as JSON) or a Response. By default there
 * is one page holding SEQUENCES.
 */
export function stubApollo(
  answer: (pageNumber: number) => unknown = () => page(SEQUENCES, 1, 1, SEQUENCES.length),
): ApolloCall[] {
  const calls: ApolloCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        method: init?.method ?? "GET",
        apiKey: headers.get("x-api-key"),
        authorization: headers.get("Authorization"),
        redirect: init?.redirect,
      });
      if (url.pathname !== SEARCH_ROUTE) return new Response("not found", { status: 404 });
      const result = await answer(Number(url.searchParams.get("page")));
      return result instanceof Response ? result : Response.json(result);
    }),
  );
  return calls;
}
