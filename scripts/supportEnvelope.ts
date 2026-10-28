// The logic of `pnpm support:envelope`: the daily Intercom task's raw results
// (what Claude's Intercom connector returned from `search_conversations`,
// saved to a private scratch folder) mapped to one envelope for the
// `intercom` source (docs/ingest.md, "Intercom"; docs/setup.md).
//
// The mapping is convex/lib/supportParse.ts, whose schemas name only the
// fields kept: a message, a subject, the contacts, an author, an address, a
// phone number and a company are dropped at the door. The envelope is then
// checked with the endpoint's own rules before it is written. Nothing here
// prints a conversation's id, a name or a title: counts and the file's path.
//
// The input file holds the task's two searches, each the list of its pages in
// order, and nothing else: `{ "open": [...], "updated": [...] }` (every open
// chat; every chat updated in the last 90 days). A push replaces what is
// stored, so anything less would delete chats: each search must be read to its
// last page and hold as many chats as its `total_count` says (a page without
// one is refused), the open search must hold open chats only, and a file with
// no conversation at all is written only with --allow-empty. --allow-shrink
// lets a push remove more than half of what is stored (the server refuses that
// otherwise).

import { dirname, join, basename } from "node:path";
import { INTERCOM_APP_ID } from "../convex/lib/features";
import { INTERCOM_SOURCE, MAX_SUPPORT_CONVERSATIONS, SUPPORT_ORIGINS, SUPPORT_READ_DAYS, isAppId } from "../convex/lib/support";
import { parseSearch, toRecord, type IntercomConversation, type SearchPage } from "../convex/lib/supportParse";
import { parseSupportPush } from "../convex/lib/supportRecords";

export const USAGE =
  "Usage: pnpm support:envelope <raw.json> [--out file] [--app id_code] [--allow-empty] [--allow-shrink]";
/** Globex's Intercom workspace, as its inbox's address names it (convex/lib/features.ts). */
export const GLOBEX_APP_ID = INTERCOM_APP_ID;

export type EnvelopeDeps = {
  readFile: (path: string) => string;
  writeFile: (path: string, text: string, mode: number) => void;
  print: (line: string) => void;
  printError: (line: string) => void;
  now: () => Date;
};

const DAY_MS = 24 * 60 * 60 * 1000;
export const INCOMPLETE =
  "The read is incomplete: a search has pages not read, or fewer chats than Intercom counted. Nothing was written.";
const NOT_RESULTS = "The file is not the connector's search results. Nothing was written.";
const NOT_TWO =
  'The file must hold the two searches and nothing else: { "open": [pages], "updated": [pages] }. Nothing was written.';
const SWAPPED = "The open search holds a chat that is not open: are the two searches swapped? Nothing was written.";
const NONE =
  "No conversation was read. If the inbox really has none, run again with --allow-empty. Nothing was written.";

/** The file's two searches, each its pages in order; null for any other shape. */
function searchesOf(raw: unknown): { open: unknown[]; updated: unknown[] } | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const keys = Object.keys(raw).sort();
  if (keys.length !== 2 || keys[0] !== "open" || keys[1] !== "updated") return null;
  const { open, updated } = raw as { open: unknown; updated: unknown };
  if (!Array.isArray(open) || !Array.isArray(updated) || open.length === 0 || updated.length === 0) return null;
  return { open, updated };
}

/**
 * Whether a search was read whole: every page but the last says there is
 * more, the last does not, and its first page's `total_count` (which must be
 * there) is the number of chats read.
 */
function complete(pages: readonly SearchPage[]): boolean {
  if (pages.length === 0) return false;
  const chained = pages.every((page, i) => (i === pages.length - 1 ? page.next === null : page.next !== null));
  const total = pages[0]!.total;
  const read = pages.reduce((sum, page) => sum + page.conversations.length, 0);
  return chained && total !== null && total === read;
}

