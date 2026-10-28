// The two ways a pipeline row changes, written once for both tables:
// the owner placing a native card (placeRow), and a source's push being
// applied (applyPipelineRows). Each table supplies a small set of operations,
// so nothing here knows whether it is handling deals or investors.

import { ConvexError } from "convex/values";
import { placeAt } from "./ordering";
import type { PipelineRow } from "./pipelineRules";
import { isClosedStage, keepsOwnOrder, type Pipeline } from "./pipelineStages";

/** What the writer needs to know about a stored row. */
export type StoredRow = {
  _id: string;
  source: string;
  externalId: string;
  name: string;
  contact?: string;
  stage: string;
  sourceStage?: string;
  amount?: number;
  lastActivityAt?: number;
  closedAt?: number;
  order: number;
  nextStep?: string;
  notes?: string;
  archivedAt?: number;
};

/** The fields a source owns on a mirrored row. A push rewrites exactly these. */
export type SourceFields = {
  name: string;
  contact: string | undefined;
  stage: string;
  sourceStage: string | undefined;
  amount: number | undefined;
  lastActivityAt: number | undefined;
  closedAt: number | undefined;
};

/** What a row can be patched with. Undefined clears a field. */
export type RowPatch = Partial<SourceFields> & {
  externalId?: string;
  order?: number;
  nextStep?: string | undefined;
  notes?: string | undefined;
  archivedAt?: number | undefined;
};

/**
 * A table's operations. `Board` is whatever tells one board from another:
 * the market for deals, nothing for investors.
 */
export type PipelineOps<Row extends StoredRow, Board> = {
  pipeline: Pipeline;
  boardOf(row: Row): Board;
  /** The cards of one column, in stored order. Archived rows are not on a board. */
  column(board: Board, stage: string): Promise<Row[]>;
  find(source: string, externalId: string): Promise<Row | null>;
  /** Every row of a source, archived ones included. */
  ofSource(source: string): Promise<Row[]>;
  insert(
    board: Board,
    row: SourceFields & {
      source: string;
      externalId: string;
      order: number;
      nextStep?: string;
      notes?: string;
    },
  ): Promise<Row>;
  patch(row: Row, patch: RowPatch): Promise<void>;
  /**
   * Whether an archived row stays archived when its source lists it again:
   * one the owner archived here (investors only). Its source's fields are
   * still rewritten. Absent: every archived row comes back when listed.
   */
  keepsArchived?(row: Row): boolean;
};

export type PipelineCounts = {
  inserted: number;
  updated: number;
  unchanged: number;
  archived: number;
};

/** Write `order` 0, 1, 2, … down the given sequence, touching only rows that change. */
async function renumber<Row extends StoredRow, Board>(
  ops: PipelineOps<Row, Board>,
  rows: readonly Row[],
) {
  for (const [index, row] of rows.entries()) {
    if (row.order !== index) await ops.patch(row, { order: index });
  }
}

export async function bottomOf<Row extends StoredRow, Board>(
  ops: PipelineOps<Row, Board>,
  board: Board,
  stage: string,
): Promise<number> {
  if (keepsOwnOrder(ops.pipeline, stage)) return 0;
  const last = (await ops.column(board, stage)).at(-1);
  return (last?.order ?? -1) + 1;
}

/**
 * Put a card at a position in a stage, closing the gap it leaves behind.
 *
 * A closed stage is ordered by close date, not by hand: moving a card into
 * one stamps the date, moving one within it changes nothing, and leaving it
 * clears the date. A change of stage counts as activity; a reorder does not.
 */
export async function placeRow<Row extends StoredRow, Board>(
  ops: PipelineOps<Row, Board>,
  row: Row,
  to: string,
  index: number,
  now: number,
) {
  const board = ops.boardOf(row);
  const from = row.stage;
  if (from !== to) {
    await ops.patch(row, {
      stage: to,
      closedAt: isClosedStage(ops.pipeline, to) ? now : undefined,
      lastActivityAt: now,
    });
    if (!keepsOwnOrder(ops.pipeline, from)) await renumber(ops, await ops.column(board, from));
  }
  if (!keepsOwnOrder(ops.pipeline, to)) {
    const column = await ops.column(board, to);
    const byId = new Map(column.map((r) => [r._id, r]));
    const sequence = placeAt(
      column.map((r) => r._id),
      row._id,
      index,
    );
    await renumber(
      ops,
      sequence.map((id) => byId.get(id)!),
    );
  }
}

const sourceFields = (row: PipelineRow): SourceFields => ({
  name: row.name,
  contact: row.contact,
  stage: row.stage,
  sourceStage: row.sourceStage,
  amount: row.amount,
  lastActivityAt: row.lastActivityAt,
  closedAt: row.closedAt,
});

/**
 * Apply a source's push to its rows.
 *
 * Each row is matched by (source, externalId). A new one is inserted at the
 * bottom of its stage. An existing one has its source-owned fields rewritten
 * and nothing else: the owner's next step and notes are never read or written
 * here. A row that is identical is left untouched, so a push that found
 * nothing new re-runs no query.
 *
 * In "replace" mode the push is the source's whole list: rows of this source
 * that it does not name are archived (taken off the board, kept in the
 * table). An empty replace is refused, since it would archive everything on
 * the strength of a read that most likely failed.
 */
export async function applyPipelineRows<Row extends StoredRow, Board>(
  ops: PipelineOps<Row, Board>,
  source: string,
  board: Board,
  rows: readonly PipelineRow[],
  mode: "upsert" | "replace",
  now: number,
): Promise<PipelineCounts> {
  if (rows.length === 0) {
    throw new ConvexError(
      mode === "replace"
        ? "A replace push cannot be empty: it would archive every row."
        : "A push cannot be empty.",
    );
  }

  const counts: PipelineCounts = { inserted: 0, updated: 0, unchanged: 0, archived: 0 };
  for (const row of rows) {
    const next = sourceFields(row);
    const existing = await ops.find(source, row.externalId);
    if (existing === null) {
      const order = await bottomOf(ops, board, next.stage);
      await ops.insert(board, { ...next, source, externalId: row.externalId, order });
      counts.inserted++;
      continue;
    }
    const staysArchived = existing.archivedAt !== undefined && ops.keepsArchived?.(existing) === true;
    const same =
      (existing.archivedAt === undefined || staysArchived) &&
      (Object.keys(next) as (keyof SourceFields)[]).every((key) => existing[key] === next[key]);
    if (same) {
      counts.unchanged++;
      continue;
    }
    // A card that changes column, or comes back from the archive, joins the
    // bottom of its column; otherwise it keeps the place it had. One the
    // owner archived here stays archived, its source's fields kept current.
    const back = existing.archivedAt !== undefined && !staysArchived;
    const moved = existing.stage !== next.stage || back;
    await ops.patch(existing, {
      ...next,
      ...(staysArchived ? null : { archivedAt: undefined }),
      ...(moved ? { order: await bottomOf(ops, board, next.stage) } : null),
    });
    counts.updated++;
  }

  if (mode === "replace") {
    const named = new Set(rows.map((row) => row.externalId));
    for (const existing of await ops.ofSource(source)) {
      if (existing.archivedAt !== undefined || named.has(existing.externalId)) continue;
      await ops.patch(existing, { archivedAt: now });
      counts.archived++;
    }
  }
  return counts;
}
