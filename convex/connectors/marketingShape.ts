// Local to the Search Console and Apollo connectors. Another branch adds a
// shared `expectShape` for every connector; the two are to be reconciled when
// the branches merge.

import type { z } from "zod";
import { ConnectorError } from "./errors";

// A step in the path to the mismatch that is safe to store: a position in a
// list, or a plain field name such as our own schemas use. Anything else may
// be a key the source chose, and is replaced.
const PLAIN_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const safeStep = (step: PropertyKey) =>
  typeof step === "number" || (typeof step === "string" && PLAIN_KEY.test(step))
    ? String(step)
    : "?";

/**
 * Parse a response, or fail in words short and safe enough for the run log:
 * whose response it was and where its shape differed, and nothing of what was
 * sent. `whose` is ours ("Apollo's sequences").
 *
 * The "where" is a path of this schema's own field names and array positions.
 * Use schemas of fixed keys: with `z.record` a step would be a key the source
 * chose, which is why such a step is written as "?".
 */
export function expectShape<T>(schema: z.ZodType<T>, raw: unknown, whose: string): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const where = (result.error.issues[0]?.path ?? []).map(safeStep).join(".");
  throw new ConnectorError(`${whose} response is not in the expected shape (${where}).`);
}
