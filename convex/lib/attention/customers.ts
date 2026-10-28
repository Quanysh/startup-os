// What the home page's "Needs attention" list says about clinics. Counts
// only: a clinic is named on /customers and nowhere else.

import type { CustomerRow } from "../customerShape";
import { REGISTER_STALE_DAYS } from "../limits";
import { localIsoDate } from "./dates";
import { dayLabel } from "./format";
import type { AttentionItem } from "./scorecard";
import { baaMissing, health, registerDayOf } from "./customerHealth";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the last successful push is old enough to say so. Health is counted
 * to the push day, so an old register does not make a clinic look later: it
 * means nothing since is known, and this notice is where that is said.
 */
export function registerIsStale(lastPushAt: number | null, now: number): boolean {
  return lastPushAt !== null && now - lastPushAt > REGISTER_STALE_DAYS * DAY_MS;
}

/** The day the register was last pushed, as the stale notices name it. */
export function pushDayLabel(lastPushAt: number, now: number): string {
  return dayLabel(localIsoDate(lastPushAt), now);
}

/** A churned clinic still in the register with a balance: money that health no longer watches. */
export function churnedOwing(clinic: CustomerRow): boolean {
  return (
    clinic.status === "churned" &&
    !clinic.archived &&
    clinic.amountOwed !== null &&
    clinic.amountOwed > 0
  );
}

/** `now` is the caller's clock: for the register's age, and the year in a day's label. */
export function customerAttention(
  customers: readonly CustomerRow[],
  lastPushAt: number | null,
  now: number,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const register = registerDayOf(lastPushAt, now);

  const atRisk = customers.filter((c) => health(c, register).level === "at_risk").length;
  if (atRisk > 0) {
    items.push({
      id: "customers:at_risk",
      severity: "risk",
      title: atRisk === 1 ? "1 clinic is at risk" : `${atRisk} clinics are at risk`,
      detail: "Late payment, a large balance or no recent use. The list gives each reason.",
      href: "/customers?health=at_risk",
    });
  }

  const owing = customers.filter(churnedOwing).length;
  if (owing > 0) {
    items.push({
      id: "customers:churned_owing",
      severity: "risk",
      title:
        owing === 1
          ? "1 churned clinic still owes money"
          : `${owing} churned clinics still owe money`,
      detail: "They are not assessed for health, so the balance shows nowhere else.",
      href: "/customers?health=not_assessed",
    });
  }

  const noBaa = customers.filter(baaMissing).length;
  if (noBaa > 0) {
    items.push({
      id: "customers:baa",
      severity: "empty",
      title:
        noBaa === 1
          ? "1 US clinic has no BAA date on record"
          : `${noBaa} US clinics have no BAA date on record`,
      detail: "Add the date to the client register once the agreement is signed.",
      href: "/customers?baa=missing",
    });
  }

  if (customers.length > 0 && lastPushAt !== null && registerIsStale(lastPushAt, now)) {
    items.push({
      id: "customers:stale",
      severity: "stale",
      title: "The client register is out of date",
      detail: `Last pushed ${pushDayLabel(lastPushAt, now)}. Nothing since then is known: each clinic reads as it stood that day.`,
      href: "/customers",
    });
  }

  return items;
}
