/** "1 open deal", "3 open deals". */
export function countOf(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Picks the verb to agree with a count: is/are, has/have. */
export function agree(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
