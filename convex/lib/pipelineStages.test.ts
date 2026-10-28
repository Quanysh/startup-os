import { describe, expect, test } from "vitest";
import {
  CLOSED_STAGES,
  DEAL_STAGES,
  INVESTOR_STAGES,
  PIPELINES,
  STAGES,
  UNMAPPED,
  isClosedStage,
  isStage,
  keepsOwnOrder,
  normalizeStage,
  stageAliases,
  stageKey,
} from "./pipelineStages";

describe("stage lists", () => {
  test("deals run from lead to won or lost", () => {
    expect(DEAL_STAGES).toEqual(["lead", "qualified", "demo", "proposal", "won", "lost"]);
  });

  test("investors run from target to committed or passed", () => {
    expect(INVESTOR_STAGES).toEqual([
      "target",
      "contacted",
      "meeting",
      "diligence",
      "committed",
      "passed",
    ]);
  });

  test("every closed stage is a stage of its pipeline, and they come last", () => {
    for (const pipeline of PIPELINES) {
      expect(STAGES[pipeline].slice(-2)).toEqual(CLOSED_STAGES[pipeline]);
    }
  });

  test("unmapped is not a stage of either pipeline", () => {
    // A card can never be moved there by hand: the move validator uses isStage.
    for (const pipeline of PIPELINES) expect(isStage(pipeline, UNMAPPED)).toBe(false);
  });

  test("isStage and isClosedStage answer per pipeline", () => {
    expect(isStage("deals", "demo")).toBe(true);
    expect(isStage("investors", "demo")).toBe(false);
    expect(isClosedStage("deals", "won")).toBe(true);
    expect(isClosedStage("deals", "proposal")).toBe(false);
    expect(isClosedStage("investors", "passed")).toBe(true);
  });

  test("closed stages and unmapped keep their own order", () => {
    expect(keepsOwnOrder("deals", "lost")).toBe(true);
    expect(keepsOwnOrder("deals", UNMAPPED)).toBe(true);
    expect(keepsOwnOrder("deals", "lead")).toBe(false);
  });
});

describe("stageKey", () => {
  test("case, punctuation and spacing do not matter", () => {
    expect(stageKey("Closed - Won")).toBe("closed won");
    expect(stageKey("  CLOSED_WON ")).toBe("closed won");
    expect(stageKey("closed won")).toBe("closed won");
  });

  test("Russian is compared in lower case, with ё as е", () => {
    expect(stageKey("Счёт на предоплату")).toBe("счет на предоплату");
    expect(stageKey("ПЕРЕГОВОРЫ")).toBe("переговоры");
  });

  test("a name of only punctuation is empty", () => {
    expect(stageKey(" -- ")).toBe("");
  });
});

describe("normalizeStage", () => {
  test("a stage's own id maps to itself, however it is written", () => {
    for (const pipeline of PIPELINES) {
      for (const stage of STAGES[pipeline]) {
        expect(normalizeStage(pipeline, stage)).toBe(stage);
        expect(normalizeStage(pipeline, ` ${stage.toUpperCase()} `)).toBe(stage);
      }
    }
  });

  test("a CRM's own names map onto the deal stages", () => {
    expect(normalizeStage("deals", "Первичный контакт")).toBe("lead");
    expect(normalizeStage("deals", "Переговоры")).toBe("qualified");
    expect(normalizeStage("deals", "Презентация")).toBe("demo");
    expect(normalizeStage("deals", "Согласование договора")).toBe("proposal");
    expect(normalizeStage("deals", "Closed - won")).toBe("won");
    expect(normalizeStage("deals", "Закрыто и не реализовано")).toBe("lost");
  });

  test("a fundraising tool's names map onto the investor stages", () => {
    expect(normalizeStage("investors", "Researching")).toBe("target");
    expect(normalizeStage("investors", "Reached out")).toBe("contacted");
    expect(normalizeStage("investors", "Pitched")).toBe("meeting");
    expect(normalizeStage("investors", "Due Diligence")).toBe("diligence");
    expect(normalizeStage("investors", "Invested")).toBe("committed");
    expect(normalizeStage("investors", "Declined")).toBe("passed");
  });

  test("a name it does not know is unmapped, never a guess", () => {
    expect(normalizeStage("deals", "Ждём бюджет")).toBe(UNMAPPED);
    expect(normalizeStage("deals", "")).toBe(UNMAPPED);
    expect(normalizeStage("investors", "Warm")).toBe(UNMAPPED);
  });

  test("the two pipelines do not share names", () => {
    // "meeting" is an investor stage, not a deal stage.
    expect(normalizeStage("deals", "meeting")).toBe(UNMAPPED);
    expect(normalizeStage("investors", "demo")).toBe(UNMAPPED);
  });

  test("every alias is written the way it is looked up, and points at a real stage", () => {
    // An alias with a capital letter or a dash could never be found.
    for (const [pipeline, name, stage] of stageAliases()) {
      expect(stageKey(name), `${pipeline}: ${name}`).toBe(name);
      expect(isStage(pipeline, stage), `${pipeline}: ${name} → ${stage}`).toBe(true);
      expect(isStage(pipeline, name), `${pipeline}: ${name} shadows a stage id`).toBe(false);
    }
  });
});
