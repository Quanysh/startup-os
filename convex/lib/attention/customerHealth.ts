// How a clinic is doing, worked out from what the client register says about
// it. Computed at read time and on the client. Pure: nothing here reads a
// clock.
//
// Ages are counted up to the day the register was last pushed, never to
// today. The register is all that is known: a clinic paid 30 days before a
// push made two months ago may well have paid since, and "last paid 90 days
// ago" would say more than anyone knows. Each such reason names the push day,
// and the register growing old is said once, by its own notice
// (attention.ts, REGISTER_STALE_DAYS).
//
// A signal with nothing on record is "unknown". It is listed, and it plays no
// part in the verdict: a missing number is not a zero, and a clinic with no
// usage data is not an inactive one.

import type { CustomerRow } from "../customerShape";
import { daysBetween, localIsoDate } from "./dates";
import { dayLabel, formatValue } from "./format";

/** The thresholds, in one place. The owner's to tune (see the Phase 5 plan). */
export const HEALTH_RULES = {
  /** Days from the last payment to the push. Monthly billing: one cycle plus grace, then a second cycle. */
  paymentWatchAfter: 45,
  paymentRiskAfter: 75,
  /** Months of fees owed. */
  owedWatchAbove: 1,
  owedRiskAbove: 2,
  /** Days from the last use to the push. */
  usageWatchAfter: 14,
  usageRiskAfter: 30,
} as const;

export type Signal = "payment" | "owed" | "usage";
export type SignalLevel = "good" | "watch" | "at_risk" | "unknown";
export type Reason = { signal: Signal; level: SignalLevel; text: string };

export type Health =
  /** Paused, churned, archived or won on the Sales board: not a clinic whose health is acted on. */
  | { level: "not_assessed"; why: string }
  | {
      /** The worst of the known signals; "unknown" when none is known. */
      level: SignalLevel;
      /** One per signal, in a fixed order, known or not. */
      reasons: Reason[];
      /** The signals with nothing on record. */
      unknown: Signal[];
    };

export type HealthLevel = Health["level"];

export const HEALTH_LABELS: Record<HealthLevel, string> = {
  good: "Good",
  watch: "Watch",
  at_risk: "At risk",
  unknown: "Unknown",
  not_assessed: "Not assessed",
};

const R = HEALTH_RULES;
const daysText = (days: number) => (days === 1 ? "1 day" : `${days} days`);

/** The day the register was last pushed: what ages are counted up to. */
export type RegisterDay = {
  /** "YYYY-MM-DD", the owner's calendar date of the push. */
  day: string;
  /** The same day as the reasons name it: "Sep 30". */
  label: string;
};

/** null before any push is on record. `now` only decides whether the label needs its year. */
export function registerDayOf(lastPushAt: number | null, now: number): RegisterDay | null {
  if (lastPushAt === null) return null;
  const day = localIsoDate(lastPushAt);
  return { day, label: dayLabel(day, now) };
}

const NO_PUSH_DAY = "The register's push date is not on record, so there is no day to count to.";

/**
 * A signal that is an age: days from a date in the register to the push.
 *   no date            → unknown
 *   no push on record  → unknown
 *   after the push     → unknown (a date typed ahead proves nothing)
 *   up to `watchAfter` → good
 *   up to `riskAfter`  → watch
 *   beyond             → at risk
 */
function age(
  signal: Signal,
  date: string | null,
  register: RegisterDay | null,
  rules: { watchAfter: number; riskAfter: number },
  words: {
    none: string;
    ahead: (pushed: string) => string;
    sameDay: (pushed: string) => string;
    good: (days: string, pushed: string) => string;
    late: (days: string, pushed: string) => string;
  },
): Reason {
  if (date === null) return { signal, level: "unknown", text: words.none };
  if (register === null) return { signal, level: "unknown", text: NO_PUSH_DAY };
  const pushed = register.label;
  const days = daysBetween(date, register.day);
  if (days < 0) return { signal, level: "unknown", text: words.ahead(pushed) };
  if (days === 0) return { signal, level: "good", text: words.sameDay(pushed) };
  if (days <= rules.watchAfter) {
    return { signal, level: "good", text: words.good(daysText(days), pushed) };
  }
  return {
    signal,
    level: days <= rules.riskAfter ? "watch" : "at_risk",
    text: `${words.late(daysText(days), pushed)} (watch after ${rules.watchAfter}, at risk after ${rules.riskAfter}).`,
  };
}

