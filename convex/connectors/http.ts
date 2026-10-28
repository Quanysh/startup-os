// One request to an outside service, the only way a product connector makes
// one: a deadline, one retry for a blip, no redirects, and every failure
// thrown in this file's own words.
//
// What a fetch or a JSON parser throws can quote the URL (which may hold an
// id), the Authorization header or the response body, and the run log stores
// the message. So nothing thrown from here carries anything the service sent
// except its status code.

import { ConnectorError } from "./errors";

export type JsonRequest = {
  /** Who is asked, as the run log names them: "PostHog". Written by the caller, never by the service. */
  who: string;
  /** What is asked for, in a word or two: "deployments". Written by the caller. */
  what: string;
  url: string;
  method?: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
};

/** How long one attempt may take, from sending to the last byte of the body. */
export const REQUEST_TIMEOUT_MS = 20_000;
/** The pause before the one retry. */
const RETRY_PAUSE_MS = 250;

/** A failure worth one more try: a blip, not an answer that will repeat. */
class TransientError extends ConnectorError {}

/**
 * One attempt, under one deadline. The deadline is a timer raced against the
 * request, so it holds whether or not the runtime has `AbortSignal.timeout`;
 * where an AbortController exists it also cancels the request when the timer
 * wins.
 */
async function attempt(request: JsonRequest): Promise<unknown> {
  const { who, what } = request;
  const controller = typeof AbortController === "function" ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new TransientError(`${who} did not answer in time for ${what}.`));
    }, REQUEST_TIMEOUT_MS);
  });

  const read = async (): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: request.method ?? "GET",
        headers: request.headers,
        body: request.body,
        // Never follow a redirect: a credential goes only to the URL asked
        // for. A 3xx then lands in the not-ok branch below.
        redirect: "manual",
        signal: controller?.signal,
      });
    } catch {
      throw new TransientError(`${who} could not be reached for ${what}.`);
    }
    if (!response.ok) {
      // The status only: an error body can describe the account.
      const message = `${who} answered ${response.status} for ${what}.`;
      // Rate limiting and server trouble can clear; any other answer will not.
      throw response.status === 429 || response.status >= 500
        ? new TransientError(message)
        : new ConnectorError(message);
    }
    try {
      return await response.json();
    } catch {
      throw new ConnectorError(`${who}'s ${what} response was not JSON.`);
    }
  };

  try {
    return await Promise.race([read(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** One request, with one retry after a short pause when the first try was a blip. */
export async function requestJson(request: JsonRequest): Promise<unknown> {
  try {
    return await attempt(request);
  } catch (error) {
    if (!(error instanceof TransientError)) throw error;
    await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
    return attempt(request);
  }
}
