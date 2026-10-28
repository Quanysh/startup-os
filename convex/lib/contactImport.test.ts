import { describe, expect, test } from "vitest";
import { MAX_CONTACT_TITLE } from "./contacts";
import { importCategory, parseContactText } from "./contactImport";

// Every name and role here is made up.

describe("parseContactText", () => {
  test("reads a name and a role in the three usual shapes", () => {
    expect(parseContactText("Jane Example, Partner")).toEqual({ name: "Jane Example", title: "Partner" });
    expect(parseContactText("Jane Example — Partner")).toEqual({ name: "Jane Example", title: "Partner" });
    expect(parseContactText("Jane Example – Partner")).toEqual({ name: "Jane Example", title: "Partner" });
    expect(parseContactText("Jane Example - Partner")).toEqual({ name: "Jane Example", title: "Partner" });
    expect(parseContactText("Jane Example (Partner)")).toEqual({ name: "Jane Example", title: "Partner" });
  });

  test("a name alone has no title, and a hyphen inside a name is not a separator", () => {
    expect(parseContactText("  Jean-Luc   Sample ")).toEqual({ name: "Jean-Luc Sample" });
    expect(parseContactText("Dr. Dana Sample")).toEqual({ name: "Dr. Dana Sample" });
  });

  test("only the first role is kept", () => {
    expect(parseContactText("Jane Example, Partner, Example Capital")).toEqual({
      name: "Jane Example",
      title: "Partner",
    });
    expect(parseContactText("Jane Example (Partner) — Example Capital")).toEqual({
      name: "Jane Example",
      title: "Partner",
    });
  });

  test("a part that looks like an email address or a phone number is never kept", () => {
    expect(parseContactText("Jane Example, jane@example.test")).toEqual({ name: "Jane Example" });
    expect(parseContactText("Jane Example (555-123-4567)")).toEqual({ name: "Jane Example" });
    expect(parseContactText("Jane Example, +7 701 555 0199")).toEqual({ name: "Jane Example" });
    expect(parseContactText("Jane Example <jane@example.test>")).toEqual({ name: "Jane Example" });
  });

  test("text whose first part is an address or a number names nobody", () => {
    expect(parseContactText("jane@example.test, Partner")).toBeNull();
    expect(parseContactText("Jane jane@example.test")).toBeNull();
    expect(parseContactText("555-123-4567")).toBeNull();
  });

  test("empty, punctuation-only and over-long names name nobody", () => {
    expect(parseContactText("")).toBeNull();
    expect(parseContactText("   ")).toBeNull();
    expect(parseContactText(", Partner")).toBeNull();
    expect(parseContactText("—")).toBeNull();
    expect(parseContactText("12345")).toBeNull();
    expect(parseContactText("A".repeat(121))).toBeNull();
  });

  test("a long role is cut to the stored length", () => {
    const parsed = parseContactText(`Jane Example, ${"Head of things ".repeat(10)}`);
    expect(parsed?.name).toBe("Jane Example");
    expect(parsed?.title?.length).toBeLessThanOrEqual(MAX_CONTACT_TITLE);
    expect(parsed?.title?.startsWith("Head of things")).toBe(true);
  });

  test("hidden characters are dropped", () => {
    expect(parseContactText("Jane​ Example,‮ Partner")).toEqual({ name: "Jane Example", title: "Partner" });
  });
});

describe("importCategory", () => {
  test("an investor is an investor; a deal is a customer in the US and a clinic in Kazakhstan", () => {
    expect(importCategory("investor", "us")).toBe("investor");
    expect(importCategory("deal", "us")).toBe("customer");
    expect(importCategory("deal", "kz")).toBe("kz_clinic");
  });
});
