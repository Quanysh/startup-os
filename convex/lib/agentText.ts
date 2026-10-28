// Text a model wrote, made storable. The owner's agents write bullets,
// reasons, drafts and answers (convex/lib/agents.ts); each goes through one
// of these two on the way in. Pure.
//
// Both use `cleanRemote` (convex/lib/mirrorRules.ts), the cleaner for text
// another system chose: control characters, line separators, direction
// overrides and zero-width characters go, so what is stored is what the eye
// reads. Nothing here interprets the text: markup stays as the characters it
// is, and the page renders it as text.

import { cleanRemote } from "./mirrorRules";

/** One line, single spaces. Longer than `max` is cut with an ellipsis: callers refuse it first. */
export const cleanLine = (value: unknown, max: number): string => cleanRemote(value, max);

/**
 * Several lines: each cleaned as a line is, blank runs kept to one, blank
 * lines at either end dropped. `null` when it is over `max` characters, for
 * the caller to refuse in its own fixed words.
 */
export function cleanLines(value: unknown, max: number): string | null {
  if (typeof value !== "string") return "";
  const lines = value
    .split(/\r\n|\n|\r|\u2028|\u2029/)
    .map((line) => cleanRemote(line, Number.MAX_SAFE_INTEGER));
  const kept: string[] = [];
  for (const line of lines) {
    if (line === "" && (kept.length === 0 || kept.at(-1) === "")) continue;
    kept.push(line);
  }
  while (kept.at(-1) === "") kept.pop();
  const text = kept.join("\n");
  return text.length > max ? null : text;
}
