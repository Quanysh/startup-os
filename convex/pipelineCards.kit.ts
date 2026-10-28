// One suite of card tests, run against both pipeline tables (deals.test.ts
// and investors.test.ts), so the rules that protect a mirrored row are
// proved at the mutation level for each. The two-dot filename keeps Convex
// from bundling this file.

import { convexTest } from "convex-test";
import type { FunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { moveOnBoard } from "../src/lib/board";
import { MAX_NAME_LENGTH, MAX_NEXT_STEP_LENGTH } from "./lib/limits";
import schema from "./schema";
import { OWNER, modules, signInAsOwner, type TestBackend } from "./test.setup";

type Args = Record<string, unknown>;
type Ref<Kind extends "query" | "mutation"> = FunctionReference<Kind, "public", Args, unknown>;

export type Card = {
  id: string;
  mirrored: boolean;
  source: string;
  name: string;
  contact: string | null;
  stage: string;
  sourceStage: string | null;
  amount: number | null;
  lastActivityAt: number | null;
  closedAt: number | null;
  nextStep: string | null;
  notes: string | null;
  /** Investors' cards only (`cardAbilities`); a deal's card is as it was. */
  editable?: boolean;
  editableFields?: string[];
  draggable?: boolean;
};
type BoardOf = Record<string, Card[]>;

export type CardKit = {
  table: "deals" | "investors";
  noun: string;
  /** What a blank name is answered with. */
  blankName: string;
  /** Three open stages in board order, a closed one, and one of the other pipeline's. */
  stages: { first: string; second: string; third: string; closed: string; foreign: string };
  /**
   * The source a mirrored row of this table comes from, and how it is named.
   * `writesBack`: its name, amount and stage are edited here and written back
   * to the source (`WRITE_BACK_SOURCES` in convex/lib/pipelineCards.ts); its
   * contact stays the source's.
   */
  mirror: { source: string; named: string; writesBack?: boolean };
  refs: {
    board: Ref<"query">;
    create: Ref<"mutation">;
    move: Ref<"mutation">;
    update: Ref<"mutation">;
    remove: Ref<"mutation">;
  };
  /** Arguments that pick the board native cards are created on. */
  boardArgs: Args;
  /** Insert a mirrored row on that same board, as a push would have left it. */
  seedMirrored: (t: TestBackend, fields?: Args) => Promise<string>;
};

export function describeCards(kit: CardKit) {
  const { refs, stages } = kit;
  type Owner = Awaited<ReturnType<typeof signInAsOwner>>;

  const start = async () => {
    const t = convexTest(schema, modules);
    return { t, owner: await signInAsOwner(t) };
  };
  const add = (owner: Owner, name: string, extra: Args = {}) =>
    owner.mutation(refs.create, { ...kit.boardArgs, name, ...extra }) as Promise<string>;
  const board = (owner: Owner) => owner.query(refs.board, kit.boardArgs) as Promise<BoardOf>;
  const names = async (owner: Owner, stage: string) =>
    (await board(owner))[stage]!.map((card) => card.name);
  const card = async (owner: Owner, id: string) =>
    Object.values(await board(owner))
      .flat()
      .find((c) => c.id === id);
  const stored = (t: TestBackend, id: string) =>
    t.run((ctx) => ctx.db.get(id as never)) as Promise<Record<string, unknown> | null>;

  const mirroredMessage = `This ${kit.noun} is mirrored from ${kit.mirror.named}. Change it there: here you can edit only its next step and notes.`;
  const contactMessage = `This ${kit.noun}'s contact comes from ${kit.mirror.named}. Change it there: here you can edit its name, amount, stage, next step and notes.`;
  const writesBack = kit.mirror.writesBack === true;
  const gone = `That ${kit.noun} is no longer on the board.`;
  const article = /^[aeiou]/.test(kit.noun) ? "an" : "a";
  const notAStage = `That is not a stage ${article} ${kit.noun} can be moved to.`;

  beforeEach(() => {
    vi.stubEnv("OWNER_EMAILS", OWNER);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  describe(`${kit.table}: cards made here`, () => {
    test("a new card goes to the bottom of the first stage", async () => {
      const { owner } = await start();
      await add(owner, "First");
      await add(owner, "Second");
      expect(await names(owner, stages.first)).toEqual(["First", "Second"]);
    });

    test("a card made here is native, and its key is its own id", async () => {
      const { t, owner } = await start();
      const id = await add(owner, "Native");
      expect(await card(owner, id)).toMatchObject({ mirrored: false, source: "manual" });
      expect(await stored(t, id)).toMatchObject({ source: "manual", externalId: id });
    });

    test("the name is trimmed and may not be blank or endless", async () => {
      const { owner } = await start();
      await add(owner, "  Tidy  ");
      expect(await names(owner, stages.first)).toEqual(["Tidy"]);
      await expect(add(owner, "   ")).rejects.toThrow(kit.blankName);
      await expect(add(owner, "x".repeat(MAX_NAME_LENGTH + 1))).rejects.toThrow(
        `That name is too long (${MAX_NAME_LENGTH} characters at most).`,
      );
    });

    test("a card can be made straight into another stage", async () => {
      const { owner } = await start();
      await add(owner, "Further along", { stage: stages.second });
      expect(await names(owner, stages.second)).toEqual(["Further along"]);
    });

    test("a card made straight into a closed stage is stamped as closed", async () => {
      const { owner } = await start();
      const id = await add(owner, "Already closed", { stage: stages.closed });
      expect((await card(owner, id))?.closedAt).toBeTypeOf("number");
    });

    test("a card cannot be made in a stage that is not this board's", async () => {
      const { owner } = await start();
      for (const stage of ["unmapped", stages.foreign, ""]) {
        await expect(add(owner, "x", { stage }), stage).rejects.toThrow(notAStage);
      }
    });

    test("an amount must be a number that could be real", async () => {
      const { owner } = await start();
      for (const amount of [-1, Number.NaN, 1e12]) {
        await expect(add(owner, "x", { amount }), String(amount)).rejects.toThrow(
          "That amount is not a number the OS can store.",
        );
      }
      const id = await add(owner, "y", { amount: 450 });
      expect((await card(owner, id))?.amount).toBe(450);
    });

    test("move reorders within a stage", async () => {
      const { owner } = await start();
      await add(owner, "A");
      await add(owner, "B");
      const c = await add(owner, "C");
      await owner.mutation(refs.move, { id: c, stage: stages.first, index: 0 });
      expect(await names(owner, stages.first)).toEqual(["C", "A", "B"]);
    });

    test("move to a position in another stage closes the gap behind it", async () => {
      const { owner } = await start();
      const a = await add(owner, "A");
      await add(owner, "B");
      await add(owner, "X", { stage: stages.second });
      await add(owner, "Y", { stage: stages.second });
      await owner.mutation(refs.move, { id: a, stage: stages.second, index: 1 });
      expect(await names(owner, stages.first)).toEqual(["B"]);
      expect(await names(owner, stages.second)).toEqual(["X", "A", "Y"]);
    });

    test("closing a card stamps the date, and reopening it clears the stamp", async () => {
      const { owner } = await start();
      const a = await add(owner, "A");
      await owner.mutation(refs.move, { id: a, stage: stages.closed, index: 0 });
      expect((await card(owner, a))?.closedAt).toBeTypeOf("number");
      await owner.mutation(refs.move, { id: a, stage: stages.first, index: 0 });
      expect((await card(owner, a))?.closedAt).toBeNull();
    });

    test("a closed stage lists the most recently closed first, and moving within it changes nothing", async () => {
      vi.useFakeTimers();
      const { owner } = await start();
      const a = await add(owner, "Closed first");
      const b = await add(owner, "Closed second");
      vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
      await owner.mutation(refs.move, { id: a, stage: stages.closed, index: 0 });
      vi.setSystemTime(new Date("2026-10-12T11:00:00Z"));
      await owner.mutation(refs.move, { id: b, stage: stages.closed, index: 0 });
      const stamp = (await card(owner, a))?.closedAt;

      vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
      await owner.mutation(refs.move, { id: a, stage: stages.closed, index: 0 });

      expect(await names(owner, stages.closed)).toEqual(["Closed second", "Closed first"]);
      expect((await card(owner, a))?.closedAt).toBe(stamp);
    });

    test("a card cannot be moved to a stage that is not this board's", async () => {
      // "unmapped" is where a mirrored card with an unknown stage waits. No
      // card is ever put there by hand.
      const { owner } = await start();
      const a = await add(owner, "A");
      for (const stage of ["unmapped", stages.foreign]) {
        await expect(
          owner.mutation(refs.move, { id: a, stage, index: 0 }),
          stage,
        ).rejects.toThrow(notAStage);
      }
      expect(await names(owner, stages.first)).toEqual(["A"]);
    });

    test("a change of stage counts as activity; a reorder does not", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-01T09:00:00Z"));
      const { owner } = await start();
      const a = await add(owner, "A");
      await add(owner, "B");
      const made = Date.parse("2026-10-01T09:00:00Z");
      expect((await card(owner, a))?.lastActivityAt).toBe(made);

      vi.setSystemTime(new Date("2026-10-05T09:00:00Z"));
      await owner.mutation(refs.move, { id: a, stage: stages.first, index: 1 });
      expect((await card(owner, a))?.lastActivityAt).toBe(made);

      await owner.mutation(refs.move, { id: a, stage: stages.second, index: 0 });
      expect((await card(owner, a))?.lastActivityAt).toBe(Date.parse("2026-10-05T09:00:00Z"));
    });

    test("what the board shows at once matches what the server stores", async () => {
      // The page moves the card on screen before the server answers
      // (moveOnBoard). If the two ever disagree the card visibly jumps.
      const moves: [string, string, number][] = [
        ["A", stages.second, 1],
        ["B", stages.first, 5],
        ["X", stages.closed, 0],
        ["C", stages.second, 0],
        ["Y", stages.third, 0],
        ["X", stages.first, 1],
        ["A", stages.closed, 3],
      ];
      const { owner } = await start();
      for (const name of ["A", "B", "C"]) await add(owner, name);
      for (const name of ["X", "Y"]) await add(owner, name, { stage: stages.second });

      for (const [name, stage, index] of moves) {
        const before = await board(owner);
        const moving = Object.values(before)
          .flat()
          .find((c) => c.name === name)!;
        const predicted = moveOnBoard(before, moving.id, stage, stage === stages.closed ? 0 : index);
        await owner.mutation(refs.move, { id: moving.id, stage, index });
        const ids = (b: BoardOf) =>
          Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.map((c) => c.id)]));
        expect(ids(await board(owner)), `${name} → ${stage}[${index}]`).toEqual(ids(predicted));
      }
    });

    test("update edits the fields given and leaves the rest", async () => {
      const { owner } = await start();
      const id = await add(owner, "Draft", { contact: "Dana Lee", amount: 300 });
      await owner.mutation(refs.update, { id, name: "Final", nextStep: "Send pricing" });
      expect(await card(owner, id)).toMatchObject({
        name: "Final",
        contact: "Dana Lee",
        amount: 300,
        nextStep: "Send pricing",
      });
    });

    test("null clears an optional field", async () => {
      const { owner } = await start();
      const id = await add(owner, "x", { contact: "Dana Lee", amount: 300, nextStep: "Call", notes: "n" });
      await owner.mutation(refs.update, { id, contact: null, amount: null, nextStep: null, notes: null });
      expect(await card(owner, id)).toMatchObject({
        contact: null,
        amount: null,
        nextStep: null,
        notes: null,
      });
    });

    test("the editor can change the stage in the same save, and the card goes to the top", async () => {
      const { owner } = await start();
      await add(owner, "Existing", { stage: stages.second });
      const id = await add(owner, "Draft");
      await owner.mutation(refs.update, { id, name: "Final", stage: stages.second });
      expect(await names(owner, stages.first)).toEqual([]);
      expect(await names(owner, stages.second)).toEqual(["Final", "Existing"]);
    });

    test("a save with a stage that is not this board's saves nothing at all", async () => {
      const { owner } = await start();
      const id = await add(owner, "Kept");
      await expect(
        owner.mutation(refs.update, { id, name: "Changed", stage: "unmapped" }),
      ).rejects.toThrow(notAStage);
      expect((await card(owner, id))?.name).toBe("Kept");
    });

    test("a changed next step or note counts as activity; saving the same words does not", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-01T09:00:00Z"));
      const { owner } = await start();
      const id = await add(owner, "A", { nextStep: "Call back" });
      const made = Date.parse("2026-10-01T09:00:00Z");

      vi.setSystemTime(new Date("2026-10-03T09:00:00Z"));
      await owner.mutation(refs.update, { id, name: "A renamed", nextStep: " Call back " });
      expect((await card(owner, id))?.lastActivityAt).toBe(made);

      await owner.mutation(refs.update, { id, nextStep: "Send the contract" });
      expect((await card(owner, id))?.lastActivityAt).toBe(Date.parse("2026-10-03T09:00:00Z"));

      vi.setSystemTime(new Date("2026-10-04T09:00:00Z"));
      await owner.mutation(refs.update, { id, notes: "Spoke to the owner" });
      expect((await card(owner, id))?.lastActivityAt).toBe(Date.parse("2026-10-04T09:00:00Z"));
    });

    test("a next step far longer than anyone would type is refused", async () => {
      const { owner } = await start();
      const id = await add(owner, "x");
      await expect(
        owner.mutation(refs.update, { id, nextStep: "x".repeat(MAX_NEXT_STEP_LENGTH + 1) }),
      ).rejects.toThrow(`That next step is too long (${MAX_NEXT_STEP_LENGTH} characters at most).`);
    });

    test("remove deletes the card, and removing it twice is not an error", async () => {
      const { owner } = await start();
      const id = await add(owner, "x");
      await owner.mutation(refs.remove, { id });
      expect(await names(owner, stages.first)).toEqual([]);
      expect(await owner.mutation(refs.remove, { id })).toBeNull();
    });

    test("moving or editing a card that was deleted meanwhile says so", async () => {
      const { owner } = await start();
      const id = await add(owner, "x");
      await owner.mutation(refs.remove, { id });
      await expect(
        owner.mutation(refs.move, { id, stage: stages.second, index: 0 }),
      ).rejects.toThrow(gone);
      await expect(owner.mutation(refs.update, { id, name: "y" })).rejects.toThrow(gone);
    });
  });

  describe(`${kit.table}: mirrored cards`, () => {
    test("the board says which cards are mirrored", async () => {
      const { t, owner } = await start();
      const id = await kit.seedMirrored(t);
      expect(await card(owner, id)).toMatchObject({ mirrored: true, source: kit.mirror.source });
    });

    test(kit.table === "investors" ? "the board tells the page what it may do with each card" : "a deal's card carries nothing of what the page may do", async () => {
      const { t, owner } = await start();
      const mirrored = await kit.seedMirrored(t);
      const native = await add(owner, "Native");
      if (kit.table === "deals") {
        for (const id of [mirrored, native]) {
          expect(Object.keys((await card(owner, id))!)).not.toContain("editable");
        }
        return;
      }
      expect(await card(owner, native)).toMatchObject({
        editable: true,
        draggable: true,
        editableFields: ["name", "contact", "amount", "stage", "nextStep", "notes"],
      });
      expect(await card(owner, mirrored)).toMatchObject(
        writesBack
          ? { editable: true, draggable: true, editableFields: ["name", "amount", "stage", "nextStep", "notes"] }
          : { editable: false, draggable: false, editableFields: ["nextStep", "notes"] },
      );
    });

    if (writesBack) {
      test("a written-back card moves and takes its name, amount and stage", async () => {
        const { t, owner } = await start();
        const id = await kit.seedMirrored(t, { name: "Mirrored Co", stage: stages.first, order: 0, amount: 5 });
        await owner.mutation(refs.move, { id, stage: stages.second, index: 0 });
        await owner.mutation(refs.update, { id, name: "Renamed Co", amount: null });
        expect(await card(owner, id)).toMatchObject({
          name: "Renamed Co",
          amount: null,
          stage: stages.second,
          source: kit.mirror.source,
          mirrored: true,
        });
      });

      test("a written-back card's contact stays the source's, even to the value it has", async () => {
        const { t, owner } = await start();
        const id = await kit.seedMirrored(t, { contact: "Sam Ito" });
        const before = await stored(t, id);
        for (const attempt of [{ contact: "Someone Else" }, { contact: null }, { contact: "Sam Ito" }, { name: "Renamed", contact: "x" }]) {
          await expect(owner.mutation(refs.update, { id, ...attempt }), JSON.stringify(attempt)).rejects.toThrow(
            contactMessage,
          );
        }
        expect(await stored(t, id)).toEqual(before);
      });
    } else {
      test("a mirrored card cannot be moved, to another stage or within its own", async () => {
        const { t, owner } = await start();
        const id = await kit.seedMirrored(t, { stage: stages.first, order: 0 });
        const before = await stored(t, id);
        for (const [stage, index] of [
          [stages.second, 0],
          [stages.first, 3],
          [stages.closed, 0],
        ] as const) {
          await expect(
            owner.mutation(refs.move, { id, stage, index }),
            stage,
          ).rejects.toThrow(mirroredMessage);
        }
        expect(await stored(t, id)).toEqual(before);
      });

      test("no source-owned field of a mirrored card can be edited, even to the value it has", async () => {
        const { t, owner } = await start();
        const id = await kit.seedMirrored(t, {
          name: "Mirrored Co",
          contact: "Sam Ito",
          amount: 900,
          stage: stages.first,
        });
        const before = await stored(t, id);
        const attempts: Args[] = [
          { name: "Renamed" },
          { name: "Mirrored Co" },
          { contact: "Someone Else" },
          { contact: null },
          { amount: 1 },
          { amount: null },
          { stage: stages.second },
          { stage: stages.first },
          // A permitted field does not carry a forbidden one through.
          { notes: "fine on its own", name: "Renamed" },
        ];
        for (const attempt of attempts) {
          await expect(
            owner.mutation(refs.update, { id, ...attempt }),
            JSON.stringify(attempt),
          ).rejects.toThrow(mirroredMessage);
        }
        expect(await stored(t, id)).toEqual(before);
      });
    }

    test("the next step and the notes of a mirrored card are the owner's to edit", async () => {
      const { t, owner } = await start();
      const id = await kit.seedMirrored(t, { lastActivityAt: 1_000 });
      await owner.mutation(refs.update, { id, nextStep: "Ask for an intro", notes: "Met in Almaty" });
      expect(await card(owner, id)).toMatchObject({
        nextStep: "Ask for an intro",
        notes: "Met in Almaty",
        // When the source last saw activity is the source's to say.
        lastActivityAt: 1_000,
      });
    });

    test("a mirrored card cannot be deleted here", async () => {
      const { t, owner } = await start();
      const id = await kit.seedMirrored(t);
      await expect(owner.mutation(refs.remove, { id })).rejects.toThrow(mirroredMessage);
      expect(await stored(t, id)).not.toBeNull();
    });

    test("an archived card is off the board and cannot be moved or edited", async () => {
      const { t, owner } = await start();
      const id = await kit.seedMirrored(t, { archivedAt: 5_000 });
      expect(await card(owner, id)).toBeUndefined();
      await expect(owner.mutation(refs.update, { id, notes: "late" })).rejects.toThrow(gone);
      await expect(
        owner.mutation(refs.move, { id, stage: stages.second, index: 0 }),
      ).rejects.toThrow(gone);
    });

    test("a native card can be placed around a mirrored one, which keeps everything but its place", async () => {
      const { t, owner } = await start();
      const mirrored = await kit.seedMirrored(t, { name: "Mirrored Co", stage: stages.first, order: 0 });
      const native = await add(owner, "Native");
      await owner.mutation(refs.move, { id: native, stage: stages.first, index: 0 });
      expect(await names(owner, stages.first)).toEqual(["Native", "Mirrored Co"]);
      expect(await stored(t, mirrored)).toMatchObject({
        name: "Mirrored Co",
        stage: stages.first,
        source: kit.mirror.source,
        order: 1,
      });
    });

    test("a mirrored card whose stage the OS does not know waits in its own column", async () => {
      const { t, owner } = await start();
      const id = await kit.seedMirrored(t, { stage: "unmapped", sourceStage: "Ждём бюджет" });
      expect((await board(owner)).unmapped!.map((c) => c.id)).toEqual([id]);
      expect((await card(owner, id))?.sourceStage).toBe("Ждём бюджет");
    });
  });

  describe(`${kit.table}: access`, () => {
    test("a signed-out caller can read and change nothing", async () => {
      const t = convexTest(schema, modules);
      const id = await kit.seedMirrored(t);
      await expect(t.query(refs.board, kit.boardArgs)).rejects.toThrow("not_allowed");
      await expect(t.mutation(refs.create, { ...kit.boardArgs, name: "x" })).rejects.toThrow("not_allowed");
      await expect(
        t.mutation(refs.move, { id, stage: stages.second, index: 0 }),
      ).rejects.toThrow("not_allowed");
      await expect(t.mutation(refs.update, { id, notes: "x" })).rejects.toThrow("not_allowed");
      await expect(t.mutation(refs.remove, { id })).rejects.toThrow("not_allowed");
    });
  });
}
