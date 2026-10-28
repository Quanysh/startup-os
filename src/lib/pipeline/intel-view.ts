// How a US deal's sales intelligence is shown and edited on its page
// (src/components/sales/deal-intel/): initials, dates, and the editor's draft.
// Pure. The rules for what may be stored are convex/lib/dealIntel.ts's, which
// the editor runs before it sends anything.

import {
  INTEL_FIELDS,
  type DealIntel,
  type IntelEdit,
  type IntelField,
  type SignalKind,
} from "@convex/lib/dealIntel";
import { formatPeriod } from "@/lib/format";

/** How each kind of signal reads. */
export const SIGNAL_KIND_LABELS: Record<SignalKind, string> = {
  hiring: "Hiring",
  funding: "Funding",
  acquisition: "Acquisition",
  technology: "Technology",
  leadership: "Leadership",
  growth: "Growth",
  news: "News",
  meeting: "Meeting",
};

const TITLES = new Set(["dr", "mr", "mrs", "ms", "mx", "prof"]);

/** A person's initials: the first letters of their first and last names, titles left out. */
export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "" && !TITLES.has(word.replace(/\.$/, "").toLowerCase()));
  if (words.length === 0) return "?";
  const first = [...words[0]!][0]!;
  if (words.length === 1) return first.toUpperCase();
  const last = [...words.at(-1)!][0]!;
  return `${first}${last}`.toUpperCase();
}

/** "Sep 2026" for a month, "Sep 2, 2026" for a day; null for no date. */
export function signalDateLabel(date: string | undefined): string | null {
  if (date === undefined) return null;
  if (/^\d{4}-\d{2}$/.test(date)) return formatPeriod("month", `${date}-01`);
  return `${formatPeriod("day", date)}, ${date.slice(0, 4)}`;
}

/** "Researched Oct 1, 2026". */
export const researchedLabel = (day: string) => `Researched ${signalDateLabel(day)}`;

// ── The editor's draft ──────────────────────────────────────────────────────

type Row<K extends string> = Record<K, string>;

/** Every field as the form holds it: text as typed, a list one item a line, rows as rows. */
export type IntelDraft = {
  summary: string;
  ownership: string;
  ehr: string;
  pm: string;
  billingModel: string;
  rcmVendor: string;
  specialties: string;
  ancillaries: string;
  workersComp: string;
  competitors: Row<"name" | "note">[];
  signals: Row<"date" | "kind" | "text" | "source">[];
  people: Row<"name" | "role" | "note">[];
  painPoints: string;
  talkingPoints: string;
  risks: string;
  angle: string;
  nextBestAction: string;
  fitScore: string;
  fitReasons: string;
  sources: Row<"title" | "url">[];
  researchedAt: string;
};

export const EMPTY_DRAFT: IntelDraft = {
  summary: "",
  ownership: "",
  ehr: "",
  pm: "",
  billingModel: "",
  rcmVendor: "",
  specialties: "",
  ancillaries: "",
  workersComp: "",
  competitors: [],
  signals: [],
  people: [],
  painPoints: "",
  talkingPoints: "",
  risks: "",
  angle: "",
  nextBestAction: "",
  fitScore: "",
  fitReasons: "",
  sources: [],
  researchedAt: "",
};

const TEXT_FIELDS = [
  "summary",
  "ownership",
  "ehr",
  "pm",
  "billingModel",
  "rcmVendor",
  "workersComp",
  "angle",
  "nextBestAction",
  "researchedAt",
] as const satisfies readonly IntelField[];
const LIST_FIELDS = [
  "specialties",
  "ancillaries",
  "painPoints",
  "talkingPoints",
  "risks",
] as const satisfies readonly IntelField[];

const lines = (list: readonly string[]) => list.join("\n");

/** The form's starting state: the intelligence as it is, or empty. */
export function draftOf(intel: DealIntel | null): IntelDraft {
  if (intel === null) return EMPTY_DRAFT;
  const draft: IntelDraft = { ...EMPTY_DRAFT };
  for (const field of TEXT_FIELDS) draft[field] = intel[field] ?? "";
  for (const field of LIST_FIELDS) draft[field] = lines(intel[field]);
  draft.competitors = intel.competitors.map(({ name, note }) => ({ name, note: note ?? "" }));
  draft.signals = intel.signals.map(({ date, kind, text, source }) => ({
    date: date ?? "",
    kind,
    text,
    source,
  }));
  draft.people = intel.people.map(({ name, role, note }) => ({ name, role, note: note ?? "" }));
  draft.sources = intel.sources.map(({ title, url }) => ({ title, url }));
  draft.fitScore = intel.fit === null ? "" : String(intel.fit.score);
  draft.fitReasons = intel.fit === null ? "" : lines(intel.fit.reasons);
  return draft;
}

const listOf = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** Rows with every cell blank are dropped: an "Add" pressed and left empty. */
const filledRows = <R extends Record<string, string>>(rows: readonly R[]) =>
  rows.filter((row) => Object.values(row).some((cell) => cell.trim() !== ""));

/** The value a field of the draft sends, before "unchanged" or "emptied" is decided. */
function valueOf(draft: IntelDraft, field: IntelField): unknown {
  if ((TEXT_FIELDS as readonly string[]).includes(field)) {
    return draft[field as (typeof TEXT_FIELDS)[number]].trim();
  }
  if ((LIST_FIELDS as readonly string[]).includes(field)) {
    return listOf(draft[field as (typeof LIST_FIELDS)[number]]);
  }
  switch (field) {
    case "competitors":
      return filledRows(draft.competitors).map(({ name, note }) => ({ name, note: orNull(note) }));
    case "signals":
      return filledRows(draft.signals).map(({ date, kind, text, source }) => ({
        date: orNull(date),
        kind,
        text,
        source,
      }));
    case "people":
      return filledRows(draft.people).map(({ name, role, note }) => ({ name, role, note: orNull(note) }));
    case "sources":
      return filledRows(draft.sources).map(({ title, url }) => ({ title, url: url.trim() }));
    case "fit":
      return draft.fitScore.trim() === ""
        ? null
        : { score: Number(draft.fitScore.trim()), reasons: listOf(draft.fitReasons) };
    default:
      return null;
  }
}

const orNull = (text: string) => (text.trim() === "" ? null : text);
const isEmpty = (value: unknown) =>
  value === null || value === "" || (Array.isArray(value) && value.length === 0);

/**
 * What a save sends: each field that differs from where the form started,
 * null for one emptied. A field left alone is not sent, so a change the
 * server took meanwhile is kept.
 */
export function editOf(draft: IntelDraft, base: IntelDraft): IntelEdit {
  const edit: Record<string, unknown> = {};
  for (const field of INTEL_FIELDS) {
    const now = valueOf(draft, field);
    if (JSON.stringify(now) === JSON.stringify(valueOf(base, field))) continue;
    edit[field] = isEmpty(now) ? null : now;
  }
  return edit as IntelEdit;
}
