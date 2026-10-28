import type { z } from "zod";
import { ConnectorError } from "./errors";

// A step in the path to the mismatch that is safe to store: a position in a
// list, or a plain field name such as our own schemas use. Anything else may
// be a key the service chose, and is replaced.
const PLAIN_KEY = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const safeStep = (step: PropertyKey) =>
  typeof step === "number" || (typeof step === "string" && PLAIN_KEY.test(step))
    ? String(step)
    : "?";

/**
 * Parse, or fail in words short and safe enough for the run log: whose
 * response, which one, and where the shape differed. Nothing of what was
 * sent. `who` and `what` are written by the caller.
 */
export function expectShape<T>(schema: z.ZodType<T>, raw: unknown, who: string, what: string): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const where = (result.error.issues[0]?.path ?? []).map(safeStep).join(".");
  throw new ConnectorError(`${who}'s ${what} response is not in the expected shape (${where}).`);
}
