// The flow's one drawn mark: a single band running through the stages, as
// thick at each as the stage is full, so a pile-up is a bulge. Pure geometry;
// the component draws the path and writes every number beside it, so the band
// is never the only way to read a count.
//
// One scale for every stage (the fullest takes the whole height), one hue,
// and an empty stage keeps a hairline so the band still reads as one flow.

/** The band's height in its own units, and the thickness of a stage with nothing in it. */
export const BAND_HEIGHT = 48;
export const BAND_MIN = 2;
/** A stage's share of the band's length, and how much of it the band runs level for. */
const STAGE = 100;
const LEVEL = 60;

const round = (n: number) => Math.round(n * 100) / 100;

export function flowBand(counts: readonly number[]): {
  /** An SVG path in a `0 0 width BAND_HEIGHT` box; drawn stretched to the columns' width. */
  path: string;
  /** How thick the band is at each stage, in the same units. */
  thickness: number[];
  width: number;
} {
  if (counts.length === 0) return { path: "", thickness: [], width: 0 };
  const most = Math.max(...counts, 0);
  const thickness = counts.map((count) =>
    // Something there is always visibly more than nothing.
    count > 0 && most > 0 ? Math.max((count / most) * BAND_HEIGHT, BAND_MIN + 1) : BAND_MIN,
  );
  const width = counts.length * STAGE;
  const inset = (STAGE - LEVEL) / 2;
  const top = thickness.map((t) => round((BAND_HEIGHT - t) / 2));

  // The top edge, left to right: level across each stage, eased between two.
  const edge = (ys: readonly number[]): string[] => {
    const parts: string[] = [];
    ys.forEach((y, i) => {
      const from = i * STAGE + inset;
      const to = from + LEVEL;
      if (i > 0) {
        const mid = i * STAGE;
        parts.push(`C${mid},${ys[i - 1]} ${mid},${y} ${from},${y}`);
      }
      parts.push(`L${i === ys.length - 1 ? width : to},${y}`);
    });
    return parts;
  };
  // The bottom edge is the top one mirrored, walked right to left.
  const bottom = top.map((y) => round(BAND_HEIGHT - y));
  const back: string[] = [`L${width},${bottom.at(-1)}`];
  for (let i = bottom.length - 1; i >= 0; i -= 1) {
    const from = i * STAGE + inset;
    back.push(`L${i === 0 ? 0 : from},${bottom[i]}`);
    if (i > 0) {
      const mid = i * STAGE;
      back.push(`C${mid},${bottom[i]} ${mid},${bottom[i - 1]} ${(i - 1) * STAGE + inset + LEVEL},${bottom[i - 1]}`);
    }
  }
  return { path: [`M0,${top[0]}`, ...edge(top), ...back, "Z"].join(" "), thickness, width };
}
