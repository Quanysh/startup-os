import { describe, expect, test } from "vitest";
import { targetStatus } from "./targets";

describe("targetStatus", () => {
  test("when higher is better, reaching the target meets it", () => {
    expect(targetStatus(5_000, 5_000, "up")).toBe("met");
    expect(targetStatus(5_200, 5_000, "up")).toBe("met");
  });

  test("when higher is better, falling short misses it", () => {
    expect(targetStatus(4_999, 5_000, "up")).toBe("missed");
  });

  test("when lower is better, staying at or under the target meets it", () => {
    expect(targetStatus(2, 2, "down")).toBe("met");
    expect(targetStatus(1.4, 2, "down")).toBe("met");
  });

  test("when lower is better, exceeding the target misses it", () => {
    expect(targetStatus(2.1, 2, "down")).toBe("missed");
  });
});