function payment(clinic: CustomerRow, register: RegisterDay | null): Reason {
  return age(
    "payment",
    clinic.lastPaymentDate,
    register,
    { watchAfter: R.paymentWatchAfter, riskAfter: R.paymentRiskAfter },
    {
      none: "No payment date on record.",
      ahead: (pushed) => `The last payment is dated after the register was pushed on ${pushed}.`,
      sameDay: (pushed) => `Paid on the day the register was pushed, ${pushed}.`,
      good: (days, pushed) => `Paid ${days} before the register was pushed on ${pushed}.`,
      late: (days, pushed) => `Last paid ${days} before the register was pushed on ${pushed}`,
    },
  );
}

function owed(clinic: CustomerRow): Reason {
  const signal = "owed" as const;
  if (clinic.amountOwed === null) return { signal, level: "unknown", text: "No balance on record." };
  if (clinic.amountOwed === 0) return { signal, level: "good", text: "Owes nothing." };
  const money = formatValue(clinic.amountOwed, "currency", clinic.currency);
  if (clinic.monthlyFee === null || clinic.monthlyFee === 0) {
    return {
      signal,
      level: "watch",
      text: `Owes ${money}, with no monthly fee on record to compare it with.`,
    };
  }
  // Judged on the figure as it is shown, to one decimal: 2.04 months reads
  // "2.0", and "2.0 months (at risk above 2)" must not be at risk.
  const months = Math.round((clinic.amountOwed / clinic.monthlyFee) * 10) / 10;
  return {
    signal,
    level: months <= R.owedWatchAbove ? "good" : months <= R.owedRiskAbove ? "watch" : "at_risk",
    text: `Owes ${money}: ${months.toFixed(1)} months of fees (watch above ${R.owedWatchAbove}, at risk above ${R.owedRiskAbove}).`,
  };
}

function usage(clinic: CustomerRow, register: RegisterDay | null): Reason {
  return age(
    "usage",
    clinic.lastUsageDate,
    register,
    { watchAfter: R.usageWatchAfter, riskAfter: R.usageRiskAfter },
    {
      none: "No usage data.",
      ahead: (pushed) => `The last use is dated after the register was pushed on ${pushed}.`,
      sameDay: (pushed) => `Used on the day the register was pushed, ${pushed}.`,
      good: (days, pushed) => `Used ${days} before the register was pushed on ${pushed}.`,
      late: (days, pushed) => `Not used for ${days} before the register was pushed on ${pushed}`,
    },
  );
}

const WORST_FIRST = ["at_risk", "watch", "good"] as const;

/** `register` is the day the register was last pushed (`registerDayOf`), or null. */
export function health(clinic: CustomerRow, register: RegisterDay | null): Health {
  if (clinic.archived) return { level: "not_assessed", why: "No longer in the client register." };
  // Won on the Sales board (convex/lib/wonCustomers.ts): no payment, balance
  // or use is on record until the register carries it, so it is not judged,
  // and it sits in none of the health counts.
  if (clinic.fromSales) {
    return {
      level: "not_assessed",
      why: "Won on the Sales board and not in the client register yet: nothing on record to judge it by.",
    };
  }
  if (clinic.status === "paused") {
    return { level: "not_assessed", why: "Paused in the client register." };
  }
  if (clinic.status === "churned") {
    return { level: "not_assessed", why: "Churned in the client register." };
  }
  const reasons = [payment(clinic, register), owed(clinic), usage(clinic, register)];
  const level =
    WORST_FIRST.find((candidate) => reasons.some((r) => r.level === candidate)) ?? "unknown";
  return {
    level,
    reasons,
    unknown: reasons.filter((r) => r.level === "unknown").map((r) => r.signal),
  };
}

/** A US clinic the OS should hold a BAA date for, and does not. */
export function baaMissing(clinic: CustomerRow): boolean {
  return (
    clinic.market === "us" && clinic.status === "active" && !clinic.archived && clinic.baaDate === null
  );
}
