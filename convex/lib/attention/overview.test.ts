import { describe, expect, test } from "vitest";
import { ATTENTION_RULES, overviewItems, ruleItems, type OverviewInput } from "./overview";
import { attentionItems, sortAttention } from "./scorecard";

// Today's "Needs you" (src/components/home/use-needs.ts) and the owner's
// agent (`overview`) compose the same list: the figures, then one list of
// rule functions, `ATTENTION_RULES`, both call.

const NOW = Date.UTC(2026, 9, 20, 12);
const DAY = 24 * 60 * 60 * 1000;
const empty: OverviewInput = {
  tiles: [],
  sources: {},
  usDeals: {},
  kzDeals: {},
  investors: {},
  customers: [],
  lastPushAt: null,
  obligations: [],
  pulls: null,
};

describe("one list of rules", () => {
  test("the overview is the figures and the rules, in that order of sorting", () => {
    const input: OverviewInput = {
      ...empty,
      usDeals: {
        demo: [
          { id: "d1", name: "Made-up clinic", stage: "demo", amount: 100, lastActivityAt: NOW - 40 * DAY, closedAt: null, nextStep: null },
        ],
      },
    };
    expect(overviewItems(input, NOW, "2026-10-20")).toEqual(
      sortAttention([...attentionItems(input.tiles, input.sources, NOW), ...ruleItems(input, NOW, "2026-10-20")]),
    );
    expect(ruleItems(input, NOW, "2026-10-20").length).toBeGreaterThan(0);
  });

  test("each producer is named once in the list both callers use", () => {
    expect(ATTENTION_RULES.map((rule) => rule.name)).toEqual([
      "engineering",
      "pipeline",
      "partners",
      "customers",
      "compliance",
      "handoffs",
      "agreements",
    ]);
  });
});
