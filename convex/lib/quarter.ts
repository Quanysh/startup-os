// Calendar quarters, named "YYYY-Qn". Goals are set per quarter.

const QUARTER = /^\d{4}-Q[1-4]$/;

export function isQuarter(value: string): boolean {
  return QUARTER.test(value);
}

export function quarterOf(at: Date | number): string {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}
