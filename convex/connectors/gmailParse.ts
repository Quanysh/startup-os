// Pure: Gmail's metadata responses → threads waiting on the owner.
// The rules are the table in the plan's Task 3; keep the two in step.

import { CAPS, cleanAddress, cleanRemote, type Person, type RecordOf } from "../lib/mirrorRules";
import { ConnectorError } from "./errors";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Gmail ids are hexadecimal. Checked because the id becomes part of a URL. */
export const THREAD_ID = /^[0-9a-f]{1,32}$/;
const NOT_WAITING_LABELS = new Set([
  "SENT",
  "DRAFT",
  "SPAM",
  "TRASH",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
]);
const AUTOMATED_LOCAL_PART =
  /^(no-?reply|do-?not-?reply|notifications?|mailer-daemon|postmaster|bounces?)([+._-].*)?$/;

const listShape = () => new ConnectorError("Gmail's inbox list was not in the expected shape.");
const threadShape = () => new ConnectorError("A Gmail thread was not in the expected shape.");

export function parseThreadList(json: unknown): string[] {
  if (!isRecord(json)) throw listShape();
  // An inbox with nothing in it answers with no `threads` field at all.
  const threads = json.threads ?? [];
  if (!Array.isArray(threads)) throw listShape();
  const ids = threads.map((thread) => {
    const id = isRecord(thread) ? thread.id : undefined;
    if (typeof id !== "string" || !THREAD_ID.test(id)) throw listShape();
    return id;
  });
  // Each thread once, whatever the list says: one record per id is the store's rule.
  return [...new Set(ids)];
}

/** `"Ada Example" <ada@example.test>` or a bare address. */
export function parseFrom(value: string): Person {
  const angled = /^(.*)<([^<>]+)>\s*$/.exec(value);
  return {
    name: angled ? cleanRemote((angled[1] ?? "").replace(/^[\s"']+|[\s"']+$/g, ""), CAPS.name) : "",
    address: cleanAddress(angled ? angled[2] : value),
  };
}

export function parseThread(
  threadId: string,
  json: unknown,
  isOwner: (address: string) => boolean,
): RecordOf<"mail"> | null {
  if (!isRecord(json) || !Array.isArray(json.messages) || json.messages.length === 0) {
    throw threadShape();
  }
  let last: Record<string, unknown> | undefined;
  let lastAt = -1;
  for (const message of json.messages) {
    if (!isRecord(message)) throw threadShape();
    const at = Number(message.internalDate);
    if (message.internalDate === undefined || !Number.isFinite(at)) throw threadShape();
    if (at >= lastAt) {
      last = message;
      lastAt = at;
    }
  }
  if (last === undefined) throw threadShape();

  const labels = Array.isArray(last.labelIds) ? last.labelIds : [];
  if (labels.some((label) => typeof label === "string" && NOT_WAITING_LABELS.has(label))) return null;

  const headers = new Map<string, string>();
  const raw = isRecord(last.payload) && Array.isArray(last.payload.headers) ? last.payload.headers : [];
  for (const header of raw) {
    if (!isRecord(header) || typeof header.name !== "string" || typeof header.value !== "string") continue;
    const name = header.name.toLowerCase();
    if (!headers.has(name)) headers.set(name, header.value);
  }

  if (headers.has("list-unsubscribe") || headers.has("list-id")) return null;
  if (/^(bulk|list|junk)$/i.test((headers.get("precedence") ?? "").trim())) return null;
  if ((headers.get("auto-submitted") ?? "no").trim().toLowerCase() !== "no") return null;

  const from = parseFrom(headers.get("from") ?? "");
  if (from.address === "" || isOwner(from.address)) return null;
  if (AUTOMATED_LOCAL_PART.test(from.address.split("@")[0] ?? "")) return null;

  return {
    kind: "mail",
    threadId,
    fromName: from.name,
    fromAddress: from.address,
    subject: cleanRemote(headers.get("subject"), CAPS.title) || "(no subject)",
    lastMessageAt: lastAt,
  };
}
