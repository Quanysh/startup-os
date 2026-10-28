import { describe, expect, test } from "vitest";
import { mayTakeWork } from "./teamDirectory";

// The one rule for who a task or a handoff may be given to: on its company
// (any, for a shared task) and holding the board.
describe("mayTakeWork", () => {
  const person = { email: "a@example.test", companies: ["us"] as const, board: true };
  test("on the company and with the board", () => {
    expect(mayTakeWork(person, "us")).toBe(true);
    expect(mayTakeWork(person, undefined)).toBe(true);
    expect(mayTakeWork(person, "kz")).toBe(false);
    expect(mayTakeWork({ ...person, board: false }, "us")).toBe(false);
    expect(mayTakeWork({ ...person, board: false }, undefined)).toBe(false);
  });
});
