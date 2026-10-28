import { describe, expect, test } from "vitest";
import { BUILTIN_FOCUS, FOCUSES, FOCUS_LABELS, focusOf, isFocus } from "./focus";
import { MEMBER_ROLES } from "./roles";

describe("a role's focus", () => {
  test("the fixed set, each with a name", () => {
    expect(FOCUSES).toEqual([
      "founder",
      "sales",
      "engineering",
      "marketing",
      "customers",
      "finance",
      "general",
    ]);
    for (const focus of FOCUSES) expect(FOCUS_LABELS[focus]).toMatch(/\S/);
    expect(isFocus("sales")).toBe(true);
    expect(isFocus("owner")).toBe(false);
    expect(isFocus(undefined)).toBe(false);
  });

  test("the owner is always arranged as a founder, whatever else is passed", () => {
    expect(focusOf("owner")).toBe("founder");
    expect(focusOf("owner", { focus: "sales" })).toBe("founder");
  });

  test("the three built-in roles", () => {
    expect(BUILTIN_FOCUS).toEqual({ cofounder: "founder", sales: "sales", engineer: "engineering" });
    for (const role of MEMBER_ROLES) expect(focusOf(role)).toBe(BUILTIN_FOCUS[role]);
    // A built-in's focus is fixed: a row passed beside it is not read.
    expect(focusOf("sales", { focus: "finance" })).toBe("sales");
  });

  test("a role the owner named has the focus the owner gave it", () => {
    for (const focus of FOCUSES) expect(focusOf("custom", { focus })).toBe(focus);
  });

  test("a role that was deleted, or holds a focus this build does not know, is general", () => {
    expect(focusOf("custom", null)).toBe("general");
    expect(focusOf("custom")).toBe("general");
    expect(focusOf("custom", { focus: "astronaut" })).toBe("general");
  });
});
