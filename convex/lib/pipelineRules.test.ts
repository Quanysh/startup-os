import { describe, expect, test } from "vitest";
import { SOURCES } from "../connectors/manifest";
import { MAX_PIPELINE_AMOUNT } from "./limits";
import {
  NATIVE_SOURCE,
  PIPELINE_OWNERS,
  checkPipelineRows,
  pipelineOwner,
  sourceNamed,
  type PipelineRowInput,
} from "./pipelineRules";
import { PIPELINES } from "./pipelineStages";

const NOW = Date.UTC(2026, 9, 12, 12);

const deal: PipelineRowInput = {
  externalId: "crm-1",
  name: "Almaty Dental",
  contact: "Aigerim S.",
  stage: "Переговоры",
  amount: 250_000,
  currency: "KZT",
  lastActivityAt: "2026-10-09",
};

const check = (rows: PipelineRowInput[], source = "kz_crm") =>
  checkPipelineRows("deals", source, rows, NOW);
const issuesOf = (row: Partial<PipelineRowInput>) => check([{ ...deal, ...row }]).issues;

describe("pipeline owners", () => {
  test("each pipeline has the one source that may push it", () => {
    expect(pipelineOwner("deals", "kz_crm")).toEqual({ market: "kz", currency: "KZT" });
    expect(pipelineOwner("investors", "visible")).toEqual({ market: null, currency: "USD" });
    expect(pipelineOwner("deals", "visible")).toBeNull();
    expect(pipelineOwner("investors", "kz_crm")).toBeNull();
    expect(pipelineOwner("deals", "cfo_workbook")).toBeNull();
  });

  test("manual entry can never push: native rows are written only by the owner's mutations", () => {
    for (const pipeline of PIPELINES) {
      expect(pipelineOwner(pipeline, NATIVE_SOURCE)).toBeNull();
      // Not found through the prototype either.
      expect(pipelineOwner(pipeline, "constructor")).toBeNull();
    }
  });

  test("every owner is an ingest source in the manifest", () => {
    for (const pipeline of PIPELINES) {
      for (const id of Object.keys(PIPELINE_OWNERS[pipeline])) {
        expect(SOURCES.find((s) => s.id === id)?.kind, id).toBe("ingest");
      }
    }
  });

  test("a source is named as it reads in a sentence", () => {
    expect(sourceNamed("kz_crm")).toBe("the Kazakhstan CRM");
    expect(sourceNamed("visible")).toBe("Visible");
    expect(sourceNamed("something_else")).toBe("another system");
  });
});

