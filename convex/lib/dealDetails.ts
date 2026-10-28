// What a deal made here may carry besides a card's own fields: how much it
// matters, where it is and how big it is, and which research it came from.
// Deals only, never investors, and only native deals: a mirrored deal's
// fields are its source's, and a source sends none of these.
//
// Pure, so the UI may import it (the cleaning that throws lives in
// pipelineFields.ts, which runs only inside Convex).

export const DEAL_PRIORITIES = ["high", "medium", "low"] as const;
export type DealPriority = (typeof DEAL_PRIORITIES)[number];

export const isDealPriority = (value: unknown): value is DealPriority =>
  DEAL_PRIORITIES.includes(value as DealPriority);

/** A native deal's details as the board sends them. A field that is not set is null; no source is []. */
export type DealDetails = {
  priority: DealPriority | null;
  /** Where the practice is: a US state code, say. */
  region: string | null;
  physicians: number | null;
  locations: number | null;
  /** Titles of the research the deal came from, never a link. */
  sources: string[];
};

export const DEAL_DETAIL_FIELDS = [
  "priority",
  "region",
  "physicians",
  "locations",
  "sources",
] as const satisfies readonly (keyof DealDetails)[];

const EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/i;
// A North American number in any of the usual shapes: (555) 123-4567,
// 555.123.4567, 5551234567, +1 555 123 4567, 1-800-555-0199. Not part of a
// longer run of digits.
const US_PHONE = /(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/;
// Anything written with a country code: a plus and eight or more digits.
const INTERNATIONAL_PHONE = /\+\d{1,3}(?:[\s.-]?\d){7,13}(?!\d)/;

/**
 * Whether text holds what looks like an email address or a phone number.
 * The only person-identifying text a pipeline row may hold is a contact's
 * name: no address, no number. A blunt check on purpose: a date, a year, a
 * zip code, a CPT code or a dollar figure is not one, and a ten-digit run
 * of anything is.
 */
export function looksLikeContactDetail(text: string): boolean {
  return EMAIL.test(text) || US_PHONE.test(text) || INTERNATIONAL_PHONE.test(text);
}

/** A deal's name as two names are compared: trimmed, one space, lower case. */
export function normalDealName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Legal-form words a company's name may end in, which do not tell two companies apart. */
const LEGAL_SUFFIXES = new Set(["llc", "inc", "incorporated", "pc", "pllc", "pa", "ltd", "corp", "corporation", "co", "тоо", "too", "ип"]);

/**
 * A deal's name as a proposed new deal is compared for duplicates (Bot Loop
 * v3): lower case, "&" as "and", punctuation as spaces, one space, and a
 * trailing legal form (LLC, Inc, PC, ТОО…) dropped. "Example US Deal, LLC"
 * and "example us deal" are one name.
 */
export function dealNameKey(name: string): string {
  const words = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    // "P.C." is "pc": a dot inside an abbreviation joins it.
    .replace(/\.(?!\s|$)/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((word) => word !== "");
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1]!)) words.pop();
  return words.join(" ");
}
