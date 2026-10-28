// What the owner can do to a card on a pipeline board, written once for
// deals and investors. The rule that matters most lives here: a mirrored
// row's source-owned fields cannot be changed from the OS, except where its
// source takes changes back (`WRITE_BACK_SOURCES`). The boards do not offer
// the rest, and these functions refuse it for a caller that asks anyway.

import { ConvexError } from "convex/values";
import { MAX_NAME_LENGTH, MAX_NEXT_STEP_LENGTH, MAX_NOTES_LENGTH } from "./limits";
import { checkAmount, cleanName, cleanOptional } from "./pipelineFields";
import { NATIVE_SOURCE, sourceNamed } from "./pipelineRules";
import { isClosedStage, isStage, type Pipeline } from "./pipelineStages";
import {
  bottomOf,
  placeRow,
  type PipelineOps,
  type RowPatch,
  type StoredRow,
} from "./pipelineWriter";

/** How each pipeline's cards are spoken of in a message. */
export type CardWords = {
  /** "deal", "investor". */
  noun: string;
  /** The whole sentence for a blank name, without its full stop. */
  nameNeeds: string;
};

export const isMirrored = (row: { source: string }) => row.source !== NATIVE_SOURCE;

/**
 * Mirrored sources whose rows are edited here and written back to them: name,
 * amount and stage (a drag included) change at once and are queued for the
 * source (convex/lib/investorSync.ts). The contact stays the source's, since
 * the OS does not read it from there. Per pipeline: the Kazakhstan CRM's
 * deals take nothing back, so they stay as locked as they always were.
 */
export const WRITE_BACK_SOURCES: Record<Pipeline, readonly string[]> = {
  deals: [],
  investors: ["visible"],
};

/** Whether this mirrored row's source takes changes made here. */
export const writesBack = (pipeline: Pipeline, row: { source: string }) =>
  isMirrored(row) && WRITE_BACK_SOURCES[pipeline].includes(row.source);

export const CARD_FIELDS = ["name", "contact", "amount", "stage", "nextStep", "notes"] as const;
export type CardField = (typeof CARD_FIELDS)[number];

/** The fields of a card the owner may change here: the page's editor and grip read this. */
export function editableFields(pipeline: Pipeline, row: { source: string }): CardField[] {
  if (!isMirrored(row)) return [...CARD_FIELDS];
  return writesBack(pipeline, row)
    ? ["name", "amount", "stage", "nextStep", "notes"]
    : ["nextStep", "notes"];
}

/**
 * What the page may do with a card: `editable` says its own fields (name,
 * amount, stage) can be changed here, `draggable` that it can be moved, and
 * `editableFields` exactly which fields. The page offers what these say and
 * nothing else, and the mutations refuse the rest whatever the page offers.
 * Sent on investors' cards; deals' cards are exactly what they were.
 */
export function cardAbilities(pipeline: Pipeline, row: { source: string }) {
  const fields = editableFields(pipeline, row);
  return { editable: fields.includes("name"), editableFields: fields, draggable: fields.includes("stage") };
}

export function presentCard(row: StoredRow) {
  return {
    id: row._id,
    mirrored: isMirrored(row),
    source: row.source,
    name: row.name,
    contact: row.contact ?? null,
    stage: row.stage,
    sourceStage: row.sourceStage ?? null,
    amount: row.amount ?? null,
    lastActivityAt: row.lastActivityAt ?? null,
    closedAt: row.closedAt ?? null,
    nextStep: row.nextStep ?? null,
    notes: row.notes ?? null,
  };
}

/** Closed columns list the most recently closed first; undated ones last. */
export const newestClosedFirst = (a: { closedAt: number | null }, b: { closedAt: number | null }) =>
  (b.closedAt ?? 0) - (a.closedAt ?? 0);

/** The row, if it exists and is on a board. An archived row is not. */
export function cardOnBoard<Row extends StoredRow>(row: Row | null, words: CardWords): Row {
  if (row === null || row.archivedAt !== undefined) {
    throw new ConvexError(`That ${words.noun} is no longer on the board.`);
  }
  return row;
}

export function mirroredMessage(row: { source: string }, words: CardWords): string {
  return `This ${words.noun} is mirrored from ${sourceNamed(row.source)}. Change it there: here you can edit only its next step and notes.`;
}

/** What a written-back card's contact is refused with: the one field its source keeps. */
export function contactMessage(row: { source: string }, words: CardWords): string {
  return `This ${words.noun}'s contact comes from ${sourceNamed(row.source)}. Change it there: here you can edit its name, amount, stage, next step and notes.`;
}

/** A native card may be moved, edited in full and deleted. A mirrored one may not. */
export function refuseMirrored(row: { source: string }, words: CardWords) {
  if (isMirrored(row)) throw new ConvexError(mirroredMessage(row, words));
}

/** A card may be moved when it is native or its source takes changes back. */
function refuseUnmovable(pipeline: Pipeline, row: { source: string }, words: CardWords) {
  if (!editableFields(pipeline, row).includes("stage")) {
    throw new ConvexError(mirroredMessage(row, words));
  }
}

/**
 * What the agents' `investor_update` refuses with (convex/lib/mcpTools.ts):
 * an investor that is gone, in the board's own words, and a contact that
 * holds an email address or a phone number. Fixed words: nothing sent is quoted.
 */
