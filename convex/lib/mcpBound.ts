// Keeps a tool's answer within its caps (convex/lib/mcpTools.ts): so many
// rows, so many bytes, and a `truncated` flag that says when either cut it.
// No tool hands back an unbounded list. Pure.

export type Caps = {
  /** The most rows an answer holds, over all its lists together. */
  rows: number;
  /** The most bytes its JSON takes, in UTF-8. */
  bytes: number;
};

export type ToolOutput = Record<string, unknown>;

const utf8 = new TextEncoder();
const bytesOf = (value: unknown) => utf8.encode(JSON.stringify(value)).length;

type List = { read: () => unknown[]; write: (rows: unknown[]) => void };

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * An answer's lists, in its own order: an array at the top, or the arrays of
 * an object at the top whose every value is one (a board's columns by stage).
 */
function listsOf(output: ToolOutput): List[] {
  const lists: List[] = [];
  for (const [key, value] of Object.entries(output)) {
    if (Array.isArray(value)) {
      lists.push({ read: () => output[key] as unknown[], write: (rows) => (output[key] = rows) });
    } else if (isPlain(value) && Object.values(value).every(Array.isArray)) {
      const columns = { ...value } as Record<string, unknown[]>;
      output[key] = columns;
      for (const column of Object.keys(columns)) {
        lists.push({ read: () => columns[column]!, write: (rows) => (columns[column] = rows) });
      }
    }
  }
  return lists;
}

/**
 * The answer cut to its caps, with `truncated` saying whether it was.
 *
 * Rows first: lists keep their rows in order until the budget is spent, and
 * what is over is dropped from the end. Then bytes: while the JSON is over,
 * the longest list loses its last quarter (one row at least). An answer whose
 * lists are empty and is still over keeps what it has: nothing a tool returns
 * outside a list is large.
 */
export function bound(given: ToolOutput, caps: Caps): ToolOutput & { truncated: boolean } {
  const output: ToolOutput = { ...given };
  const lists = listsOf(output);
  let truncated = false;

  let room = Math.max(0, Math.floor(caps.rows));
  for (const list of lists) {
    const rows = list.read();
    if (rows.length > room) {
      list.write(rows.slice(0, room));
      truncated = true;
    }
    room -= list.read().length;
  }

  while (bytesOf(output) > caps.bytes) {
    const longest = lists.reduce<List | null>(
      (best, list) => (best === null || list.read().length > best.read().length ? list : best),
      null,
    );
    if (longest === null || longest.read().length === 0) break;
    const rows = longest.read();
    longest.write(rows.slice(0, rows.length - Math.max(1, Math.ceil(rows.length / 4))));
    truncated = true;
  }
  return { ...output, truncated };
}
