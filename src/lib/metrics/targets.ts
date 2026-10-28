/**
 * Whether a value meets the owner's target. Binary on purpose: the weekly
 * scorecard asks "on or off", and reaching the target exactly counts as on.
 */
export function targetStatus(
  value: number,
  target: number,
  better: "up" | "down",
): "met" | "missed" {
  const met = better === "up" ? value >= target : value <= target;
  return met ? "met" : "missed";
}
