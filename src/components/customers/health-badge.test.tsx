// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HEALTH_LABELS, type HealthLevel } from "@/lib/customers/health";
import { HealthChip } from "./health-badge";

afterEach(cleanup);

const TONES: Record<HealthLevel, string> = {
  good: "success",
  watch: "warning",
  at_risk: "danger",
  unknown: "neutral",
  not_assessed: "neutral",
};

describe("HealthChip", () => {
  it.each(Object.entries(TONES))("%s is a %s chip, with its label and an icon", (level, tone) => {
    render(<HealthChip level={level as HealthLevel} />);
    const chip = screen.getByText(HEALTH_LABELS[level as HealthLevel]);
    expect(chip.dataset.tone).toBe(tone);
    expect(chip.dataset.health).toBe(level);
    expect(chip.querySelector("svg")).not.toBeNull();
  });

  it("gives the three verdicts three icons, so they differ without colour", () => {
    const icons = (["good", "watch", "at_risk"] as const).map((level) => {
      const { container } = render(<HealthChip level={level} />);
      return container.querySelector("svg")!.innerHTML;
    });
    expect(new Set(icons).size).toBe(3);
  });
});
