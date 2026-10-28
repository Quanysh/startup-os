import { describe, expect, test } from "vitest";
import {
  MAX_DEAL_SOURCE_LENGTH,
  MAX_DEAL_SOURCES,
  MAX_PRACTICE_COUNT,
  MAX_REGION_LENGTH,
} from "./limits";
import { cleanDealDetails } from "./pipelineFields";

describe("cleanDealDetails", () => {
  test("leaves out what was not given, and clears what was given as null", () => {
    expect(cleanDealDetails({})).toEqual({});
    expect(
      cleanDealDetails({
        priority: null,
        region: null,
        physicians: null,
        locations: null,
        sources: null,
      }),
    ).toEqual({
      priority: undefined,
      region: undefined,
      physicians: undefined,
      locations: undefined,
      sources: undefined,
    });
  });

  test("trims the region and the sources, and drops blank and repeated sources", () => {
    expect(
      cleanDealDetails({
        priority: "high",
        region: "  TX ",
        physicians: 59,
        locations: 29,
        sources: [" Made-up market scan ", "", "Made-up market scan", "Sample list"],
      }),
    ).toEqual({
      priority: "high",
      region: "TX",
      physicians: 59,
      locations: 29,
      sources: ["Made-up market scan", "Sample list"],
    });
    expect(cleanDealDetails({ region: "   ", sources: ["  "] })).toEqual({
      region: undefined,
      sources: undefined,
    });
  });

  test("refuses what is not a priority", () => {
    expect(() => cleanDealDetails({ priority: "urgent" as never })).toThrow(
      "A priority is high, medium or low.",
    );
  });

  test("holds the region to its cap", () => {
    expect(() => cleanDealDetails({ region: "x".repeat(MAX_REGION_LENGTH + 1) })).toThrow(
      `That region is too long (${MAX_REGION_LENGTH} characters at most).`,
    );
  });

  test.each([-1, 1.5, Number.NaN, MAX_PRACTICE_COUNT + 1])(
    "refuses %s physicians or locations",
    (count) => {
      expect(() => cleanDealDetails({ physicians: count })).toThrow(
        "The number of physicians must be a whole number the OS can store.",
      );
      expect(() => cleanDealDetails({ locations: count })).toThrow(
        "The number of locations must be a whole number the OS can store.",
      );
    },
  );

  test("holds the sources to their count and their length", () => {
    const many = Array.from({ length: MAX_DEAL_SOURCES + 1 }, (_, i) => `Source ${i}`);
    expect(() => cleanDealDetails({ sources: many })).toThrow(
      `A deal names ${MAX_DEAL_SOURCES} sources at most.`,
    );
    expect(() => cleanDealDetails({ sources: ["x".repeat(MAX_DEAL_SOURCE_LENGTH + 1)] })).toThrow(
      `A source's title is too long (${MAX_DEAL_SOURCE_LENGTH} characters at most).`,
    );
  });

  test("refuses an address or a phone number in the region or a source", () => {
    expect(() => cleanDealDetails({ region: "555-123-4567" })).toThrow(
      "Leave email addresses and phone numbers out: the only person a deal names is its contact, by name.",
    );
    expect(() => cleanDealDetails({ sources: ["jo@example.test"] })).toThrow(
      "Leave email addresses and phone numbers out: the only person a deal names is its contact, by name.",
    );
  });
});
