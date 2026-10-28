// The runway chart's one vertical scale: zero always in view, round ticks.
// Positions are percentages of the plot's height, top 0, bottom 100.

/** Round tick values from `min` to `max`, about five of them, zero among them when the range holds it. */
export function niceTicks(min: number, max: number): number[] {
  const span = Math.max(max - min, 1);
  const rough = span / 5;
  const power = 10 ** Math.floor(Math.log10(rough));
  // Values are whole (minor units, counts): a step under one would round to
  // repeated ticks (0, 0, 0, 1, 1 for an all-zero series), so one is the least.
  const step = Math.max(1, [1, 2, 2.5, 5, 10].map((f) => f * power).find((s) => s >= rough) ?? 10 * power);
  const first = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let value = first; value < max + step; value += step) ticks.push(Math.round(value));
  return ticks;
}

export type Scale = { min: number; max: number; ticks: number[]; y: (value: number) => number };

export function chartScale(series: readonly (readonly number[])[]): Scale {
  const values = series.flat();
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  const min = ticks[0]!;
  const max = ticks.at(-1)!;
  const span = max - min || 1;
  return { min, max, ticks, y: (value) => ((max - value) / span) * 100 };
}
