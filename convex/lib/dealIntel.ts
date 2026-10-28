// A US deal's sales intelligence: what research found about a practice
// (ownership, systems, billing, competitors, signals, people, the angle to
// take), kept beside the deal in `dealIntel` (convex/dealIntel.ts). Native US
// deals only: never a Kazakhstan or mirrored deal, never an investor.
//
// It arrives from outside (an import of what an agent read in research
// artifacts) and from the editor on the deal's page. Both go through
// `cleanIntelEdit`, here, so the server, the import script and the editor
// refuse the same things in the same words. Every refusal is a fixed
// sentence: it never quotes a value, so it can be shown, printed and logged.
//
// What may be stored: text cleaned of anything invisible or controlling, held
// to its limit (refused over it, never cut); people by name and role only; and
// no email address, phone number or link in any text field. The one link kept
// is a source's, and only a claude.ai artifact's.
//
// Pure, so the UI may import it.

import { looksLikeContactDetail, normalDealName } from "./dealDetails";
import { cleanLines } from "./agentText";
import { cleanRemote } from "./mirrorRules";

export const BILLING_MODELS = ["in-house", "outsourced", "hybrid"] as const;
export type BillingModel = (typeof BILLING_MODELS)[number];
export const isBillingModel = (value: unknown): value is BillingModel =>
  BILLING_MODELS.includes(value as BillingModel);

export const SIGNAL_KINDS = [
  "hiring",
  "funding",
  "acquisition",
  "technology",
  "leadership",
  "growth",
  "news",
  "meeting",
] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];
export const isSignalKind = (value: unknown): value is SignalKind =>
  SIGNAL_KINDS.includes(value as SignalKind);

/** Every limit, in one place: the server, the script and the editor quote these. */
export const INTEL_LIMITS = {
  summary: 600,
  ownership: 120,
  /** The EHR, the practice management system and the RCM vendor: a product's or a firm's name. */
  system: 80,
  workersComp: 200,
  angle: 300,
  nextBestAction: 200,
  specialties: 8,
  ancillaries: 8,
  /** A specialty or an ancillary: a few words. */
  tag: 40,
  competitors: 8,
  competitorName: 60,
  /** A competitor's, a person's or a fit reason's note; a pain point, talking point or risk. */
  point: 160,
  signals: 8,
  signalText: 200,
  signalSource: 120,
  people: 6,
  personName: 80,
  personRole: 80,
  painPoints: 5,
  talkingPoints: 4,
  risks: 3,
  fitReasons: 3,
  sources: 12,
  sourceTitle: 120,
  /** A deal's name as an import row gives it (MAX_NAME_LENGTH). */
  dealName: 120,
  /** An artifact's id in its link. */
  artifactId: 128,
} as const;

/** What the agents' `deals` tool cuts a summary to. */
export const AGENT_SUMMARY_LENGTH = 300;
/** How many signals the agents' `deals` tool sends, newest first. */
export const AGENT_SIGNALS = 3;

export type IntelCompetitor = { name: string; note?: string };
export type IntelSignal = { date?: string; kind: SignalKind; text: string; source: string };
export type IntelPerson = { name: string; role: string; note?: string };
export type IntelSource = { title: string; url: string };
export type IntelFit = { score: number; reasons: string[] };

/** A deal's intelligence as stored: every field optional, an empty list not kept. */
export type StoredIntel = {
  summary?: string;
  ownership?: string;
  ehr?: string;
  pm?: string;
  billingModel?: BillingModel;
  rcmVendor?: string;
  specialties?: string[];
  ancillaries?: string[];
  workersComp?: string;
  competitors?: IntelCompetitor[];
  signals?: IntelSignal[];
  people?: IntelPerson[];
  painPoints?: string[];
  talkingPoints?: string[];
  risks?: string[];
  angle?: string;
  nextBestAction?: string;
  fit?: IntelFit;
  sources?: IntelSource[];
  /** "YYYY-MM-DD": the day the research was done. */
  researchedAt?: string;
  updatedAt: number;
};

export const INTEL_FIELDS = [
  "summary",
  "ownership",
  "ehr",
  "pm",
  "billingModel",
  "rcmVendor",
  "specialties",
  "ancillaries",
  "workersComp",
  "competitors",
  "signals",
  "people",
  "painPoints",
  "talkingPoints",
  "risks",
  "angle",
  "nextBestAction",
  "fit",
  "sources",
  "researchedAt",
] as const satisfies readonly Exclude<keyof StoredIntel, "updatedAt">[];
export type IntelField = (typeof INTEL_FIELDS)[number];

