import type { Currency, Unit } from "../metricRegistry";
import type { Period } from "../periods";

const MINUS = "−"; // U+2212, so a negative never reads as a hyphen
const SYMBOL: Record<Currency, string> = { USD: "$", KZT: "₸" };

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const oneDecimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const twoDecimals = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** Written in full up to 9,999; compacted (12.9K, 4.2M) beyond that. */
function magnitude(abs: number): string {
  return abs >= 10_000 ? compact.format(abs) : whole.format(abs);
}

function withUnit(
  body: string,
  negative: boolean,
  unit: Unit,
  currency: string | null | undefined,
): string {
  // A value that rounds to zero is zero: "−0" would read as a small loss.
  const sign = negative && /[1-9]/.test(body) ? MINUS : "";
  switch (unit) {
    case "currency": {
      const symbol = SYMBOL[currency as Currency] ?? (currency ? `${currency} ` : "");
      return `${sign}${symbol}${body}`;
    }
    case "count":
    case "ratio":
      return `${sign}${body}`;
    case "percent":
      return `${sign}${body}%`;
    case "months":
      return `${sign}${body} mo`;
  }
}

/** A value as a tile shows it: compact once it is large. */
export function formatValue(value: number, unit: Unit, currency?: string | null): string {
  const abs = Math.abs(value);
  const body =
    unit === "currency" || unit === "count"
      ? magnitude(abs)
      : unit === "ratio"
        ? twoDecimals.format(abs)
        : oneDecimal.format(abs);
  return withUnit(body, value < 0, unit, currency);
}

/** Dollars as a tile shows them: "$3,400", "$12.5K". */
export function formatUsd(value: number): string {
  return formatValue(value, "currency", "USD");
}

/**
 * The same value written out in full. A tile that says "$1.2M" carries this
 * as its tooltip, so the exact figure can always be read off.
 */
export function formatExact(value: number, unit: Unit, currency?: string | null): string {
  const abs = Math.abs(value);
  const body =
    unit === "currency" || unit === "ratio"
      ? twoDecimals.format(abs)
      : unit === "count"
        ? whole.format(abs)
        : oneDecimal.format(abs);
  return withUnit(body, value < 0, unit, currency);
}

/**
 * An amount held in its currency's minor unit (cents, tiyn), written out
 * exactly: "$1,234.50", "₸450,000". Never compacted or rounded, because a
 * payroll figure is one someone is paid. Dollars always show cents; whole
 * tenge are shown without tiyn. Worked with whole numbers throughout.
 */
export function formatMinor(minor: number, currency: Currency): string {
  const abs = Math.abs(minor);
  const cents = abs % 100;
  const fraction = currency === "KZT" && cents === 0 ? "" : `.${String(cents).padStart(2, "0")}`;
  const sign = minor < 0 ? MINUS : "";
  return `${sign}${SYMBOL[currency]}${whole.format(Math.floor(abs / 100))}${fraction}`;
}

/** A relative change (0.082 → "+8.2%"), signed, for "vs last period" labels. */
export function formatChange(ratio: number): string {
  const percent = Math.abs(ratio) * 100;
  const body = percent >= 100 ? whole.format(percent) : oneDecimal.format(percent);
  if (ratio === 0 || body === "0") return "0%";
  return `${ratio > 0 ? "+" : MINUS}${body}%`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Name a bucket by its start date. "short" is for compact "vs Sep" labels. */
export function formatPeriod(
  period: Period,
  periodStart: string,
  style: "long" | "short" = "long",
): string {
  const [year, month, day] = periodStart.split("-").map(Number) as [number, number, number];
  const monthName = MONTHS[month - 1] ?? "";
  if (period === "month") return style === "short" ? monthName : `${monthName} ${year}`;
  const monthDay = `${monthName} ${day}`;
  if (period === "week" && style === "long") return `Week of ${monthDay}`;
  return monthDay;
}

/** A run of months, first to last: "Jul–Sep 2026", "Nov 2025–Jan 2026". */
export function monthRange(from: string, to: string): string {
  if (from === to) return formatPeriod("month", from);
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  // An en dash (U+2013), as a range takes.
  return `${formatPeriod("month", from, sameYear ? "short" : "long")}–${formatPeriod("month", to)}`;
}

/** A day by name: "Sep 30", with its year once that is not this (UTC) year. */
export function dayLabel(day: string, now: number): string {
  const label = formatPeriod("day", day);
  const year = Number(day.slice(0, 4));
  return year === new Date(now).getUTCFullYear() ? label : `${label}, ${year}`;
}