function flag(args: readonly string[], name: string): string | undefined | null {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

export async function run(args: readonly string[], deps: EnvelopeDeps): Promise<number> {
  const path = args[0];
  const out = flag(args, "--out");
  const app = flag(args, "--app");
  if (path === undefined || path.startsWith("--") || out === null || app === null) {
    deps.printError(USAGE);
    return 1;
  }
  const appIdCode = app ?? GLOBEX_APP_ID;
  if (!isAppId(appIdCode)) {
    deps.printError("--app is the workspace's id code: lower-case letters and digits.");
    return 1;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(deps.readFile(path));
  } catch (error) {
    deps.printError(error instanceof SyntaxError ? NOT_RESULTS : "Could not read the file.");
    return 1;
  }

  const two = searchesOf(raw);
  if (two === null) {
    deps.printError(NOT_TWO);
    return 1;
  }
  let open: SearchPage[];
  let updated: SearchPage[];
  try {
    open = two.open.map((page) => parseSearch(page));
    updated = two.updated.map((page) => parseSearch(page));
  } catch {
    // The parser's own words name a path; none is needed here.
    deps.printError(NOT_RESULTS);
    return 1;
  }
  if (!complete(open) || !complete(updated)) {
    deps.printError(INCOMPLETE);
    return 1;
  }
  if (open.some((page) => page.conversations.some((chat) => !chat.open))) {
    deps.printError(SWAPPED);
    return 1;
  }
  const searches = [open, updated];

  const now = deps.now();
  const since = now.getTime() - SUPPORT_READ_DAYS * DAY_MS;
  // One per chat, the newest reading of it where two searches both hold it.
  const chats = new Map<string, IntercomConversation>();
  for (const page of searches.flat()) {
    for (const chat of page.conversations) {
      const before = chats.get(chat.id);
      if (before === undefined || chat.updated_at > before.updated_at) chats.set(chat.id, chat);
    }
  }
  const records = [...chats.values()]
    .filter((chat) => chat.open || chat.updated_at * 1000 >= since)
    // By id as a number: digits only, so the shorter is the smaller.
    .sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id))
    .map(toRecord);
  const allowEmpty = args.includes("--allow-empty");
  if (records.length === 0 && !allowEmpty) {
    deps.printError(NONE);
    return 1;
  }
  if (records.length > MAX_SUPPORT_CONVERSATIONS) {
    deps.printError(`More than ${MAX_SUPPORT_CONVERSATIONS} conversations: more than one push holds. Nothing was written.`);
    return 1;
  }

  const envelope = {
    version: 1,
    source: INTERCOM_SOURCE,
    batchId: `${INTERCOM_SOURCE}-${now.toISOString().slice(0, 10)}`,
    observedAt: now.toISOString(),
    appIdCode,
    records,
    // Said only when asked for: an empty list is otherwise a failed read.
    ...(records.length === 0 && allowEmpty ? { empty: true } : {}),
    ...(args.includes("--allow-shrink") ? { allowShrink: true } : {}),
  };
  // The endpoint's own rules, so a file that would be refused is never written.
  const checked = parseSupportPush(records, appIdCode, now.getTime());
  if (!checked.ok) {
    deps.printError("The envelope would be refused (a conversation is not in the expected shape). Nothing was written.");
    return 1;
  }

  const target = out ?? join(dirname(path), `${basename(path).replace(/\.json$/i, "")}.envelope.json`);
  try {
    deps.writeFile(target, `${JSON.stringify(envelope, null, 2)}\n`, 0o600);
  } catch {
    deps.printError("Could not write the envelope.");
    return 1;
  }
  const began = SUPPORT_ORIGINS.map((origin) => `${origin} ${records.filter((r) => r.origin === origin).length}`);
  deps.print(`Intercom: ${records.length} conversations (${began.join(", ")}).`);
  deps.print(`Envelope written to ${target}`);
  return 0;
}
