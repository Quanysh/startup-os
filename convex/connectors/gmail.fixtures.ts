// Made-up Gmail responses for tests. No real sender, subject or id. (The
// two-dot filename keeps Convex from bundling this file.)

import { vi } from "vitest";

export const AT = Date.UTC(2026, 9, 12, 5);
export const OWNER_ADDRESS = "founder@example.test";

type MessageInput = {
  at?: number;
  from?: string | null;
  subject?: string | null;
  labels?: string[];
  /** Extra headers, as Gmail returns them: a name and a value. */
  headers?: Record<string, string>;
};

/** One message as `threads.get?format=metadata` returns it. */
export function message({
  at = AT,
  from = '"Ada Example" <ada@example-fund.test>',
  subject = "Made-up subject",
  labels = ["INBOX", "UNREAD", "CATEGORY_PERSONAL"],
  headers = {},
}: MessageInput = {}) {
  const all: { name: string; value: string }[] = [];
  if (from !== null) all.push({ name: "From", value: from });
  if (subject !== null) all.push({ name: "Subject", value: subject });
  for (const [name, value] of Object.entries(headers)) all.push({ name, value });
  return { labelIds: labels, internalDate: String(at), payload: { headers: all } };
}

export const thread = (...messages: ReturnType<typeof message>[]) => ({ messages });

/** A message the owner sent. */
export const sent = (at: number) =>
  message({ at, from: `Founder <${OWNER_ADDRESS}>`, labels: ["SENT"] });

export type GmailCall = {
  url: URL;
  method: string;
  redirect: unknown;
  authorization: string | null;
  body: string;
};

type Answer = { status?: number; body: unknown };

/**
 * Stand in for Google's token endpoint and Gmail. `threads` maps a thread id
 * to its answer; the list is built from its keys unless `list` is given.
 */
export function stubGmail(options: {
  token?: Answer;
  list?: Answer;
  threads?: Record<string, Answer | ReturnType<typeof thread>>;
} = {}) {
  const calls: GmailCall[] = [];
  const threads = options.threads ?? {};
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
      if (url.host !== "gmail.googleapis.com") return respond({ status: 404, body: {} });
      if (url.pathname === "/gmail/v1/users/me/threads") {
        const ids = Object.keys(threads);
        return respond(
          options.list ?? { body: ids.length > 0 ? { threads: ids.map((id) => ({ id })) } : {} },
        );
      }
      const id = url.pathname.split("/").pop() ?? "";
      const answer = threads[id];
      if (answer === undefined) return respond({ status: 404, body: {} });
      return respond("messages" in answer ? { body: answer } : answer);
    }),
  );
  return calls;
}
