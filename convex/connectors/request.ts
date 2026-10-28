// One HTTP request the way every work-tool connector makes it: a deadline, one
// retry for a blip, never a followed redirect, and failures in this file's
// words only. What fetch or a JSON parser throws can quote the URL, a header
// or the body, and a run's message is stored.

import { ConnectorError } from "./errors";

const REQUEST_TIMEOUT_MS = 20_000;
const RETRY_PAUSE_MS = 250;

/** A failure worth one more try. */
export class TransientError extends ConnectorError {}

export type Ask = {
  /** The service, in our words: "Linear". */
  who: string;
  /** What was asked for, in our words: "issues". */
  what: string;
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /**
   * Hand a 429 back, body and all, instead of treating it as a blip: for a
   * service that says in the body how long to wait (Telegram's `retry_after`).
   */
  hand429?: boolean;
  /** A shorter deadline than the usual twenty seconds, for a caller that is itself being waited on. */
  deadlineMs?: number;
  /** One attempt and no more: no second try for a blip. */
  once?: boolean;
};
export type Answer = { status: number; json: unknown };

async function attempt(request: Ask): Promise<Answer> {
  const { who, what } = request;
  const controller = typeof AbortController === "function" ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new TransientError(`${who} did not answer in time for ${what}.`));
    }, request.deadlineMs ?? REQUEST_TIMEOUT_MS);
  });

  const read = async (): Promise<Answer> => {
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: request.method ?? "GET",
        headers: { Accept: "application/json", ...request.headers },
        body: request.body,
        // The credential goes only to the URL asked for.
        redirect: "manual",
        signal: controller?.signal,
      });
    } catch {
      throw new TransientError(`${who} could not be reached for ${what}.`);
    }
    if ((response.status === 429 && !request.hand429) || response.status >= 500) {
      throw new TransientError(`${who} answered ${response.status} for ${what}.`);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    return { status: response.status, json };
  };

  try {
    return await Promise.race([read(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** The status and parsed body, whatever the status. Throws only when there was no answer. */
export async function ask(request: Ask): Promise<Answer> {
  try {
    return await attempt(request);
  } catch (error) {
    if (!(error instanceof TransientError) || request.once === true) throw error;
    await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
    return attempt(request);
  }
}

/** A 2xx JSON body, or a ConnectorError naming the status only. */
export async function askJson(request: Ask): Promise<unknown> {
  const { status, json } = await ask(request);
  if (status < 200 || status > 299) {
    throw new ConnectorError(`${request.who} answered ${status} for ${request.what}.`);
  }
  if (json === undefined) {
    throw new ConnectorError(`${request.who}'s ${request.what} response was not JSON.`);
  }
  return json;
}
