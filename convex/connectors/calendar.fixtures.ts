// Made-up Calendar responses for tests. No real meeting, person or id. (The
// two-dot filename keeps Convex from bundling this file.)

import { vi } from "vitest";

export const OWNER_ADDRESS = "founder@example.test";

type Attendee = {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  self?: boolean;
  resource?: boolean;
};

export const me = (responseStatus = "accepted"): Attendee => ({
  email: OWNER_ADDRESS,
  self: true,
  responseStatus,
});
export const ada: Attendee = {
  email: "Ada@Example-Fund.test",
  displayName: "Ada Example",
  responseStatus: "accepted",
};
export const bo: Attendee = { email: "bo@clinic.test", responseStatus: "needsAction" };
export const room: Attendee = {
  email: "made-up-room@resource.calendar.test",
  displayName: "Made-up Room",
  resource: true,
};

/** One event as `events.list` returns it (only the fields the OS asks for). */
export function event(over: Record<string, unknown> = {}) {
  return {
    id: "evt1",
    status: "confirmed",
    summary: "Made-up meeting",
    start: { dateTime: "2026-10-12T15:00:00Z" },
    end: { dateTime: "2026-10-12T15:30:00Z" },
    attendees: [me(), ada],
    ...over,
  };
}

export const allDay = (over: Record<string, unknown> = {}) =>
  event({
    id: "day1",
    summary: "Made-up offsite",
    start: { date: "2026-10-14" },
    end: { date: "2026-10-16" },
    attendees: undefined,
    ...over,
  });

export const page = (items: unknown[], nextPageToken?: string) => ({
  kind: "calendar#events",
  items,
  ...(nextPageToken ? { nextPageToken } : {}),
});

export type CalendarCall = {
  url: URL;
  method: string;
  redirect: unknown;
  authorization: string | null;
  body: string;
};

type Answer = { status?: number; body: unknown };

/**
 * Stand in for Google's token endpoint and Calendar. `pages` are answered in
 * order: the first to the request with no pageToken, then by token ("p2" is
 * the second page, "p3" the third…).
 */
export function stubCalendar(options: { token?: Answer; pages?: (Answer | ReturnType<typeof page>)[] } = {}) {
  const calls: CalendarCall[] = [];
  const pages = options.pages ?? [page([])];
  const respond = ({ status = 200, body }: Answer) =>
    new Response(JSON.stringify(body), { status });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        url,
        method: init?.method ?? "GET",
        redirect: init?.redirect,
        authorization: new Headers(init?.headers).get("Authorization"),
        body: String(init?.body ?? ""),
      });
      if (url.href === "https://oauth2.googleapis.com/token") {
        return respond(options.token ?? { body: { access_token: "fake-access-token" } });
      }
      if (url.host !== "www.googleapis.com") return respond({ status: 404, body: {} });
      const token = url.searchParams.get("pageToken");
      const index = token === null ? 0 : Number(token.slice(1)) - 1;
      const answer = pages[index];
      if (answer === undefined) return respond({ status: 404, body: {} });
      return respond("kind" in answer ? { body: answer } : answer);
    }),
  );
  return calls;
}
