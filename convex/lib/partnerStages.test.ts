import { describe, expect, test } from "vitest";
import { partnerAttention } from "./attention/partners";
import { quietCards } from "./attention/pipelineDerive";
import {
  PARTNER_JUDGED_STAGES,
  PARTNER_QUIET_DAYS,
  PARTNER_QUIET_WORDS,
  PARTNER_STAGES,
  PARTNER_TYPES,
  isPartnerStage,
  isPartnerType,
  needsYouPartners,
  partnerCounts,
  quietPartners,
  type PartnerCard,
} from "./partnerStages";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 18, 12);
const TODAY = "2026-10-18";

const card = (over: Partial<PartnerCard> = {}): PartnerCard => ({
  id: "p1",
  company: "us",
  name: "Made-up Reseller",
  type: "channel",
  stage: "in_talks",
  owner: null,
  contact: null,
  contactRole: null,
  value: null,
  valueKind: null,
  notes: null,
  nextStep: null,
  nextStepOn: null,
  lastActivityAt: NOW - 20 * DAY,
  links: [],
  editedBy: null,
  ...over,
});

describe("the vocabulary", () => {
  test("stages run from identified to lost, in the order a partnership goes", () => {
    expect(PARTNER_STAGES).toEqual([
      "identified",
      "contacted",
      "in_talks",
      "agreement",
      "live",
      "paused",
      "lost",
    ]);
  });
  test("five types", () => {
    expect(PARTNER_TYPES).toEqual(["channel", "integration", "referral", "strategic", "clinical"]);
  });
  test("guards", () => {
    expect(isPartnerStage("live")).toBe(true);
    expect(isPartnerStage("won")).toBe(false);
    expect(isPartnerType("referral")).toBe(true);
    expect(isPartnerType("vendor")).toBe(false);
  });
});

describe("gone quiet", () => {
  test("the limit is fourteen days, as for deals", () => {
    expect(PARTNER_QUIET_DAYS).toBe(14);
  });
  test("only contacted, in talks and agreement are judged", () => {
    const judged = PARTNER_STAGES.filter(
      (stage) => quietPartners([card({ stage })], NOW).quiet.length === 1,
    );
    expect(judged).toEqual(["contacted", "in_talks", "agreement"]);
  });
  test("more than fourteen whole days is quiet, fourteen is not", () => {
    expect(quietPartners([card({ lastActivityAt: NOW - 14 * DAY })], NOW).quiet).toEqual([]);
    expect(quietPartners([card({ lastActivityAt: NOW - 15 * DAY })], NOW).quiet).toEqual([
      { id: "p1", name: "Made-up Reseller", days: 15 },
    ]);
  });
  test("a partner with no activity date is counted as undated, not quiet", () => {
    const result = quietPartners([card({ lastActivityAt: null })], NOW);
    expect(result).toEqual({ of: 1, quiet: [], undated: 1 });
  });
});

describe("needs you", () => {
  test("quiet with a next step dated before today", () => {
    const rows = needsYouPartners([card({ nextStepOn: "2026-10-17" })], NOW, TODAY);
    expect(rows.map((row) => row.id)).toEqual(["p1"]);
  });
  test("a next step due today is not overdue", () => {
    expect(needsYouPartners([card({ nextStepOn: TODAY })], NOW, TODAY)).toEqual([]);
  });
  test("no date means nothing is overdue", () => {
    expect(needsYouPartners([card()], NOW, TODAY)).toEqual([]);
  });
  test("an overdue step on a partner that is not quiet is left alone", () => {
    const fresh = card({ lastActivityAt: NOW - DAY, nextStepOn: "2026-10-01" });
    expect(needsYouPartners([fresh], NOW, TODAY)).toEqual([]);
  });
  test("a live or lost partner is never on the list", () => {
    const rows = [card({ stage: "live", nextStepOn: "2026-10-01" }), card({ stage: "lost", nextStepOn: "2026-10-01" })];
    expect(needsYouPartners(rows, NOW, TODAY)).toEqual([]);
  });
});

describe("counts", () => {
  test("one per stage, every stage present", () => {
    const counts = partnerCounts([card(), card({ id: "p2", stage: "live" }), card({ id: "p3" })]);
    expect(counts).toEqual({
      identified: 0,
      contacted: 0,
      in_talks: 2,
      agreement: 0,
      live: 1,
      paused: 0,
      lost: 0,
    });
  });
});

describe("the Today line", () => {
  test("counts per company and names nobody", () => {
    const items = partnerAttention(
      [
        card({ nextStepOn: "2026-10-01" }),
        card({ id: "p2", nextStepOn: "2026-10-02", name: "Second Co" }),
        card({ id: "p3", company: "kz", nextStepOn: "2026-10-02" }),
        card({ id: "p4", nextStepOn: null }),
      ],
      NOW,
      TODAY,
    );
    expect(items.map((item) => item.id)).toEqual(["quiet-partners:us", "quiet-partners:kz"]);
    expect(items[0]!.title).toBe("2 Startup partners have gone quiet with a next step overdue");
    expect(items[1]!.title).toBe("1 Globex partner has gone quiet with a next step overdue");
    expect(items[0]!.href).toBe("/partnerships");
    expect(JSON.stringify(items)).not.toContain("Made-up");
    expect(JSON.stringify(items)).not.toContain("Second");
  });
  test("nothing overdue adds nothing", () => {
    expect(partnerAttention([card()], NOW, TODAY)).toEqual([]);
  });
});

describe("one quiet rule for every pipeline", () => {
  test("partners go quiet by the pipelines' own rule, and every text states the constant", () => {
    const cards = [
      card({ id: "a", stage: "in_talks", lastActivityAt: NOW - (PARTNER_QUIET_DAYS + 1) * DAY, nextStepOn: "2026-10-01" }),
      card({ id: "b", stage: "contacted", lastActivityAt: NOW - PARTNER_QUIET_DAYS * DAY }),
      card({ id: "c", stage: "live", lastActivityAt: NOW - 90 * DAY }),
      card({ id: "d", stage: "agreement", lastActivityAt: null }),
    ];
    const judged = cards.filter((c) => PARTNER_JUDGED_STAGES.includes(c.stage));
    expect(quietPartners(cards, NOW)).toEqual(quietCards(judged, NOW, PARTNER_QUIET_DAYS));
    expect(quietPartners(cards, NOW).quiet.map((row) => row.id)).toEqual(["a"]);
    expect(PARTNER_QUIET_WORDS).toBe(`no activity for more than ${PARTNER_QUIET_DAYS} days`);
    expect(partnerAttention(cards, NOW, TODAY)[0]!.detail).toBe(
      `No activity for more than ${PARTNER_QUIET_DAYS} days, and a next step that was due earlier.`,
    );
  });
});
