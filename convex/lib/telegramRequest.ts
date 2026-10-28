// One request to Telegram's Bot API. Runs only inside a Convex action.
//
// The address of every Bot API request holds the bot's token. So nothing
// leaves this file but a parsed answer or the *name* of a fixed failure
// (`TELEGRAM_FAILURES`): never an error, a message, a status text or an
// address. It does not throw, and it logs nothing.
//
// The request itself is the connectors' own (`ask`): a 20 second deadline,
// one retry for a network blip or a 5xx, and no followed redirect. On top of
// that, Telegram's 429 is waited out once when it asks for 30 seconds or less.
// A `quick` request does none of the waiting: see `askTelegram`.

import { ConnectorError } from "../connectors/errors";
import { ask } from "../connectors/request";
import { isBotToken, type TelegramFailure } from "./telegramMessage";

/** The longest wait Telegram may ask for that is honoured. */
const MAX_RETRY_AFTER_S = 30;
/** How long a quick request may take before it is given up on. */
export const QUICK_DEADLINE_MS = 8_000;

export type TelegramResult = { ok: true; json: unknown } | { ok: false; failure: TelegramFailure };
type Method =
  | "sendMessage"
  | "getUpdates"
  | "getMe"
  | "getChatMemberCount"
  | "setWebhook"
  | "deleteWebhook"
  | "getWebhookInfo";

const BODIES: Record<Method, (extra: Record<string, unknown>) => Record<string, unknown>> = {
  sendMessage: (extra) => ({ ...extra, parse_mode: "HTML", disable_web_page_preview: true }),
  // What the bot has recently seen, without waiting for anything new.
  getUpdates: () => ({ timeout: 0, limit: 100 }),
  getMe: () => ({}),
  getChatMemberCount: (extra) => extra,
  setWebhook: (extra) => extra,
  deleteWebhook: () => ({}),
  getWebhookInfo: () => ({}),
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The seconds a 429 asks for, when that is a whole number worth waiting. */
function retryAfter(json: unknown): number | null {
  const parameters = isRecord(json) ? json.parameters : undefined;
  const seconds = isRecord(parameters) ? parameters.retry_after : undefined;
  return typeof seconds === "number" &&
    Number.isInteger(seconds) &&
    seconds >= 0 &&
    seconds <= MAX_RETRY_AFTER_S
    ? seconds
    : null;
}

/** What an answer's status means, in one of the fixed failures. */
function failureOf(method: Method, status: number): TelegramFailure {
  if (status === 401 || status === 404) return "token";
  if (status === 429) return "slow";
  if (method === "sendMessage" && (status === 400 || status === 403)) return "chat";
  if (method === "getUpdates" && status === 409) return "updates";
  if (method === "setWebhook" || method === "deleteWebhook") return "webhook";
  return "other";
}

/**
 * Ask the Bot API one thing. Never throws; a failure is a name, not a message.
 *
 * `quick` is for the reply sent from inside the webhook, where Telegram is
 * itself waiting on this deployment: one attempt, eight seconds, and a 429
 * is not waited out. The caller gives up and says so.
 */
export async function askTelegram(
  token: string,
  method: Method,
  extra: Record<string, unknown> = {},
  { quick = false }: { quick?: boolean } = {},
): Promise<TelegramResult> {
  // Checked before it goes into an address, and never echoed.
  if (!isBotToken(token)) return { ok: false, failure: "badToken" };
  const once = () =>
    ask({
      who: "Telegram",
      what: method,
      url: `https://api.telegram.org/bot${token}/${method}`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(BODIES[method](extra)),
      hand429: true,
      ...(quick ? { deadlineMs: QUICK_DEADLINE_MS, once: true } : null),
    });
  try {
    let answer = await once();
    if (answer.status === 429) {
      const seconds = quick ? null : retryAfter(answer.json);
      if (seconds === null) return { ok: false, failure: "slow" };
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      answer = await once();
    }
    if (answer.status === 200 && isRecord(answer.json) && answer.json.ok === true) {
      return { ok: true, json: answer.json };
    }
    return { ok: false, failure: answer.status === 200 ? "other" : failureOf(method, answer.status) };
  } catch (error) {
    // `ask` throws in its own words, which name no address; anything else
    // thrown might, so only the kind of failure is kept either way.
    const said = error instanceof ConnectorError ? error.message : "";
    if (said.includes("did not answer in time")) return { ok: false, failure: "timeout" };
    if (said.includes("could not be reached")) return { ok: false, failure: "unreachable" };
    return { ok: false, failure: "other" };
  }
}

/** Post one message, as HTML with no link preview, to one chat. */
export function sendMessage(token: string, chatId: string, text: string): Promise<TelegramResult> {
  return askTelegram(token, "sendMessage", { chat_id: chatId, text });
}
