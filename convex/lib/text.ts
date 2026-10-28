import { ConvexError } from "convex/values";
import { MAX_TITLE_LENGTH, MAX_URL_LENGTH } from "./limits";

/** A trimmed, non-empty title within the length cap. `what` names the thing. */
export function cleanTitle(title: string, what: string): string {
  const trimmed = title.trim();
  if (trimmed === "") throw new ConvexError(`A ${what} needs a title.`);
  if (trimmed.length > MAX_TITLE_LENGTH) {
    throw new ConvexError(`That title is too long (${MAX_TITLE_LENGTH} characters at most).`);
  }
  return trimmed;
}

/** Trimmed free text within `max` characters. Blank comes back as "". */
export function cleanText(text: string, max: number, what: string): string {
  const trimmed = text.trim();
  if (trimmed.length > max) {
    throw new ConvexError(`${what} is too long (${max} characters at most).`);
  }
  return trimmed;
}

/**
 * A link that is safe to render as one: a full https address. `javascript:`,
 * `data:` and plain http are refused, by the same fixed message.
 */
export function cleanLink(url: string, what: string): string {
  const trimmed = url.trim();
  if (trimmed.length > MAX_URL_LENGTH) {
    throw new ConvexError(`${what} is too long (${MAX_URL_LENGTH} characters at most).`);
  }
  let protocol = "";
  try {
    protocol = new URL(trimmed).protocol;
  } catch {
    // Falls through to the one message below.
  }
  if (protocol !== "https:") throw new ConvexError(`${what} must be a full https:// address.`);
  return trimmed;
}
