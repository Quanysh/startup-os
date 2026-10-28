import { personLabel, type Person } from "./assignee";

// Mentions in a task's title and description, as the editor offers them and
// as a card shows them. Pure, so the text handling can be tested alone.
//
// A mention in the text is `@` and the person's name: readable, and only
// text. Who a save mentions is a list of addresses sent beside the text
// (`mentionedIn`), which the server checks (convex/tasks.ts). Nothing here
// or there reads a name back out of the text to decide who is told.

export type Picked = { email: string; label: string };
export type Offer = Person & { label: string };

/** People offered at once. */
const MAX_OFFERED = 6;

/**
 * What is being typed after an `@`, if the caret is in such a word: where
 * the `@` is and the letters after it. Null for an `@` inside a word (an
 * address), or once a space has been typed.
 */
export function mentionQuery(value: string, caret: number): { at: number; query: string } | null {
  const match = /(?:^|[\s(])@([^\s@]{0,40})$/.exec(value.slice(0, caret));
  if (match === null) return null;
  const query = match[1]!;
  return { at: caret - query.length - 1, query };
}

/** The people whose name, or address before the `@`, has a word starting with what was typed. */
export function matchPeople(people: readonly Person[] | undefined, query: string): Offer[] {
  const wanted = query.toLowerCase();
  const starts = (text: string) =>
    text
      .toLowerCase()
      .split(/[\s._-]+/)
      .some((word) => word.startsWith(wanted));
  return (people ?? [])
    .filter((person) => starts(person.name ?? "") || starts(person.email.split("@")[0]!))
    .slice(0, MAX_OFFERED)
    .map((person) => ({ ...person, label: personLabel(person) }));
}

/** The text with `@name` and a space in place of what was typed from `at` to the caret, and the new caret. */
export function insertMention(
  value: string,
  at: number,
  caret: number,
  label: string,
): { value: string; caret: number } {
  const rest = value.slice(caret);
  // One space after the name: the one already there, or a new one.
  const inserted = rest.startsWith(" ") ? `@${label}` : `@${label} `;
  return { value: value.slice(0, at) + inserted + rest, caret: at + label.length + 2 };
}

/** The addresses a save mentions: those picked whose `@name` is still in one of the texts. */
export function mentionedIn(picked: readonly Picked[], texts: readonly string[]): string[] {
  const emails = picked
    .filter(({ label }) => texts.some((text) => mentionParts(text, [label]).some((p) => p.mention)))
    .map(({ email }) => email);
  return [...new Set(emails)];
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Stored text cut where it says `@name` for one of the names a card
 * mentions, so the page can set those apart. The parts joined are the text
 * exactly; nothing is ever turned into markup.
 */
export function mentionParts(
  text: string,
  labels: readonly string[],
): { text: string; mention: boolean }[] {
  const names = [...new Set(labels)].filter((label) => label !== "");
  if (names.length === 0) return [{ text, mention: false }];
  // Longest first, so "Ada Example" is not read as "Ada".
  names.sort((a, b) => b.length - a.length);
  const pattern = new RegExp(
    `(?<=^|[\\s(])@(?:${names.map(escape).join("|")})(?![\\p{L}\\p{N}_])`,
    "gu",
  );
  const parts: { text: string; mention: boolean }[] = [];
  let from = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > from) parts.push({ text: text.slice(from, match.index), mention: false });
    parts.push({ text: match[0], mention: true });
    from = match.index + match[0].length;
  }
  if (from < text.length || parts.length === 0) parts.push({ text: text.slice(from), mention: false });
  return parts;
}
