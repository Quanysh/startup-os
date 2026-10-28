// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { BENCHMARKS } from "@/lib/metrics/benchmarks";
import { BenchmarkChip } from "./benchmark-chip";

afterEach(cleanup);

// jsdom has no layout, so what can be pinned here is what lets the label wrap:
// the chip's own classes. How it looks on one line and on two is for a
// browser to show.
describe("BenchmarkChip", () => {
  const chip = () => {
    render(<BenchmarkChip value={30} benchmark={BENCHMARKS.runway_months} />);
    return screen.getByRole("button", { name: "Stronger than typical for seed" });
  };

  test("says the verdict in words, whole", () => {
    expect(chip().textContent).toBe("Stronger than typical for seed");
  });

  test("lets a long verdict wrap in a narrow tile instead of cutting it short", () => {
    const classes = chip().className.split(/\s+/);
    for (const cut of ["truncate", "whitespace-nowrap", "overflow-hidden", "line-clamp-1"]) {
      expect(classes).not.toContain(cut);
    }
    // Never wider than the tile it sits in, and a second line starts at the left.
    expect(classes).toContain("max-w-full");
    expect(classes).toContain("text-left");
  });

  test("has a radius that suits two lines: a full pill would cut into the words", () => {
    const classes = chip().className.split(/\s+/);
    expect(classes).not.toContain("rounded-full");
    expect(classes).toContain("rounded-xl");
  });

  test("its icons keep their size beside a wrapped label", () => {
    const icons = [...chip().querySelectorAll("svg")];
    expect(icons).toHaveLength(2);
    for (const icon of icons) expect(icon.classList.contains("shrink-0")).toBe(true);
  });
});
