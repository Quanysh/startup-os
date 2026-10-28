// What the seed reports: how many rows each table holds. Counts only, never a row.

/** The counts `devSeed.run` returned, out of what `convex run` printed, or null. */
export function parseCounts(output: string): Record<string, number> | null {
  // The CLI may print notices first; the result is the last JSON object.
  const start = output.lastIndexOf("\n{") + 1;
  try {
    const value: unknown = JSON.parse(output.slice(output.indexOf("{", start)));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const entries = Object.entries(value);
    return entries.length > 0 && entries.every(([, count]) => typeof count === "number")
      ? (Object.fromEntries(entries) as Record<string, number>)
      : null;
  } catch {
    return null;
  }
}

/** One line per table, by name, the numbers in a column. */
export function countLines(counts: Record<string, number>): string[] {
  const width = Math.max(...Object.keys(counts).map((table) => table.length));
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([table, count]) => `  ${table.padEnd(width)}  ${String(count).padStart(5)}`);
}

export function printCounts(output: string) {
  const counts = parseCounts(output);
  console.log(counts === null ? "Done." : countLines(counts).join("\n"));
}
