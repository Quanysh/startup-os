// Made-up Linear responses for tests. No real issue, team or person. (The
// two-dot filename keeps Convex from bundling this file.)

import { vi } from "vitest";

export const VIEWER_ID = "user-me";
export const UPDATED = "2026-10-12T05:00:00.000Z";

/** One issue node as the board query returns it. */
export function node(over: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    identifier: "ENG-1",
    title: "Made-up title",
    url: "https://linear.app/startup/issue/ENG-1/made-up-title",
    priority: 2,
    dueDate: null,
    updatedAt: UPDATED,
    state: { name: "In Progress", type: "started" },
    team: { key: "ENG", name: "Engineering" },
    assignee: { id: VIEWER_ID, name: "Ada Example" },
    ...over,
  };
}

export const issuePage = (nodes: unknown[], endCursor?: string) => ({
  data: {
    viewer: { id: VIEWER_ID },
    issues: {
      nodes,
      pageInfo: endCursor ? { hasNextPage: true, endCursor } : { hasNextPage: false, endCursor: null },
    },
  },
});

export type LinearCall = {
  url: string;
  method: string;
  redirect: unknown;
  authorization: string | null;
  contentType: string | null;
  query: string;
  variables: Record<string, unknown>;
};

type Answer = { status: number; body: unknown };

/**
 * Stand in for Linear. `pages` are answered in order: the first to the
 * request with no cursor, then by cursor ("c2" is the second page…).
 */
export function stubLinear(pages: (Answer | ReturnType<typeof issuePage> | Record<string, unknown>)[]) {
  const calls: LinearCall[] = [];
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
      const after = sent.variables?.after;
      const index = typeof after === "string" ? Number(after.slice(1)) - 1 : 0;
      const answer = pages[index];
      if (answer === undefined) return new Response("{}", { status: 404 });
      const isAnswer = "status" in answer && "body" in answer;
      return new Response(JSON.stringify(isAnswer ? answer.body : answer), {
        status: isAnswer ? (answer.status as number) : 200,
      });
    }),
  );
  return calls;
}
