import { ConvexError } from "convex/values";

/** An open card a new one may repeat, as the server names it (convex/tasks.ts `nearTasks`). */
export type NearCard = { id: string; title: string };

/**
 * The open cards a refused add names, when the server stopped it to warn of a
 * near duplicate (`duplicates: "warn"`, code `possible_duplicate`); null for
 * any other outcome. The add can then be sent again with `"confirmed"`.
 */
export function duplicateWarning(error: unknown): NearCard[] | null {
  if (!(error instanceof ConvexError)) return null;
  const data: unknown = error.data;
  if (data === null || typeof data !== "object" || !("refusal" in data)) return null;
  const refusal = (data as { refusal: unknown }).refusal as { code?: unknown; matches?: unknown } | null;
  if (refusal === null || refusal.code !== "possible_duplicate" || !Array.isArray(refusal.matches)) return null;
  return refusal.matches.filter(
    (match): match is NearCard =>
      typeof match === "object" && match !== null && typeof match.id === "string" && typeof match.title === "string",
  );
}

/** "Possible duplicate of “Send the deck”." The titles are text and rendered as text. */
export const nearCardsSentence = (cards: readonly NearCard[]) =>
  `Possible duplicate of ${cards.map((card) => `“${card.title}”`).join(" or ")}.`;
