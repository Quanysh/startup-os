import { describe, expect, test } from "vitest";
import { MAX_URL_LENGTH } from "./limits";
import { cleanLink } from "./text";

describe("cleanLink", () => {
  test("an https address is kept, trimmed", () => {
    expect(cleanLink("  https://drive.example.com/file/1 ", "An evidence link")).toBe(
      "https://drive.example.com/file/1",
    );
  });

  test.each(["javascript:alert(1)", "http://example.com", "data:text/html,x", "example.com", ""])(
    "%j is refused: it would be rendered as a link",
    (value) => {
      expect(() => cleanLink(value, "An evidence link")).toThrow(
        "An evidence link must be a full https:// address.",
      );
    },
  );

  test("an address longer than anyone would paste is refused", () => {
    expect(() =>
      cleanLink(`https://example.com/${"x".repeat(MAX_URL_LENGTH)}`, "An evidence link"),
    ).toThrow("An evidence link is too long (2000 characters at most).");
  });
});
