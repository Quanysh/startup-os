// One HTTP request, the way a connector makes one: a single deadline, one
// retry for a blip, no redirect followed, and every failure reported in this
// file's own words. It is Mercury's `attempt` and `get`, made to take the
// service's name, a method and a body.
//
// Local to the Search Console and Apollo connectors. Another branch adds a
// shared request helper for every connector; the two are to be reconciled
// when the branches merge.
//
// What a fetch or a JSON parser throws can quote the URL (which may hold an
// account or a site), a header (which holds the credential) or the response
// body (which holds the source's data). The message is stored in the run log,
// so none of that may reach it: every throw here is a ConnectorError built
// from `service` and `what`, which the caller wrote, and a status code.

import { ConnectorError } from "./errors";

/** A failure worth one more try: a blip, not an answer that will repeat. */
export class TransientError extends ConnectorError {}

/** How long one request may take, from sending to the last byte of the body. */
export const REQUEST_TIMEOUT_MS = 20_000;
/** The pause before the one retry. */
export const RETRY_PAUSE_MS = 250;

export type RequestSpec = {
  /** The service by name, as the run log should call it: "Search Console". */
  service: string;
  /** What is being read, in a word or two of ours: "daily totals". Never the URL. */
  what: string;
  url: string;
  method?: "GET" | "POST";
  /** Where the credential goes. It is sent to `url` and nowhere else. */
  headers: Record<string, string>;
  body?: string;
};

/**
 * One attempt, under one deadline. The deadline is a timer raced against the
 * request, so it holds whether or not the runtime has `AbortSignal.timeout`;
 * where an AbortController exists it also cancels the request when the timer
 * wins.
 */
async function attempt(spec: RequestSpec): Promise<unknown> {
  const controller = typeof AbortController === "function" ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new TransientError(`${spec.service} did not answer in time for ${spec.what}.`));
    }, REQUEST_TIMEOUT_MS);
  });

  const read = async (): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetch(spec.url, {
        method: spec.method ?? "GET",
        headers: spec.headers,
        body: spec.body,
        // Never follow a redirect: the credential goes only to the URL asked
        // for. A 3xx then lands in the not-ok branch below.
        redirect: "manual",
        signal: controller?.signal,
      });
    } catch {
      throw new TransientError(`${spec.service} could not be reached for ${spec.what}.`);
    }
    if (!response.ok) {
      // The status only: an error body can describe the account.
      const message = `${spec.service} answered ${response.status} for ${spec.what}.`;
      // Rate limiting and server trouble can clear; any other answer will not.
      throw response.status === 429 || response.status >= 500
        ? new TransientError(message)
        : new ConnectorError(message);
    }
    try {
      return await response.json();
    } catch {
      throw new ConnectorError(`${spec.service}'s ${spec.what} response was not JSON.`);
    }
  };

  try {
    return await Promise.race([read(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** One request, with one retry after a short pause when the first try was a blip. */
export async function requestJson(spec: RequestSpec): Promise<unknown> {
  try {
    return await attempt(spec);
  } catch (error) {
    if (!(error instanceof TransientError)) throw error;
    await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
    return attempt(spec);
  }
}
