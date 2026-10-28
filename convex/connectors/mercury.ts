// Mercury (US bank): today's cash, money in and out by month, and the part of
// money out that was sent to the subsidiary, Globex.
//
// Stores monthly totals, never transactions: the OS needs burn, not a ledger,
// and a ledger would put counterparty names in the database. The parser reads
// a counterparty's name only to tell a payment to the subsidiary, and drops it
// there (`isSubsidiaryCounterparty` in convex/lib/company.ts).

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { BACKFILL_MONTHS, clampLimit } from "../lib/limits";
import { periodStart } from "../lib/periods";
import { ConnectorError } from "./errors";
import {
  monthlyFlows,
  parseAccounts,
  parseTransactions,
  parseTreasury,
  toSnapshots,
  windowMonths,
  type MercuryTransaction,
} from "./mercuryParse";
import { runConnector } from "./run";

const API = "https://api.mercury.com/api/v1";
const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 500;
const MAX_TRANSACTIONS = 20_000;

/** The month in progress and the two before it: re-read daily, so a late posting lands. */
const DEFAULT_MONTHS = 3;

/**
 * Never fewer than the month in progress and the one before it. The finance
 * page calls a US month complete once a run has succeeded after it ended
 * (`readWhole` in src/lib/metrics/finance.ts), which is true only if every
 * successful run re-reads the month that just closed.
 */
const MIN_MONTHS = 2;

/**
 * How long before the first month wanted to start reading. `start` may filter
 * on when a transaction was created, while a month's flows are counted by
 * when it posted, and a cheque or a held payment can post weeks later.
 * Without the margin, a closed month would lose that payment the day the
 * window slid past its creation date.
 */
const CREATED_MARGIN_DAYS = 60;

/** How long one request may take, from sending to the last byte of the body. */
const REQUEST_TIMEOUT_MS = 20_000;
/** The pause before the one retry. */
const RETRY_PAUSE_MS = 250;

/** A failure worth one more try: a blip, not an answer that will repeat. */
class TransientError extends ConnectorError {}

/**
 * One attempt, under one deadline. The deadline is a timer raced against the
 * request, so it holds whether or not the runtime has `AbortSignal.timeout`;
 * where an AbortController exists it also cancels the request when the timer
 * wins.
 *
 * Every failure is thrown in this file's own words: what a fetch or a JSON
 * parser throws can quote the URL (which holds an account id), the
 * Authorization header or the response body, and the message is stored.
 */
async function attempt(path: string, what: string): Promise<unknown> {
  const controller = typeof AbortController === "function" ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new TransientError(`Mercury did not answer in time for ${what}.`));
    }, REQUEST_TIMEOUT_MS);
  });

  const read = async (): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetch(`${API}${path}`, {
        headers: {
          Authorization: `Bearer ${process.env.MERCURY_API_TOKEN}`,
          Accept: "application/json",
        },
        // Never follow a redirect: the token goes only to the URL asked for.
        // A 3xx then lands in the not-ok branch below.
        redirect: "manual",
        signal: controller?.signal,
      });
    } catch {
      throw new TransientError(`Mercury could not be reached for ${what}.`);
    }
    if (!response.ok) {
      // The status only: an error body can describe accounts.
      const message = `Mercury answered ${response.status} for ${what}.`;
      // Rate limiting and server trouble can clear; any other answer will not.
      throw response.status === 429 || response.status >= 500
        ? new TransientError(message)
        : new ConnectorError(message);
    }
    try {
      return await response.json();
    } catch {
      throw new ConnectorError(`Mercury's ${what} response was not JSON.`);
    }
  };

  try {
    return await Promise.race([read(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** One GET, with one retry after a short pause when the first try was a blip. */
async function get(path: string, what: string): Promise<unknown> {
  try {
    return await attempt(path, what);
  } catch (error) {
    if (!(error instanceof TransientError)) throw error;
    await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
    return attempt(path, what);
  }
}

async function transactionsOf(accountId: string, start: string): Promise<MercuryTransaction[]> {
  const all: MercuryTransaction[] = [];
  while (all.length < MAX_TRANSACTIONS) {
    // Oldest first, and offset by what has actually arrived: a page shorter
    // than asked for, or a payment made mid-read, then cannot skip a row.
    const query = `limit=${PAGE_SIZE}&offset=${all.length}&order=asc&start=${start}`;
    const { total, transactions } = parseTransactions(
      await get(`/account/${accountId}/transactions?${query}`, "transactions"),
    );
    all.push(...transactions);
    if (transactions.length === 0 || all.length >= total) return all;
  }
  // Stopping quietly here would understate spending.
  throw new ConnectorError(
    `An account has more than ${MAX_TRANSACTIONS} transactions in the window.`,
  );
}

export const sync = internalAction({
  args: { months: v.optional(v.number()) },
  handler: async (ctx, args) =>
    // `now` is the runner's clock: one per run, shared with the run record.
    runConnector(ctx, "mercury", async (now) => {
      const months = windowMonths(
        now,
        Math.max(clampLimit(args.months, DEFAULT_MONTHS, BACKFILL_MONTHS), MIN_MONTHS),
      );

      const accounts = parseAccounts(await get("/accounts", "accounts"));
      // No open account at all means the request went wrong, not that the
      // company has no money. The runner records an empty result.
      if (accounts.ids.length === 0) return [];

      const start = periodStart(
        "day",
        Date.parse(`${months[0]}T00:00:00Z`) - CREATED_MARGIN_DAYS * DAY_MS,
      );
      const [treasuryCents, ...lists] = await Promise.all([
        get("/treasury", "treasury").then(parseTreasury),
        // Every account that has history, including ones closed since: a
        // closed account's past payments still happened.
        ...accounts.flowIds.map((id) => transactionsOf(id, start)),
      ]);

      const flows = monthlyFlows(lists.flat(), months);
      // Not one transaction came back, even from before the window: that is a
      // failed read, not silence. Writing it would replace closed months with zeros.
      if (flows.length === 0) return [];

      return toSnapshots({ cashCents: accounts.balanceCents + treasuryCents, flows, now });
    }),
});
