// Rules for a teammate's own records: the personal token that pushes them,
// how many of each tool one person may hold, and how often one token may
// push. Pure, so the Connect page and the prompt it shows quote the same
// numbers the server enforces.
//
// Every sentence here is fixed words. None is built from a token, an address
// or anything a record holds.

import { TOKEN_STEM } from "./identity";
import type { MirrorRecord, MirrorSource } from "./mirrorRules";

/** What a personal token begins with: how the endpoint tells it from a source's token. */
export const PERSONAL_TOKEN_PREFIX = `${TOKEN_STEM}_` as const;
/** Random bytes in a token: 256 bits. */
export const PERSONAL_TOKEN_BYTES = 32;

/**
 * The most records of each tool one person may hold. Far above what a day
 * brings (the prompt asks for 15 threads and 15 meetings at most), and low
 * enough that everything a person holds is deleted in one transaction when
 * they are removed from the team.
 */
export const PERSONAL_CAPS: Record<MirrorSource, number> = {
  gmail: 200,
  google_calendar: 200,
  linear: 500,
  fireflies: 300,
};

/**
 * The most one person's stored records of each tool may take, in bytes
 * (`storedBytes`). The counts above are not enough on their own: a meeting
 * note can be tens of kilobytes at its field limits, so 300 of them could
 * come near the 16 MiB one Convex transaction may read, and then removing
 * that person from the team, and that person's own next push, would fail.
 *
 * The four together are 3.6 MB, under 4 MiB: everything one person holds is
 * read and deleted in one transaction with room to spare.
 *
 * A list that replaces what is held (mail, calendar, issues) cannot reach its
 * ceiling with a valid push: one request is at most 256 KB. Meeting notes add
 * up over 90 days and can; a push that would take them over is refused whole
 * (`too_much_data`), and what is held stays until notes age out or the person
 * forgets them. The deployment owner's own tools have no such ceiling.
 */
export const PERSONAL_BYTES: Record<MirrorSource, number> = {
  gmail: 400_000,
  google_calendar: 800_000,
  linear: 800_000,
  fireflies: 1_600_000,
};

/** What a stored row takes beyond its record and the two strings below: ids, times, field names. */
const ROW_OVERHEAD_BYTES = 300;
const utf8 = new TextEncoder();

/**
 * What one record counts as against `PERSONAL_BYTES` once stored for a
 * person: its JSON in UTF-8, the id it is filed under, the address, and an
 * allowance for the rest of the row. A little over what the document takes.
 */
export function storedBytes(owner: string, externalId: string, record: MirrorRecord): number {
  return (
    utf8.encode(JSON.stringify(record)).length +
    utf8.encode(externalId).length +
    utf8.encode(owner).length +
    ROW_OVERHEAD_BYTES
  );
}

/**
 * Pushes one token may make for one tool in an hour. The suggested task runs
 * once a day, so this leaves room for "Run now" and for retries, and stops a
 * task stuck in a loop. Nothing here knows the hour a task runs at.
 */
export const PUSH_WINDOW_MS = 60 * 60 * 1000;
export const MAX_PUSHES_PER_WINDOW = 10;

// What the endpoint answers a personal token with. Error names first, then
// the sentence that goes with each.
export const TOO_MANY_PUSHES = "too_many_pushes";
export const TOO_MANY_PUSHES_WORDS = `At most ${MAX_PUSHES_PER_WINDOW} pushes an hour for each tool. Try again later.`;
export const RECORDS_ONLY_WORDS = "This token carries records and nothing else.";
export const NOT_A_PERSONAL_TOOL_WORDS =
  "A personal token carries records for gmail, google_calendar, linear or fireflies only.";
export const TOO_MANY_RECORDS = "too_many_records";
export const tooManyRecordsWords = (source: MirrorSource) =>
  `At most ${PERSONAL_CAPS[source]} records of this tool are held for one person.`;

export const TOO_MUCH_DATA = "too_much_data";
export const tooMuchDataWords = (source: MirrorSource) =>
  `At most ${Math.round(PERSONAL_BYTES[source] / 1000).toLocaleString("en-US")} KB of this tool's records are held for one person.`;

/** Said to the owner, whose own tools are the deployment's and are set up elsewhere. */
export const OWNER_HAS_NO_PERSONAL_TOKEN =
  "The owner's tools are set up under Settings → Work tools, not with a personal token.";

export function isPersonalToken(given: string): boolean {
  return given.startsWith(PERSONAL_TOKEN_PREFIX);
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Bytes as URL-safe base64 with no padding: letters, digits, "-" and "_". */
export function base64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += BASE64URL[a >> 2];
    out += BASE64URL[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) out += BASE64URL[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) out += BASE64URL[c & 63];
  }
  return out;
}

/** A token made of these bytes. */
export function tokenFrom(bytes: Uint8Array): string {
  return `${PERSONAL_TOKEN_PREFIX}${base64Url(bytes)}`;
}

/** SHA-256 of a token, in hex: the only form of it that is ever stored or passed on. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Where a token's pushes for one tool stand in the current window, and what
 * the next push does to it. A fixed window: it opens with the first push and
 * is replaced by a new one once it is an hour old.
 */
export function nextPushWindow(
  current: { windowStart?: number; pushes?: number },
  at: number,
): { allowed: boolean; windowStart: number; pushes: number } {
  const open =
    current.windowStart !== undefined &&
    at >= current.windowStart &&
    at - current.windowStart < PUSH_WINDOW_MS;
  if (!open) return { allowed: true, windowStart: at, pushes: 1 };
  const pushes = current.pushes ?? 0;
  if (pushes >= MAX_PUSHES_PER_WINDOW) {
    return { allowed: false, windowStart: current.windowStart!, pushes };
  }
  return { allowed: true, windowStart: current.windowStart!, pushes: pushes + 1 };
}
