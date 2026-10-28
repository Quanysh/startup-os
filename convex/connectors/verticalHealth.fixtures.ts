// A made-up answer from Vertical Startup's /os/health, in the shape the Phase 3
// plan specifies. No real practice or person is behind these counts.

import { vi } from "vitest";

export const week = (weekStart: string, activeUsers: number, activePractices: number, coreActions: number) => ({
  weekStart,
  activeUsers,
  activePractices,
  coreActions,
});

// "Now" in the tests is Wednesday, October 14: the last closed week began on the 5th.
export const HEALTH = {
  version: 1,
  generatedAt: "2026-10-14T06:30:00.000Z",
  totals: { practices: 4 },
  weeks: [
    week("2026-09-14", 9, 2, 120),
    week("2026-09-21", 11, 3, 160),
    week("2026-09-28", 12, 3, 188),
    week("2026-10-05", 14, 3, 212),
  ],
};

export type VerticalCall = {
  url: URL;
  method: string | undefined;
  authorization: string | null;
  redirect: RequestRedirect | undefined;
  signal: AbortSignal | null;
};

/**
 * Replace global fetch with a fake Vertical Startup. `answer` returns a body (sent
 * as JSON) or a Response, or throws to play a network failure. Returns the
 * list of calls made.
 */
export function stubVertical(answer: () => unknown = () => HEALTH): VerticalCall[] {
  const calls: VerticalCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: new URL(input instanceof Request ? input.url : input),
        method: init?.method,
        authorization: new Headers(init?.headers).get("Authorization"),
        redirect: init?.redirect,
        signal: init?.signal ?? null,
      });
      const result = await answer();
      return result instanceof Response ? result : Response.json(result);
    }),
  );
  return calls;
}