describe("checkPipelineRows", () => {
  test("a good row comes back ready to store", () => {
    const { issues, rows } = check([deal]);
    expect(issues).toEqual([]);
    expect(rows).toEqual([
      {
        externalId: "crm-1",
        name: "Almaty Dental",
        contact: "Aigerim S.",
        stage: "qualified",
        sourceStage: "Переговоры",
        amount: 250_000,
        lastActivityAt: Date.UTC(2026, 9, 9),
      },
    ]);
  });

  test("text is trimmed, and only the required fields are needed", () => {
    const { issues, rows } = check([{ externalId: " crm-2 ", name: " Astana Smile ", stage: " New " }]);
    expect(issues).toEqual([]);
    expect(rows[0]).toMatchObject({
      externalId: "crm-2",
      name: "Astana Smile",
      stage: "lead",
      sourceStage: "New",
    });
  });

  test("a stage name the OS does not know is kept as unmapped, not refused", () => {
    const { issues, rows } = check([{ ...deal, stage: "Ждём бюджет" }]);
    expect(issues).toEqual([]);
    expect(rows[0]).toMatchObject({ stage: "unmapped", sourceStage: "Ждём бюджет" });
  });

  test("a source that does not own the pipeline is refused outright", () => {
    for (const source of ["visible", "cfo_workbook", "manual"]) {
      expect(check([deal], source), source).toEqual({
        issues: [{ path: "deals", message: "This source does not own deals." }],
        rows: [],
      });
    }
    expect(checkPipelineRows("investors", "kz_crm", [deal], NOW).issues).toEqual([
      { path: "investors", message: "This source does not own investors." },
    ]);
  });

  test("the same record twice in one push is refused, and the row is named by position", () => {
    const { issues } = check([deal, { ...deal, name: "Other" }, { ...deal, externalId: " crm-1 " }]);
    expect(issues).toEqual([
      { path: "deals.1.externalId", message: "Appears more than once in this push." },
      { path: "deals.2.externalId", message: "Appears more than once in this push." },
    ]);
  });

  test("blank text is refused", () => {
    expect(issuesOf({ externalId: "  " })).toEqual([
      { path: "deals.0.externalId", message: "Is blank." },
    ]);
    expect(issuesOf({ name: "  " })).toEqual([{ path: "deals.0.name", message: "Is blank." }]);
    expect(issuesOf({ stage: " " })).toEqual([{ path: "deals.0.stage", message: "Is blank." }]);
    expect(issuesOf({ contact: " " })).toEqual([
      { path: "deals.0.contact", message: "Is blank. Leave it out instead." },
    ]);
  });

  test("an amount must be plausible", () => {
    for (const amount of [-1, Number.NaN, Number.POSITIVE_INFINITY, MAX_PIPELINE_AMOUNT + 1]) {
      expect(issuesOf({ amount }), String(amount)).toEqual([
        { path: "deals.0.amount", message: `Must be between 0 and ${MAX_PIPELINE_AMOUNT}.` },
      ]);
    }
    expect(issuesOf({ amount: 0 })).toEqual([]);
  });

  test("an amount must say its currency, and it must be the source's", () => {
    // Dollars stored as tenge would be wrong by a factor of several hundred.
    expect(issuesOf({ currency: undefined })).toEqual([
      { path: "deals.0.currency", message: "An amount needs its currency." },
    ]);
    expect(issuesOf({ currency: "USD" })).toEqual([
      { path: "deals.0.currency", message: "Amounts from this source are in KZT." },
    ]);
    expect(issuesOf({ amount: undefined })).toEqual([
      { path: "deals.0.currency", message: "A currency without an amount." },
    ]);
    expect(issuesOf({ amount: undefined, currency: undefined })).toEqual([]);
  });

  test("investor amounts are in dollars", () => {
    const investor = { externalId: "v-1", name: "Seedline Capital", stage: "Contacted" };
    const run = (extra: Partial<PipelineRowInput>) =>
      checkPipelineRows("investors", "visible", [{ ...investor, ...extra }], NOW).issues;
    expect(run({ amount: 250_000, currency: "USD" })).toEqual([]);
    expect(run({ amount: 250_000, currency: "KZT" })).toEqual([
      { path: "investors.0.currency", message: "Amounts from this source are in USD." },
    ]);
  });

  test("a date must be a real day and not in the future", () => {
    for (const field of ["lastActivityAt", "closedAt"] as const) {
      const row = { stage: "won", [field]: "2026-02-30" };
      expect(issuesOf(row), field).toEqual([
        { path: `deals.0.${field}`, message: "Is not a date (YYYY-MM-DD)." },
      ]);
      expect(issuesOf({ stage: "won", [field]: "10/09/2026" })[0]?.message).toBe(
        "Is not a date (YYYY-MM-DD).",
      );
      expect(issuesOf({ stage: "won", [field]: "2026-10-14" }), field).toEqual([
        { path: `deals.0.${field}`, message: "Is in the future." },
      ]);
    }
    // Tomorrow by UTC is today for a sender ahead of it.
    expect(issuesOf({ lastActivityAt: "2026-10-13" })).toEqual([]);
  });

  test("only a closed record has a close date", () => {
    expect(issuesOf({ stage: "Переговоры", closedAt: "2026-10-01" })).toEqual([
      { path: "deals.0.closedAt", message: "Only a won or lost deal has a close date." },
    ]);
    expect(issuesOf({ stage: "Closed - won", closedAt: "2026-10-01" })).toEqual([]);
    // An unknown stage may be a closed one; the date is kept.
    expect(issuesOf({ stage: "Ждём бюджет", closedAt: "2026-10-01" })).toEqual([]);
    expect(
      checkPipelineRows(
        "investors",
        "visible",
        [{ externalId: "v", name: "n", stage: "Meeting", closedAt: "2026-10-01" }],
        NOW,
      ).issues[0]?.message,
    ).toBe("Only a committed or passed investor has a close date.");
  });

  test("no message repeats a value from the push", () => {
    // These rows carry names, and the first message is stored in the run log.
    const secret = "Zzyzx Dental";
    const bad: PipelineRowInput[] = [
      { ...deal, externalId: secret, name: secret, contact: secret, amount: -1 },
      { ...deal, externalId: secret, name: secret },
      { ...deal, externalId: "b", name: secret, stage: secret, closedAt: secret },
      { ...deal, externalId: "c", name: secret, currency: "ZZY" },
      { ...deal, externalId: "d", name: secret, contact: " " },
    ];
    const { issues } = check(bad);
    expect(issues).toHaveLength(5);
    expect(JSON.stringify(issues)).not.toMatch(/zzy/i);
  });
});
