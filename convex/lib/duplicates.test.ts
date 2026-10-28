import { describe, expect, test } from "vitest";
import {
  DEFAULT_CANDIDATE_TYPES,
  DEFAULT_DUP_THRESHOLD,
  DUPLICATE_CANDIDATE_TYPES,
  LINK_BONUS,
  linksOfProposal,
  proposalTitle,
  scoreDuplicate,
  titleSimilarity,
} from "./duplicates";

// Near-duplicates (Bot Loop v3, B): titles compared word by word, each word
// by its trigrams, plus a bonus for a shared deal, task, goal or customer.
// Made-up titles throughout.

describe("titleSimilarity", () => {
  test("the spec's own example clears the default threshold", () => {
    expect(titleSimilarity("Cap transfers to Globex", "Written cap on Startup→Globex transfers")).toBeGreaterThanOrEqual(
      DEFAULT_DUP_THRESHOLD,
    );
  });

  test("the same card in other words is a duplicate", () => {
    expect(titleSimilarity("Follow up with Made-up Clinic on pilot", "Follow up with Made-up Clinic about the pilot")).toBeGreaterThanOrEqual(
      DEFAULT_DUP_THRESHOLD,
    );
    expect(titleSimilarity("Prepare board deck for November", "Prepare board deck November")).toBe(1);
  });

  test("near titles about different things stay under it", () => {
    const apart: [string, string][] = [
      ["Call Dr. Made about renewal", "Call Dr. Upname about renewal"],
      ["Send investor update for September", "Draft October investor update"],
      ["Book demo with Aspen Made Dental", "Book demo with Pacific Made Dental"],
      ["Update Q4 runway model", "Update Q4 hiring plan"],
      ["Write LinkedIn post on denials", "Write LinkedIn post on prior auth"],
      ["Add HIPAA training evidence", "Upload SOC 2 evidence"],
      ["Hire a senior backend engineer", "Post LinkedIn job for backend engineer"],
      ["Review Fin resolution rate", "Review Intercom Fin answers"],
      ["Follow up with Made Dental", "Send proposal to Made Dental"],
      ["Renew Delaware franchise tax", "Pay Delaware franchise tax"],
    ];
    for (const [a, b] of apart) expect(titleSimilarity(a, b), `${a} / ${b}`).toBeLessThan(DEFAULT_DUP_THRESHOLD);
  });

  test("empty or stop-word-only titles score nothing", () => {
    expect(titleSimilarity("", "Anything")).toBe(0);
    expect(titleSimilarity("to the of", "to the of")).toBe(0);
  });
});

describe("scoreDuplicate", () => {
  test("a shared link adds the bonus, capped at 1", () => {
    const base = titleSimilarity("Call Made Dental about the pilot", "Chase Made Dental pilot contract");
    const linked = scoreDuplicate(
      { title: "Call Made Dental about the pilot", links: [{ kind: "deal", id: "d1" }] },
      { title: "Chase Made Dental pilot contract", links: [{ kind: "deal", id: "d1" }] },
    );
    expect(linked).toBeCloseTo(Math.min(1, base + LINK_BONUS), 5);
    expect(scoreDuplicate({ title: "Same", links: [{ kind: "task", id: "t" }] }, { title: "Same", links: [{ kind: "task", id: "t" }] })).toBe(1);
    // Different kinds with the same id are not the same thing.
    expect(
      scoreDuplicate({ title: "", links: [{ kind: "task", id: "x" }] }, { title: "", links: [{ kind: "deal", id: "x" }] }),
    ).toBe(0);
  });
});

describe("linksOfProposal", () => {
  test("a proposal's payload, goal and source become links", () => {
    expect(
      linksOfProposal({
        payload: { dealId: "d1", nextStep: "x" },
        goalId: "g1",
        source: { kind: "task", id: "t1" },
      }),
    ).toEqual([
      { kind: "deal", id: "d1" },
      { kind: "goal", id: "g1" },
      { kind: "task", id: "t1" },
    ]);
  });
});

describe("proposalTitle", () => {
  test("a title, else a new deal's name, else a deal's next step", () => {
    expect(proposalTitle({ title: "Made-up task", name: "x" })).toBe("Made-up task");
    expect(proposalTitle({ name: "Made-up Clinic" })).toBe("Made-up Clinic");
    expect(proposalTitle({ nextStep: "Call on Monday." })).toBe("Call on Monday.");
    expect(proposalTitle({})).toBe("");
  });
});

test("deals are candidates only for a proposed new deal", () => {
  expect(DUPLICATE_CANDIDATE_TYPES).toContain("deal");
  expect(DEFAULT_CANDIDATE_TYPES).not.toContain("deal");
});
