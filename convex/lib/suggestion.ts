// "Suggest a change": what a teammate types into the sidebar's dialog, and the
// card it becomes on the task board. Pure, so the dialog checks a text with
// the same rules the server applies (convex/suggestions.ts).

import { MAX_TITLE_LENGTH } from "./limits";
import { cleanRemote } from "./mirrorRules";

export const SUGGESTION_SOURCE = "suggestion";

export const SUGGESTION_MIN_LENGTH = 5;
export const SUGGESTION_MAX_LENGTH = 500;
/** "Which page": a path, or a few words naming one. */
export const SUGGESTION_PAGE_MAX_LENGTH = 200;
/** The most one person can send in a UTC day. */
export const MAX_SUGGESTIONS_PER_DAY = 20;

// Every refusal, in fixed words: none quotes what was typed.
export const SUGGESTION_WORDS = {
  too_short: `Say a little more: at least ${SUGGESTION_MIN_LENGTH} characters.`,
  too_long: `That is too long (${SUGGESTION_MAX_LENGTH} characters at most).`,
  page_too_long: `The page is too long (${SUGGESTION_PAGE_MAX_LENGTH} characters at most).`,
  too_many: `That is ${MAX_SUGGESTIONS_PER_DAY} suggestions today. Send the next one tomorrow.`,
} as const;
export type SuggestionRefusal = keyof typeof SUGGESTION_WORDS;

export type SuggestionCard =
  | { ok: true; title: string; notes: string | undefined }
  | { ok: false; error: Exclude<SuggestionRefusal, "too_many"> };

// A line cleaned as text from outside is: nothing invisible, controlling or
// direction-changing, single spaces. The cap is only there to bound the work;
// the length rule below is the one a person meets.
const cleanLine = (line: string) => cleanRemote(line, 10 * SUGGESTION_MAX_LENGTH);

/** The text as it is judged and stored: each line cleaned, blank edges dropped. */
export function cleanSuggestion(text: string): string {
  const lines = text.split(/\r\n|\r|\n/).map(cleanLine);
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  // Two blank lines in a row say no more than one.
  return lines.filter((line, index) => line !== "" || lines[index - 1] !== "").join("\n");
}

/**
 * The card a suggestion becomes, or why it is refused. The title is the first
 * line, cut to the board's title limit; the rest goes in the notes, with the
 * page it was sent from. A first line that had to be cut is kept whole in the
 * notes, so nothing typed is lost.
 */
export function suggestionCard(text: string, page?: string | null): SuggestionCard {
  const cleaned = cleanSuggestion(text);
  if (cleaned.length < SUGGESTION_MIN_LENGTH) return { ok: false, error: "too_short" };
  if (cleaned.length > SUGGESTION_MAX_LENGTH) return { ok: false, error: "too_long" };
  const where = cleanLine(page ?? "");
  if (where.length > SUGGESTION_PAGE_MAX_LENGTH) return { ok: false, error: "page_too_long" };

  const [first = "", ...others] = cleaned.split("\n");
  const title = cleanRemote(first, MAX_TITLE_LENGTH);
  const rest = (title === first ? others : [first, ...others]).join("\n").trim();
  const notes = [rest, where === "" ? "" : `Page: ${where}`].filter(Boolean).join("\n\n");
  return { ok: true, title, notes: notes === "" ? undefined : notes };
}
