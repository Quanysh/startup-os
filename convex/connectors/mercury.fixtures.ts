// Made-up Mercury API responses in the documented shapes. No real account,
// balance or counterparty appears here, but for the subsidiary's own name,
// which the connector has to recognise.

import { vi } from "vitest";

export const ACCOUNTS = {
  accounts: [
    { id: "acc-checking", name: "Checking", status: "active", type: "mercury", kind: "checking", currentBalance: 120_000.5, availableBalance: 119_000 },
    { id: "acc-savings", name: "Savings", status: "active", type: "mercury", kind: "savings", currentBalance: 30_000.25, availableBalance: 30_000.25 },
    // Neither of these is Startup's spendable money.
    { id: "acc-closed", name: "Old", status: "archived", type: "mercury", kind: "checking", currentBalance: 999, availableBalance: 999 },
    { id: "acc-external", name: "Linked bank", status: "active", type: "external", kind: "checking", currentBalance: 5_000, availableBalance: 5_000 },
    // Not open yet, gone, or someone else's: none of it is Startup's money or history.
    { id: "acc-pending", name: "Opening", status: "pending", type: "mercury", kind: "checking", currentBalance: 111, availableBalance: 111 },
    { id: "acc-deleted", name: "Removed", status: "deleted", type: "mercury", kind: "checking", currentBalance: 222, availableBalance: 222 },
    { id: "acc-recipient", name: "Vendor", status: "active", type: "recipient", kind: "checking", currentBalance: 333, availableBalance: 333 },
  ],
  page: {},
};

export const TREASURY = {
  accounts: [{ id: "tr-1", status: "active", currentBalance: 250_000, availableBalance: 250_000, netReturns: [] }],
  page: {},
};

/**
 * The subsidiary as Mercury names it on a payment: the parent's own funding
 * of it. Spelled as the bank spells it, capitals and all, and made up: the
 * made-up deployment's counterparty (convex/lib/deployment.kit.ts).
 */
export const SUBSIDIARY_NAME = "TOO NORTHWIND";

export const tx = (
  id: string,
  amount: number,
  kind: string,
  postedAt: string | null,
  extra: { status?: string; createdAt?: string; counterpartyName?: string | null } = {},
) => ({
  id,
  amount,
  kind,
  postedAt,
  status: extra.status ?? "sent",
  createdAt: extra.createdAt ?? postedAt ?? "2026-10-07T10:00:00Z",
  counterpartyName: extra.counterpartyName === undefined ? "Example Co" : extra.counterpartyName,
  note: null,
});

/** A payment from Startup to the subsidiary, as Mercury lists it (and mislabels it). */
export const toSubsidiary = (id: string, dollars: number, postedAt: string, extra: { status?: string } = {}) => ({
  ...tx(id, -dollars, "outgoingPayment", postedAt, { ...extra, counterpartyName: SUBSIDIARY_NAME }),
  mercuryCategory: "Software & Subscriptions",
});

export const CHECKING_TRANSACTIONS = {
  total: 8,
  transactions: [
    tx("t1", 12_000.1, "externalTransfer", "2026-10-03T15:00:00Z"),
    tx("t2", -4_000.05, "outgoingPayment", "2026-10-04T15:00:00Z"),
    // Startup's own money changing accounts: neither income nor spending.
    tx("t3", -50_000, "treasuryTransfer", "2026-10-05T15:00:00Z"),
    tx("t4", -1_000, "internalTransfer", "2026-10-06T15:00:00Z"),
    // Not posted, so not in the balance's history yet.
    tx("t5", -700, "outgoingPayment", null, { status: "pending" }),
    // Created in September, posted in the last second of it.
    tx("t6", -2_500.5, "outgoingPayment", "2026-09-30T23:59:59Z", { createdAt: "2026-09-29T10:00:00Z" }),
    tx("t7", 100_000, "externalTransfer", "2026-08-15T12:00:00Z"),
    tx("t8", -999, "outgoingPayment", "2026-09-10T12:00:00Z", { status: "failed" }),
  ],
};

export const SAVINGS_TRANSACTIONS = {
  total: 2,
  transactions: [
    tx("s1", 1_000, "internalTransfer", "2026-10-06T15:00:00Z"),
    tx("s2", 12.34, "other", "2026-10-01T00:00:00Z"),
  ],
};

// A closed account's payments still happened; it has nothing in this window.
export const CLOSED_TRANSACTIONS = { total: 0, transactions: [] };

export type MercuryCall = {
  url: URL;
  authorization: string | null;
  /** The `redirect` option the request was made with. */
  redirect: RequestRedirect | undefined;
  /** The request's abort signal, so a test can see it cancelled. */
  signal: AbortSignal | null;
};
// A route may also return a promise: one that never settles plays a server
// that accepts the connection and says nothing.
type Route = (url: URL) => unknown;

/**
 * Replace global fetch with a fake Mercury. A route returns a body (sent as
 * JSON) or a Response, or throws to play a network failure. Returns the list
 * of calls made.
 */
export function stubMercury(overrides: Record<string, Route> = {}): MercuryCall[] {
  const calls: MercuryCall[] = [];
  const routes: Record<string, Route> = {
    "/api/v1/accounts": () => ACCOUNTS,
    "/api/v1/treasury": () => TREASURY,
    "/api/v1/account/acc-checking/transactions": () => CHECKING_TRANSACTIONS,
    "/api/v1/account/acc-savings/transactions": () => SAVINGS_TRANSACTIONS,
    "/api/v1/account/acc-closed/transactions": () => CLOSED_TRANSACTIONS,
    ...overrides,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      calls.push({
        url,
        authorization: new Headers(init?.headers).get("Authorization"),
        redirect: init?.redirect,
        signal: init?.signal ?? null,
      });
      const route = routes[url.pathname];
      if (!route) return new Response("not found", { status: 404 });
      const result = await route(url);
      return result instanceof Response ? result : Response.json(result);
    }),
  );
  return calls;
}
