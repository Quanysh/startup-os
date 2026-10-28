import { describe, expect, test } from "vitest";
import {
  CLOSED_STAGES,
  DEAL_STAGES,
  INVESTOR_STAGES,
  isClosedStage,
} from "@convex/lib/pipelineStages";
import {
  ACTIVE_INVESTOR_STAGES,
  DEAL_COLUMNS,
  INVESTOR_COLUMNS,
  OPEN_DEAL_STAGES,
  UNSORTED_COLUMN,
  boardColumns,
  stageTitle,
} from "./stages";

describe("pipeline columns", () => {
  test("the boards show exactly the server's stages, in its order", () => {
    // A column the server does not know would refuse every drop; a stage with
    // no column would hide its cards.
    expect(DEAL_COLUMNS.map((c) => c.id)).toEqual([...DEAL_STAGES]);
    expect(INVESTOR_COLUMNS.map((c) => c.id)).toEqual([...INVESTOR_STAGES]);
  });

  test("a column keeps its own order exactly when the server orders it by close date", () => {
    // Never let the board offer an ordering the server will not store.
    const selfOrdered = (columns: readonly { id: string; sortable?: boolean }[]) =>
      columns.filter((c) => c.sortable === false).map((c) => c.id);
    expect(selfOrdered(DEAL_COLUMNS)).toEqual([...CLOSED_STAGES.deals]);
    expect(selfOrdered(INVESTOR_COLUMNS)).toEqual([...CLOSED_STAGES.investors]);
    expect(UNSORTED_COLUMN.sortable).toBe(false);
  });

  test("open deals and active investors are stages that are not closed", () => {
    expect(OPEN_DEAL_STAGES).toEqual(DEAL_STAGES.filter((s) => !isClosedStage("deals", s)));
    for (const stage of ACTIVE_INVESTOR_STAGES) {
      expect(isClosedStage("investors", stage), stage).toBe(false);
    }
    // Someone never approached has not gone quiet.
    expect(ACTIVE_INVESTOR_STAGES).not.toContain("target");
  });

  test("Unsorted is drawn only while it holds a card", () => {
    const empty = { lead: [], unmapped: [] };
    expect(boardColumns(DEAL_COLUMNS, empty).map((c) => c.id)).toEqual([...DEAL_STAGES]);
    expect(boardColumns(DEAL_COLUMNS, {}).map((c) => c.id)).toEqual([...DEAL_STAGES]);
    const some = { lead: [], unmapped: [{ id: "x" }] };
    expect(boardColumns(DEAL_COLUMNS, some).map((c) => c.id)).toEqual([...DEAL_STAGES, "unmapped"]);
  });

  test("a stage is named by its column's title", () => {
    expect(stageTitle(DEAL_COLUMNS, "proposal")).toBe("Proposal");
    expect(stageTitle(INVESTOR_COLUMNS, "target")).toBe("To contact");
    expect(stageTitle(DEAL_COLUMNS, "unmapped")).toBe("Unsorted");
    expect(stageTitle(DEAL_COLUMNS, "nonsense")).toBe("nonsense");
  });
});
