// Comments on a task, a deal or a handoff. Pure: the closed set, the limit
// and the fixed sentences. The rows live in convex/comments.ts.
//
// A comment's text is data: cleaned, bounded, stored as plain text and
// rendered as text. No title or address goes in a log or a thrown error.

import type { Area } from "./roles";

export const COMMENT_SUBJECTS = ["task", "deal", "handoff"] as const;
export type CommentSubjectKind = (typeof COMMENT_SUBJECTS)[number];

export const isCommentSubject = (value: unknown): value is CommentSubjectKind =>
  (COMMENT_SUBJECTS as readonly unknown[]).includes(value);

/** The most characters of one comment. Over it is refused, never cut. */
export const MAX_COMMENT_BODY = 2_000;
/** Comments one subject sends, newest kept. */
export const COMMENT_ROWS = 100;

/** The area a comment on that subject needs: the board for a task or a handoff, sales for a deal. */
export const commentArea = (kind: CommentSubjectKind): Area => (kind === "deal" ? "sales" : "board");

export const COMMENT_WORDS = {
  gone: "That is no longer there to comment on.",
  body: "A comment needs some text.",
  needsArea: "A comment on a task or a handoff needs the board, and a comment on a deal needs sales.",
} as const;
