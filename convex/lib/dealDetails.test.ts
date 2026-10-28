import { describe, expect, test } from "vitest";
import { DEAL_PRIORITIES, dealNameKey, looksLikeContactDetail, normalDealName } from "./dealDetails";

describe("deal priorities", () => {
  test("are high, medium and low, in that order", () => {
    expect(DEAL_PRIORITIES).toEqual(["high", "medium", "low"]);
  });
});

describe("looksLikeContactDetail", () => {
  test.each([
    "jo@example.test",
    "Write to J.Sample+sales@clinic.example.org",
    "(555) 123-4567",
    "555-123-4567",
    "555.123.4567",
    "call 5551234567 after nine",
    "+1 555 123 4567",
    "1-800-555-0199",
    "+7 701 123 45 67",
  ])("%s looks like one", (text) => {
    expect(looksLikeContactDetail(text)).toBe(true);
  });

  test.each([
    "Dr. Casey Placeholder",
    "59 physicians across 29 locations, founded 1998",
    "Uses athenahealth; met on 2026-10-15",
    "Revenue $12,500,000 in 2025",
    "CPT 99213 and 27447 denials",
    "Austin, TX 78701",
    "2019-2024 growth",
    "Ask about @mentions in the team chat",
  ])("%s does not", (text) => {
    expect(looksLikeContactDetail(text)).toBe(false);
  });
});

describe("normalDealName", () => {
  test("is the same whatever the capitals and spacing", () => {
    expect(normalDealName("  Example  Specialty GROUP ")).toBe("example specialty group");
    expect(normalDealName("Example Specialty Group")).toBe(
      normalDealName("example specialty   group"),
    );
  });
});

describe("dealNameKey", () => {
  test("capitals, spaces, punctuation, '&' and a trailing legal form do not tell two names apart", () => {
    expect(dealNameKey("  Example  US Deal, LLC ")).toBe("example us deal");
    expect(dealNameKey("Example & Sons P.C.")).toBe(dealNameKey("example and sons"));
    expect(dealNameKey("ТОО Пример")).toBe("тоо пример");
    expect(dealNameKey("Пример ТОО")).toBe("пример");
    // A name that is only a legal form keeps it.
    expect(dealNameKey("LLC")).toBe("llc");
    expect(dealNameKey("Example Spine")).not.toBe(dealNameKey("Example Spine Center"));
  });
});
