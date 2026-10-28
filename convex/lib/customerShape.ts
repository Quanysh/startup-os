// What a clinic is, for everything that handles one: Convex functions, the
// ingest envelope, the push script and the UI. A plain module, so the browser
// can import it.

import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { companyIds, COMPANIES } from "./company";
import { featureOn } from "./featureGates";
import { CURRENCIES, type Currency } from "./metricRegistry";

export const MARKETS = ["us", "kz"] as const;
export type Market = (typeof MARKETS)[number];
export const MARKET_LABELS: Record<Market, string> = { us: "US", kz: "Kazakhstan" };

/** A clinic's fee and balance are in its market's currency: the company's own (its identity's). */
export const MARKET_CURRENCY: Record<Market, Currency> = { us: COMPANIES.us.currency, kz: COMPANIES.kz.currency };

/**
 * The currencies a person may pick for a cost line, a person's pay or a
 * scenario's change: US dollars, and the currency of each company the OS is
 * run for (so none of the second company's in one-company mode); tenge only
 * while it is switched on (convex/lib/features.ts). What is stored in another
 * currency already, and its conversion, are not this.
 */
export const offeredCurrencies = (): readonly Currency[] => {
  const kept = new Set<Currency>(["USD", ...companyIds().map((id) => COMPANIES[id].currency)]);
  return CURRENCIES.filter((currency) => kept.has(currency) && (currency !== "KZT" || featureOn("kztCurrency")));
};

/** A market's own currency where it is offered, else dollars: what a new line starts in. */
export const startingCurrencyOf = (market: Market): Currency =>
  offeredCurrencies().includes(MARKET_CURRENCY[market]) ? MARKET_CURRENCY[market] : "USD";

/** Said when a write names a currency that is not offered. Fixed words. */
export const CURRENCY_NOT_OFFERED = "Tenge is not a currency this OS offers. Use US dollars.";

/** For a write: refused where it names a currency that is not offered. */
export function requireOfferedCurrency(currency: Currency | undefined): void {
  if (currency !== undefined && !offeredCurrencies().includes(currency)) throw new ConvexError(CURRENCY_NOT_OFFERED);
}

export const CUSTOMER_STATUSES = ["active", "paused", "churned"] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];
export const CUSTOMER_STATUS_LABELS: Record<CustomerStatus, string> = {
  active: "Active",
  paused: "Paused",
  churned: "Churned",
};

/** The source that carries clinics: the client register, the record of truth. */
export const REGISTER_SOURCE = "client_register";

/**
 * A clinic won on the Sales board that the register does not carry yet
 * (convex/lib/wonCustomers.ts). Not a source that pushes: no token names it.
 * The register's next push of the same clinic supersedes the row.
 */
export const SALES_SOURCE = "deals";

/**
 * What makes two spellings the same clinic: case, surrounding and repeated
 * spaces, and compatibility forms (a full-width letter, say) are ignored.
 */
export function nameKeyOf(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** A clinic as `customers.list` returns it. null means "not on record". */
export type CustomerRow = {
  id: Id<"customers">;
  name: string;
  market: Market;
  status: CustomerStatus;
  monthlyFee: number | null;
  currency: string;
  lastPaymentDate: string | null;
  amountOwed: number | null;
  lastUsageDate: string | null;
  contractDate: string | null;
  baaDate: string | null;
  /** The owner's own two fields. A push never writes them. */
  nextTouch: string | null;
  note: string | null;
  /** When a push last carried this clinic. */
  syncedAt: number;
  /** No longer in the register. Kept, with its note. */
  archived: boolean;
  /** The deal it was won from, or that Sales linked it to; null when none. */
  dealId: Id<"deals"> | null;
  /**
   * Won on the Sales board and not in the client register yet: nothing about
   * its payments or use is on record, so it is not judged, and it counts as a
   * new paying customer only with a monthly fee.
   */
  fromSales: boolean;
};