/** What is patched onto a row: undefined clears a field. */
export type IntelPatch = { [K in IntelField]?: StoredIntel[K] | undefined };

type Text = string | null;
type TextList = readonly string[] | null;

/** An edit as the editor or an import gives it. Leaving a field out keeps it; null clears it. */
export type IntelEdit = {
  summary?: Text;
  ownership?: Text;
  ehr?: Text;
  pm?: Text;
  billingModel?: Text;
  rcmVendor?: Text;
  specialties?: TextList;
  ancillaries?: TextList;
  workersComp?: Text;
  competitors?: readonly { name: string; note?: Text }[] | null;
  signals?: readonly { date?: Text; kind: string; text: string; source: string }[] | null;
  people?: readonly { name: string; role: string; note?: Text }[] | null;
  painPoints?: TextList;
  talkingPoints?: TextList;
  risks?: TextList;
  angle?: Text;
  nextBestAction?: Text;
  fit?: { score: number; reasons: readonly string[] } | null;
  sources?: readonly { title: string; url: string }[] | null;
  researchedAt?: Text;
};

/** A deal's intelligence as `dealIntel.get` sends it: null or [] where unset. */
export type DealIntel = {
  [K in IntelField]-?: K extends
    | "specialties"
    | "ancillaries"
    | "competitors"
    | "signals"
    | "people"
    | "painPoints"
    | "talkingPoints"
    | "risks"
    | "sources"
    ? NonNullable<StoredIntel[K]>
    : NonNullable<StoredIntel[K]> | null;
} & { updatedAt: number };

/** What the table's columns need of a deal's intelligence (`dealIntel.list`). */
export type IntelSummary = {
  fit: number | null;
  ehr: string | null;
  billingModel: BillingModel | null;
  ownership: string | null;
  /** How many signals. */
  signals: number;
  /** The newest signal's date, "YYYY-MM" or "YYYY-MM-DD". */
  newestSignal: string | null;
  /** How many competitors. */
  competitors: number;
};

// ── Checks ──────────────────────────────────────────────────────────────────

/** Said when intelligence would store an address, a number or a link. */
export const NO_LINKS_OR_CONTACTS =
  "Leave email addresses, phone numbers and links out: the intelligence names people by name and role, and links only to its sources.";

const ARTIFACT_URL = new RegExp(
  `^https://claude\\.ai/artifact/[A-Za-z0-9_-]{1,${INTEL_LIMITS.artifactId}}$`,
);

/**
 * Whether a link is a claude.ai artifact's, exactly: https, that host and no
 * other (no user, no port), `/artifact/` and an id, and nothing after it. The
 * only link the intelligence keeps, and the only one its page renders.
 */
export function isArtifactUrl(value: unknown): value is string {
  return typeof value === "string" && ARTIFACT_URL.test(value);
}