export const INVESTOR_TOOL_WORDS = {
  gone: "That investor is no longer on the board.",
  contact:
    "Leave email addresses and phone numbers out: an investor names its contact by name and role only. Nothing was changed.",
  source:
    "Leave email addresses and phone numbers out of where an investor was found. Nothing was added.",
} as const;

function checkStage<Row extends StoredRow, Board>(
  ops: PipelineOps<Row, Board>,
  stage: string,
  words: CardWords,
) {
  if (!isStage(ops.pipeline, stage)) {
    throw new ConvexError(`That is not a stage ${withArticle(words.noun)} can be moved to.`);
  }
}

const withArticle = (noun: string) => `${/^[aeiou]/.test(noun) ? "an" : "a"} ${noun}`;

export type NewCard = {
  name: string;
  stage?: string;
  contact?: string;
  amount?: number;
  nextStep?: string;
  notes?: string;
};

/** Create a native card at the bottom of its stage. Returns its id. */
export async function createCard<Row extends StoredRow, Board>(
  ops: PipelineOps<Row, Board>,
  board: Board,
  card: NewCard,
  firstStage: string,
  words: CardWords,
  now: number,
): Promise<Row["_id"]> {
  const stage = card.stage ?? firstStage;
  checkStage(ops, stage, words);
  const row = await ops.insert(board, {
    source: NATIVE_SOURCE,
    externalId: "",
    name: cleanName(card.name, words.nameNeeds),
    contact:
      card.contact === undefined
        ? undefined
        : cleanOptional(card.contact, MAX_NAME_LENGTH, "That contact name"),
    stage,
    sourceStage: undefined,
    amount: card.amount === undefined ? undefined : checkAmount(card.amount),
    lastActivityAt: now,
    closedAt: isClosedStage(ops.pipeline, stage) ? now : undefined,
    order: await bottomOf(ops, board, stage),
    nextStep:
      card.nextStep === undefined
        ? undefined
        : cleanOptional(card.nextStep, MAX_NEXT_STEP_LENGTH, "That next step"),
    notes:
      card.notes === undefined
        ? undefined
        : cleanOptional(card.notes, MAX_NOTES_LENGTH, "That note"),
  });
  // A native row is its own record of truth, so its key is its own id.
  await ops.patch(row, { externalId: row._id });
  return row._id;
}

/**
 * Put a card at a position in a stage. A mirrored card cannot be moved,
 * unless its source takes changes back.
 */
export async function moveCard<Row extends StoredRow, Board>(
  ops: PipelineOps<Row, Board>,
  found: Row | null,
  stage: string,
  index: number,
  words: CardWords,
  now: number,
) {
  const row = cardOnBoard(found, words);
  refuseUnmovable(ops.pipeline, row, words);
  checkStage(ops, stage, words);
  await placeRow(ops, row, stage, index, now);
}

/** For these, null clears the field and leaving it out keeps it. */
export type CardEdit = {
  name?: string;
  contact?: string | null;
  amount?: number | null;
  stage?: string;
  nextStep?: string | null;
  notes?: string | null;
};

const SOURCE_OWNED = ["name", "contact", "amount", "stage"] as const;

/**
 * Edit a card. On a mirrored row only the next step and the notes can
 * change; naming any source-owned field is refused outright, even with the
 * value it already has, so nothing here can drift from the source. A source
 * that takes changes back also lets its name, amount and stage change here;
 * its contact is refused in the same way.
 *
 * On a native row, a change of stage or a changed next step or note counts
 * as activity. A mirrored row's last activity is the source's to say.
 */
export async function editCard<Row extends StoredRow, Board>(
  ops: PipelineOps<Row, Board>,
  found: Row | null,
  edit: CardEdit,
  words: CardWords,
  now: number,
) {
  const row = cardOnBoard(found, words);
  const mirrored = isMirrored(row);
  const allowed = editableFields(ops.pipeline, row);
  if (SOURCE_OWNED.some((field) => edit[field] !== undefined && !allowed.includes(field))) {
    throw new ConvexError(
      writesBack(ops.pipeline, row) ? contactMessage(row, words) : mirroredMessage(row, words),
    );
  }
  if (edit.stage !== undefined) checkStage(ops, edit.stage, words);

  const patch: RowPatch = {};
  if (edit.name !== undefined) patch.name = cleanName(edit.name, words.nameNeeds);
  if (edit.contact !== undefined) {
    patch.contact =
      edit.contact === null
        ? undefined
        : cleanOptional(edit.contact, MAX_NAME_LENGTH, "That contact name");
  }
  if (edit.amount !== undefined) {
    patch.amount = edit.amount === null ? undefined : checkAmount(edit.amount);
  }
  let touched = false;
  if (edit.nextStep !== undefined) {
    patch.nextStep =
      edit.nextStep === null
        ? undefined
        : cleanOptional(edit.nextStep, MAX_NEXT_STEP_LENGTH, "That next step");
    touched ||= patch.nextStep !== row.nextStep;
  }
  if (edit.notes !== undefined) {
    patch.notes =
      edit.notes === null ? undefined : cleanOptional(edit.notes, MAX_NOTES_LENGTH, "That note");
    touched ||= patch.notes !== row.notes;
  }
  if (touched && !mirrored) patch.lastActivityAt = now;

  if (Object.keys(patch).length > 0) await ops.patch(row, patch);
  if (edit.stage !== undefined && edit.stage !== row.stage) {
    await placeRow(ops, row, edit.stage, 0, now);
  }
}
