// The words and small sums of an agent's harness tabs (Harness, Tests,
// Versions on /agents): a line diff for the prompt and schema, what a
// version changes, and how a run went. Pure; the rules themselves are
// convex/lib/agentHarness.ts and convex/lib/agentJobs.ts.

import type { HarnessParts, Issue, Params } from "@convex/lib/agentHarness";
import { PARAM_BOUNDS, PARAM_KEYS } from "@convex/lib/agentHarness";
import type { GateState } from "@convex/lib/agentJobs";
import { parseTemplate } from "@convex/lib/agentTemplate";

export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

/** The most lines a diff compares; past it, the two texts are shown as replaced whole. */
const MAX_DIFF_LINES = 2000;

/**
 * A line diff of two texts (the longest common subsequence of their lines):
 * each line kept, added or removed, in order.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return [...a.map((text) => ({ kind: "removed" as const, text })), ...b.map((text) => ({ kind: "added" as const, text }))];
  }
  const rows = a.length + 1;
  const cols = b.length + 1;
  const lcs = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * cols + j] =
        a[i] === b[j] ? lcs[(i + 1) * cols + j + 1]! + 1 : Math.max(lcs[(i + 1) * cols + j]!, lcs[i * cols + j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * cols + j]! >= lcs[i * cols + j + 1]!) {
      out.push({ kind: "removed", text: a[i]! });
      i += 1;
    } else {
      out.push({ kind: "added", text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) out.push({ kind: "removed", text: a[i++]! });
  while (j < b.length) out.push({ kind: "added", text: b[j++]! });
  return out;
}

/** Whether a diff changes anything. */
export const changes = (diff: readonly DiffLine[]) => diff.some((line) => line.kind !== "same");

export type PartKey = keyof HarnessParts;

const PART_WORDS: Record<PartKey, string> = {
  prompt: "prompt",
  params: "parameters",
  tools: "tools",
  outputSchema: "output schema",
};

const listWords = (items: readonly string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** The parts a version changes, in a fixed order. */
export const changedParts = (parts: HarnessParts): PartKey[] =>
  (Object.keys(PART_WORDS) as PartKey[]).filter((key) => parts[key] !== undefined);

/** What a version changes from the code's defaults: "Changes the prompt and tools", or the code's own. */
export function partsWords(changed: readonly PartKey[]): string {
  if (changed.length === 0) return "The project's built-in harness, unchanged";
  const words = listWords(changed.map((key) => PART_WORDS[key]));
  return `Changes the ${words}`;
}

export type VersionStatus = "draft" | "published" | "archived";

/** A version's state in words: an archived one never published was a draft put away. */
export function versionStatusWords(status: VersionStatus, wasPublished: boolean): string {
  if (status === "draft") return "Draft";
  if (status === "published") return "Published";
  return wasPublished ? "Archived" : "Discarded draft";
}

export const GATE_SHORT: Record<GateState, string> = {
  passed: "Tests passed",
  no_run: "Not tested",
  running: "Testing",
  stale: "Changed since its test",
  failed: "Tests failed",
};

export const RUN_STATUS_WORDS = {
  queued: "Waiting for the project",
  running: "Running in the project",
  done: "Finished",
  expired: "Given up: the project did not answer",
} as const;

/** "3 of 4 passed", or why there is no count yet. */
export function runCountWords(run: { status: keyof typeof RUN_STATUS_WORDS; expected: number; received: number; passed: number }) {
  if (run.status === "queued" || run.status === "running") return RUN_STATUS_WORDS[run.status];
  if (run.status === "expired") return RUN_STATUS_WORDS.expired;
  const missing = run.expected - run.received;
  return `${run.passed} of ${run.expected} passed${missing > 0 ? `, ${missing} not answered` : ""}`;
}

/** A params form's text fields, from what runs: every parameter, blank where none is set. */
export function paramsText(params: Params | null): Record<string, string> {
  return Object.fromEntries(PARAM_KEYS.map((key) => [key, params?.[key] === undefined ? "" : String(params[key])]));
}

/**
 * Parameters from the form's text: a blank field is left out; anything that
 * is not a number is kept as NaN, so the rules say which field is wrong.
 * Published parameters replace the code's whole set, so the form holds all.
 */
export function paramsFromText(text: Record<string, string>): Params | null {
  const out: Params = {};
  for (const key of PARAM_KEYS) {
    const raw = (text[key] ?? "").trim();
    if (raw === "") continue;
    out[key] = Number(raw);
  }
  return Object.keys(out).length === 0 ? null : out;
}

export const PARAM_HINTS: Record<keyof Params, string> = Object.fromEntries(
  PARAM_KEYS.map((key) => [key, `${PARAM_BOUNDS[key].min} to ${PARAM_BOUNDS[key].max}`]),
) as Record<keyof Params, string>;

/** JSON text laid out to read: two spaces, or the text as typed where it is not JSON. */
export function prettyJson(text: string | null): string {
  if (text === null) return "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

// ── Protocol v1.2 in the editor ──────────────────────────────────────────────

export type TemplatePiece = { text: string; section: { name: string; inverted: boolean } | null };

/**
 * A template in pieces for the editor to mark: each closed section (from its
 * opening tag to its closing one) one piece, the text between others. Every
 * character is kept, in order. A section never closed is not marked.
 */
export function templateSegments(text: string): TemplatePiece[] {
  const pieces: TemplatePiece[] = [];
  let at = 0;
  for (const section of parseTemplate(text).sections) {
    if (section.start > at) pieces.push({ text: text.slice(at, section.start), section: null });
    pieces.push({ text: text.slice(section.start, section.end), section: { name: section.name, inverted: section.inverted } });
    at = section.end;
  }
  if (at < text.length) pieces.push({ text: text.slice(at), section: null });
  return pieces;
}

/** Where a problem is in its template: "line 2, column 13", or nothing. */
export const placeWords = (issue: Issue): string =>
  issue.at === undefined ? "" : `line ${issue.at.line}, column ${issue.at.column}`;

/** How many problems each variant has, by the variant named in the path (`prompt.<variant>…`). */
export function problemsByVariant(issues: readonly Issue[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const issue of issues) {
    const match = /^prompt\.([a-z][a-z0-9_]{0,31})(?:\.|$)/.exec(issue.path);
    if (match === null) continue;
    counts.set(match[1]!, (counts.get(match[1]!) ?? 0) + 1);
  }
  return counts;
}
