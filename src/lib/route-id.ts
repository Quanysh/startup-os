/** A record's id as the address carries it, read once more if it was encoded; never a throw. */
export function idFromParam(raw: string | undefined): string {
  if (raw === undefined) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
