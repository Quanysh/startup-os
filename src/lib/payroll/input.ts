// What the payroll forms read and write. Money is typed in the currency's
// own units ("1234.50") and held as a whole number of minor units; a rate is
// typed as a percentage ("12.5") and held as basis points. Parsed from the
// digits, never through a float, so what is saved is what was typed.

const DIGITS = /^(\d*)(?:\.(\d{1,2}))?$/;

/** Whole and hundredths from a plain decimal, or null where it is not one. */
function parts(text: string): [number, number] | null {
  const found = DIGITS.exec(text);
  if (found === null || (found[1] === "" && found[2] === undefined)) return null;
  const whole = Number(found[1] || "0");
  const hundredths = Number((found[2] ?? "").padEnd(2, "0"));
  return [whole, hundredths];
}

/**
 * An amount as typed, in minor units, or null where it is not an amount.
 * Spaces and commas between digits are thousands separators. A sign is read
 * only when `signed` (a month's adjustment can be a deduction).
 */
export function parseMoney(text: string, options: { signed?: boolean } = {}): number | null {
  let body = text.trim().replace(/[\s ,]/g, "");
  let sign = 1;
  if (options.signed && /^[-−+]/.test(body)) {
    if (body[0] !== "+") sign = -1;
    body = body.slice(1);
  }
  const read = parts(body);
  if (read === null) return null;
  const minor = read[0] * 100 + read[1];
  if (!Number.isSafeInteger(minor)) return null;
  // No "-0": a deduction of nothing is nothing.
  return minor === 0 ? 0 : sign * minor;
}

/** An amount as a field shows it for editing: "1234.50", "450000". */
export function moneyInput(minor: number): string {
  const abs = Math.abs(minor);
  const cents = abs % 100;
  const body = `${Math.floor(abs / 100)}${cents === 0 ? "" : `.${String(cents).padStart(2, "0")}`}`;
  return minor < 0 ? `-${body}` : body;
}

/** A rate typed as a percentage, in basis points: 0 to 100, two decimals at most. */
export function parsePercent(text: string): number | null {
  const read = parts(text.trim().replace(/\s*%$/, "").trim());
  if (read === null) return null;
  const bp = read[0] * 100 + read[1];
  return bp <= 10_000 ? bp : null;
}

/** Basis points as a field shows them: "12.5". */
export function percentInput(bp: number): string {
  const hundredths = bp % 100;
  const fraction = hundredths === 0 ? "" : `.${String(hundredths).padStart(2, "0").replace(/0$/, "")}`;
  return `${Math.floor(bp / 100)}${fraction}`;
}

export const formatRate = (bp: number) => `${percentInput(bp)}%`;

/** The first day of the month where the user is, as "YYYY-MM-01". */
export function monthOf(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
