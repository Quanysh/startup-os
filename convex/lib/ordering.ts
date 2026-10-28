/**
 * The order of a list after putting `id` at `index`: inserting it if it is
 * new, moving it if it is already there. An out-of-range index is clamped.
 * Returns a new array.
 */
export function placeAt<T>(ids: readonly T[], id: T, index: number): T[] {
  const rest = ids.filter((existing) => existing !== id);
  const at = Math.min(Math.max(index, 0), rest.length);
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}
