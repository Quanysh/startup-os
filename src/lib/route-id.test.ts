import { describe, expect, test } from "vitest";
import { idFromParam } from "./route-id";

describe("idFromParam", () => {
  test("decodes once, and never throws on a broken escape", () => {
    expect(idFromParam(undefined)).toBe("");
    expect(idFromParam("a%20b")).toBe("a b");
    expect(idFromParam("%E0%A4%A")).toBe("%E0%A4%A");
  });
});
