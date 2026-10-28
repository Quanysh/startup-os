import { describe, expect, test } from "vitest";
import { BAND_HEIGHT, BAND_MIN, flowBand } from "./band";

describe("flowBand: one band through the stages, as thick as each is full", () => {
  test("thickness is proportional to the count, the fullest stage taking the whole height", () => {
    const { thickness } = flowBand([1, 4, 2, 0, 8]);
    expect(thickness[4]).toBe(BAND_HEIGHT);
    expect(thickness[1]).toBe(BAND_HEIGHT / 2);
    expect(thickness[2]).toBe(BAND_HEIGHT / 4);
    expect(thickness[0]).toBe(BAND_HEIGHT / 8);
  });

  test("an empty stage keeps a hairline, so the flow still reads as one line", () => {
    const { thickness } = flowBand([0, 3, 0, 0, 0]);
    expect(thickness).toEqual([BAND_MIN, BAND_HEIGHT, BAND_MIN, BAND_MIN, BAND_MIN]);
  });

  test("nothing anywhere is a hairline throughout, not a full band", () => {
    expect(flowBand([0, 0, 0, 0, 0]).thickness).toEqual(Array(5).fill(BAND_MIN));
  });

  test("a count too small to see is still thicker than nothing", () => {
    const { thickness } = flowBand([1, 400]);
    expect(thickness[0]).toBeGreaterThan(BAND_MIN);
  });

  test("the path is one closed shape across every stage, inside its box", () => {
    const { path, width } = flowBand([2, 5, 1]);
    expect(width).toBe(300);
    expect(path.startsWith("M0,")).toBe(true);
    expect(path.endsWith("Z")).toBe(true);
    const numbers = path.match(/-?\d+(\.\d+)?/g)!.map(Number);
    expect(numbers.every((n) => Number.isFinite(n) && n >= 0 && n <= 300)).toBe(true);
  });

  test("no stages, no band", () => {
    expect(flowBand([])).toEqual({ path: "", thickness: [], width: 0 });
  });
});