const SCHEME = /\b[a-z][a-z0-9+.-]*:\/\//i;
const WWW = /\bwww\./i;
// A bare domain on a common ending ("examplevertical.com"), not a word that
// merely holds a dot ("Inc.", "St. Louis", "Node.js").
const DOMAIN =
  /(?:^|[^\w@.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|ai|co|us|health|care|clinic|info|biz|gov|edu|app|dev|me|ly|so|test)(?![\w-])/i;

/** Whether text holds what looks like a link: a scheme, a "www." or a bare domain. Blunt on purpose. */
export function looksLikeLink(text: string): boolean {
  return SCHEME.test(text) || WWW.test(text) || DOMAIN.test(text);
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MONTH = /^(\d{4})-(\d{2})$/;

function isRealDay(text: string): boolean {
  const found = ISO_DAY.exec(text);
  if (found === null) return false;
  const [, y, m, d] = found.map(Number) as [number, number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function isRealMonth(text: string): boolean {
  const found = ISO_MONTH.exec(text);
  return found !== null && Number(found[2]) >= 1 && Number(found[2]) <= 12;
}

// ── Cleaning ────────────────────────────────────────────────────────────────

/** A refusal in fixed words, caught at the edge of `cleanIntelEdit`. */
class Refusal {
  constructor(readonly problem: string) {}
}
const refuse = (problem: string): never => {
  throw new Refusal(problem);
};

const tooLong = (label: string, max: number) => `${label} is too long (${max} characters at most).`;

function noLeak(text: string): string {
  if (looksLikeContactDetail(text) || looksLikeLink(text)) refuse(NO_LINKS_OR_CONTACTS);
  return text;
}

/** One line, cleaned; "" when blank. Over `max` is refused, never cut. */
function line(value: unknown, max: number, label: string): string {
  const text = cleanRemote(value, Number.MAX_SAFE_INTEGER);
  if (text.length > max) refuse(tooLong(label, max));
  return noLeak(text);
}

/** Paragraphs, cleaned as lines are, blank runs kept to one (`cleanLines`, the agents' own). */
function paragraphs(value: unknown, max: number, label: string): string {
  const text = cleanLines(value, max);
  if (text === null) refuse(tooLong(label, max));
  return noLeak(text!);
}

const orNone = (text: string) => (text === "" ? undefined : text);
const listOrNone = <T>(list: T[]) => (list.length === 0 ? undefined : list);

function many(given: readonly unknown[], max: number, words: string) {
  if (given.length > max) refuse(`The intelligence lists ${max} ${words} at most.`);
}

/** A list of short texts: blank ones dropped, repeats kept once. */
function texts(given: readonly string[], max: number, words: string, each: number, label: string) {
  many(given, max, words);
  const kept: string[] = [];
  for (const item of given) {
    const text = line(item, each, label);
    if (text !== "" && !kept.includes(text)) kept.push(text);
  }
  return listOrNone(kept);
}

function competitors(given: NonNullable<IntelEdit["competitors"]>) {
  many(given, INTEL_LIMITS.competitors, "competitors");
  return listOrNone(
    given.map(({ name, note }) => {
      const cleanName = line(name, INTEL_LIMITS.competitorName, "A competitor's name");
      if (cleanName === "") refuse("A competitor needs a name.");
      const cleanNote = orNone(line(note ?? "", INTEL_LIMITS.point, "A competitor's note"));
      return cleanNote === undefined ? { name: cleanName } : { name: cleanName, note: cleanNote };
    }),
  );
}

function signals(given: NonNullable<IntelEdit["signals"]>) {
  many(given, INTEL_LIMITS.signals, "signals");
  return listOrNone(
    given.map(({ date, kind, text, source }): IntelSignal => {
      if (!isSignalKind(kind)) {
        refuse("A signal is hiring, funding, acquisition, technology, leadership, growth, news or a meeting.");
      }
      const day = (date ?? "").trim();
      if (day !== "" && !isRealDay(day) && !isRealMonth(day)) {
        refuse("A signal's date is written YYYY-MM or YYYY-MM-DD.");
      }
      const cleanText = line(text, INTEL_LIMITS.signalText, "A signal's text");
      const cleanSource = line(source, INTEL_LIMITS.signalSource, "A signal's source");
      if (cleanText === "" || cleanSource === "") refuse("A signal needs its text and its source.");
      return {
        ...(day === "" ? {} : { date: day }),
        kind: kind as SignalKind,
        text: cleanText,
        source: cleanSource,
      };
    }),
  );
}

function people(given: NonNullable<IntelEdit["people"]>) {
  many(given, INTEL_LIMITS.people, "people");
  return listOrNone(
    given.map(({ name, role, note }): IntelPerson => {
      const cleanName = line(name, INTEL_LIMITS.personName, "A person's name");
      const cleanRole = line(role, INTEL_LIMITS.personRole, "A person's role");
      if (cleanName === "" || cleanRole === "") refuse("A person needs a name and a role.");
      const cleanNote = orNone(line(note ?? "", INTEL_LIMITS.point, "A person's note"));
      return cleanNote === undefined
        ? { name: cleanName, role: cleanRole }
        : { name: cleanName, role: cleanRole, note: cleanNote };
    }),
  );
}

function fit(given: NonNullable<IntelEdit["fit"]>): IntelFit {
  const { score } = given;
  if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 100) {
    refuse("A fit score is a whole number from 0 to 100.");
  }
  if (given.reasons.length > INTEL_LIMITS.fitReasons) {
    refuse(`A fit score gives ${INTEL_LIMITS.fitReasons} reasons at most.`);
  }
  const reasons: string[] = [];
  for (const reason of given.reasons) {
    const text = line(reason, INTEL_LIMITS.point, "A fit reason");
    if (text !== "" && !reasons.includes(text)) reasons.push(text);
  }
  return { score, reasons };
}

function sources(given: NonNullable<IntelEdit["sources"]>) {
  many(given, INTEL_LIMITS.sources, "sources");
  const kept: IntelSource[] = [];
  for (const { title, url } of given) {
    const cleanTitle = line(title, INTEL_LIMITS.sourceTitle, "A source's title");
    if (cleanTitle === "") refuse("A source needs a title.");
    const link = typeof url === "string" ? url.trim() : "";
    if (!isArtifactUrl(link)) {
      refuse("A source links to a claude.ai artifact (https://claude.ai/artifact/…), and to nothing else.");
    }
    if (!kept.some((source) => source.url === link)) kept.push({ title: cleanTitle, url: link });
  }
  return listOrNone(kept);
}

/** How each field is cleaned when it is given (not null). */
const CLEAN: { [K in IntelField]: (value: NonNullable<IntelEdit[K]>) => StoredIntel[K] } = {
  summary: (value) => orNone(paragraphs(value, INTEL_LIMITS.summary, "The summary")),
  ownership: (value) => orNone(line(value, INTEL_LIMITS.ownership, "The ownership")),
  ehr: (value) => orNone(line(value, INTEL_LIMITS.system, "The EHR")),
  pm: (value) => orNone(line(value, INTEL_LIMITS.system, "The practice management system")),
  billingModel: (value) => {
    const model = value.trim().toLowerCase();
    if (model === "") return undefined;
    if (!isBillingModel(model)) refuse("A billing model is in-house, outsourced or hybrid.");
    return model as BillingModel;
  },
  rcmVendor: (value) => orNone(line(value, INTEL_LIMITS.system, "The RCM vendor")),
  specialties: (value) =>
    texts(value, INTEL_LIMITS.specialties, "specialties", INTEL_LIMITS.tag, "A specialty"),
  ancillaries: (value) =>
    texts(value, INTEL_LIMITS.ancillaries, "ancillaries", INTEL_LIMITS.tag, "An ancillary"),
  workersComp: (value) =>
    orNone(line(value, INTEL_LIMITS.workersComp, "The workers' comp note")),
  competitors,
  signals,
  people,
  painPoints: (value) =>
    texts(value, INTEL_LIMITS.painPoints, "pain points", INTEL_LIMITS.point, "A pain point"),
  talkingPoints: (value) =>
    texts(value, INTEL_LIMITS.talkingPoints, "talking points", INTEL_LIMITS.point, "A talking point"),
  risks: (value) => texts(value, INTEL_LIMITS.risks, "risks", INTEL_LIMITS.point, "A risk"),
  angle: (value) => orNone(line(value, INTEL_LIMITS.angle, "The angle")),
  nextBestAction: (value) =>
    orNone(line(value, INTEL_LIMITS.nextBestAction, "The next best action")),
  fit,
  sources,
  researchedAt: (value) => {
    const day = value.trim();
    if (day === "") return undefined;
    if (!isRealDay(day)) refuse("The research date is written YYYY-MM-DD.");
    return day;
  },
};

export type Cleaned<T> = { ok: true } & T;
export type Refused = { ok: false; problem: string };

function attempt<T>(work: () => T): ({ ok: true; value: T }) | Refused {
  try {
    return { ok: true, value: work() };
  } catch (failure) {
    if (failure instanceof Refusal) return { ok: false, problem: failure.problem };
    // Anything else is a value of the wrong type: said in fixed words too.
    return { ok: false, problem: "Part of the intelligence could not be read." };
  }
}

function cleanEdit(edit: IntelEdit): IntelPatch {
  const patch: IntelPatch = {};
  for (const field of INTEL_FIELDS) {
    const value = edit[field];
    if (value === undefined) continue;
    (patch as Record<string, unknown>)[field] =
      value === null ? undefined : (CLEAN[field] as (given: unknown) => unknown)(value);
  }
  return patch;
}

/**
 * An edit, cleaned: the fields it gives (null or blank clears one), each held
 * to its limit and refused, in fixed words, over it or when it holds an
 * address, a phone number or a link. What is left out is not in the patch.
 */
export function cleanIntelEdit(edit: IntelEdit): Cleaned<{ patch: IntelPatch }> | Refused {
  const result = attempt(() => cleanEdit(edit));
  return result.ok ? { ok: true, patch: result.value } : result;
}

/** A row of an import: a deal's name and its intelligence. */
export type IntelRow = { dealName: string } & IntelEdit;

/**
 * An import's rows, cleaned. Each gives every field (one it leaves out is
 * cleared), so an import replaces a deal's intelligence whole. A name may
 * come once. A refusal is "Row <n>: " and a fixed sentence, counted from 1:
 * never a value, so the script can print it.
 */
export function cleanIntelRows(
  rows: readonly IntelRow[],
): Cleaned<{ rows: { dealName: string; patch: IntelPatch }[] }> | Refused {
  const seen = new Set<string>();
  const cleaned: { dealName: string; patch: IntelPatch }[] = [];
  for (const [index, row] of rows.entries()) {
    const result = attempt(() => {
      const dealName = typeof row.dealName === "string" ? row.dealName.trim() : "";
      if (dealName === "") refuse("A row needs its deal's name.");
      if (dealName.length > INTEL_LIMITS.dealName) refuse(tooLong("That name", INTEL_LIMITS.dealName));
      const key = normalDealName(dealName);
      if (seen.has(key)) refuse("This deal is named twice in the list.");
      seen.add(key);
      const whole = Object.fromEntries(INTEL_FIELDS.map((field) => [field, row[field] ?? null]));
      return { dealName, patch: cleanEdit(whole as IntelEdit) };
    });
    if (!result.ok) return { ok: false, problem: `Row ${index + 1}: ${result.problem}` };
    cleaned.push(result.value);
  }
  return { ok: true, rows: cleaned };
}

// ── What is sent ────────────────────────────────────────────────────────────

/** Signals newest first (a day before its month), undated last, at most `n`. */
export function newestSignals<S extends { date?: string }>(list: readonly S[], n: number): S[] {
  return list
    .map((signal, index) => ({ signal, index }))
    .sort((a, b) => {
      const x = a.signal.date;
      const y = b.signal.date;
      if (x === undefined || y === undefined) {
        return x === y ? a.index - b.index : x === undefined ? 1 : -1;
      }
      return y.localeCompare(x) || a.index - b.index;
    })
    .slice(0, n)
    .map(({ signal }) => signal);
}

/** A stored row as `dealIntel.get` sends it. */
export function presentIntel(row: StoredIntel): DealIntel {
  return {
    summary: row.summary ?? null,
    ownership: row.ownership ?? null,
    ehr: row.ehr ?? null,
    pm: row.pm ?? null,
    billingModel: row.billingModel ?? null,
    rcmVendor: row.rcmVendor ?? null,
    specialties: row.specialties ?? [],
    ancillaries: row.ancillaries ?? [],
    workersComp: row.workersComp ?? null,
    competitors: row.competitors ?? [],
    signals: row.signals ?? [],
    people: row.people ?? [],
    painPoints: row.painPoints ?? [],
    talkingPoints: row.talkingPoints ?? [],
    risks: row.risks ?? [],
    angle: row.angle ?? null,
    nextBestAction: row.nextBestAction ?? null,
    fit: row.fit ?? null,
    sources: row.sources ?? [],
    researchedAt: row.researchedAt ?? null,
    updatedAt: row.updatedAt,
  };
}

/** What the table's columns need. */
export function intelSummaryOf(row: StoredIntel): IntelSummary {
  const list = row.signals ?? [];
  return {
    fit: row.fit?.score ?? null,
    ehr: row.ehr ?? null,
    billingModel: row.billingModel ?? null,
    ownership: row.ownership ?? null,
    signals: list.length,
    newestSignal: newestSignals(list, 1)[0]?.date ?? null,
    competitors: row.competitors?.length ?? 0,
  };
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * What the agents' `deals` tool sends of a US deal's intelligence: the
 * summary cut short, the fit's score, the systems and ownership, the newest
 * signals without their source, the angle and the next best action. No
 * person's name: an agent addresses people by role.
 */
export function agentIntelOf(row: StoredIntel) {
  return {
    summary: row.summary === undefined ? null : cut(row.summary, AGENT_SUMMARY_LENGTH),
    fit: row.fit?.score ?? null,
    ehr: row.ehr ?? null,
    billingModel: row.billingModel ?? null,
    ownership: row.ownership ?? null,
    signals: newestSignals(row.signals ?? [], AGENT_SIGNALS).map(({ date, kind, text }) => ({
      ...(date === undefined ? {} : { date }),
      kind,
      text,
    })),
    angle: row.angle ?? null,
    nextBestAction: row.nextBestAction ?? null,
  };
}
