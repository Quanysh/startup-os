// Made-up Fireflies responses for tests. No real meeting or person. (The
// two-dot filename keeps Convex from bundling this file.)

import { vi } from "vitest";

export const HELD = Date.UTC(2026, 9, 10, 15);

/** One transcript as the recent-meetings query returns it. */
export function transcript(over: Record<string, unknown> = {}) {
  return {
    id: "meet-1",
    title: "Made-up meeting",
    date: HELD,
    duration: 31.4,
    meeting_attendees: [
      { displayName: "Ada Example", email: "Ada@Example-Fund.test" },
      { displayName: null, email: "bo@clinic.test" },
    ],
    summary: {
      short_summary: "A made-up summary.",
      overview: "A longer made-up overview.",
      action_items: "Send the made-up deck\n\nBook a made-up follow-up",
    },
    ...over,
  };
}

export const answer = (transcripts: unknown[]) => ({ data: { transcripts } });

export type FirefliesCall = {
  url: string;
  method: string;
  redirect: unknown;
  authorization: string | null;
  contentType: string | null;
  query: string;
  variables: Record<string, unknown>;
};

/** Stand in for Fireflies: every request gets `body` with `status`. */
export function stubFireflies(body: unknown, status = 200) {
  const calls: FirefliesCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const sent = JSON.parse(String(init?.body ?? "{}")) as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        redirect: init?.redirect,
        authorization: headers.get("Authorization"),
        contentType: headers.get("Content-Type"),
        query: sent.query ?? "",
        variables: sent.variables ?? {},
      });
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return calls;
}
