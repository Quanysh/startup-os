import { ConvexError } from "convex/values";

/**
 * The reason a mutation failed, in words fit to show. Convex functions throw
 * ConvexError with a readable message (or a list of issues) for anything the
 * owner can act on; anything else gets the fallback.
 */
export function messageOf(error: unknown, fallback = "That could not be saved. Try again."): string {
  if (error instanceof ConvexError) {
    const data = error.data as unknown;
    if (typeof data === "string") return data;
    if (data && typeof data === "object" && "issues" in data) {
      const first = (data as { issues: { message: string }[] }).issues[0];
      if (first) return first.message;
    }
  }
  return fallback;
}
