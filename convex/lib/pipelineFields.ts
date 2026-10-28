// Cleaning and checking for what the owner types into a deal or an investor.

import { ConvexError } from "convex/values";
import { isDealPriority, looksLikeContactDetail, type DealPriority } from "./dealDetails";
import {
  MAX_DEAL_SOURCE_LENGTH,
  MAX_DEAL_SOURCES,
  MAX_NAME_LENGTH,
  MAX_NEXT_STEP_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_PIPELINE_AMOUNT,
  MAX_PRACTICE_COUNT,
  MAX_REGION_LENGTH,
} from "./limits";

/** A trimmed, non-empty name within the cap. `needs` finishes "… needs …". */
export function cleanName(name: string, needs: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new ConvexError(`${needs}.`);
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new ConvexError(`That name is too long (${MAX_NAME_LENGTH} characters at most).`);
  }
  return trimmed;
}

/** Trimmed optional text within `max`. Blank comes back as undefined. */
export function cleanOptional(text: string, max: number, what: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length > max) {
    throw new ConvexError(`${what} is too long (${max} characters at most).`);
  }
  return trimmed === "" ? undefined : trimmed;
}

export function checkAmount(amount: number): number {
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_PIPELINE_AMOUNT) {
    throw new ConvexError("That amount is not a number the OS can store.");
  }
  return amount;
}

/** Said when text a deal would store looks like an email address or a phone number. */
export const NO_CONTACT_DETAILS =
  "Leave email addresses and phone numbers out: the only person a deal names is its contact, by name.";

/** A deal's details as a save or an import gives them. Null clears one; leaving it out keeps it. */
export type DealDetailsEdit = {
  priority?: DealPriority | null;
  region?: string | null;
  physicians?: number | null;
  locations?: number | null;
  sources?: readonly string[] | null;
};

/** What a deal is patched with. Undefined clears a field. */
export type DealDetailsPatch = {
  priority?: DealPriority | undefined;
  region?: string | undefined;
  physicians?: number | undefined;
  locations?: number | undefined;
  sources?: string[] | undefined;
};

function checkCount(count: number, what: "physicians" | "locations"): number {
  if (!Number.isInteger(count) || count < 0 || count > MAX_PRACTICE_COUNT) {
    throw new ConvexError(`The number of ${what} must be a whole number the OS can store.`);
  }
  return count;
}

function withoutContactDetails<T extends string | undefined>(text: T): T {
  if (text !== undefined && looksLikeContactDetail(text)) throw new ConvexError(NO_CONTACT_DETAILS);
  return text;
}

function cleanSources(sources: readonly string[]): string[] | undefined {
  if (sources.length > MAX_DEAL_SOURCES) {
    throw new ConvexError(`A deal names ${MAX_DEAL_SOURCES} sources at most.`);
  }
  const kept: string[] = [];
  for (const source of sources) {
    const title = withoutContactDetails(
      cleanOptional(source, MAX_DEAL_SOURCE_LENGTH, "A source's title"),
    );
    if (title !== undefined && !kept.includes(title)) kept.push(title);
  }
  return kept.length === 0 ? undefined : kept;
}

/**
 * A native deal's details, cleaned: the priority one of three, the region
 * trimmed and short, the counts whole and in range, the sources a short list
 * of short titles. No message quotes what was given.
 */
export function cleanDealDetails(edit: DealDetailsEdit): DealDetailsPatch {
  const patch: DealDetailsPatch = {};
  if (edit.priority !== undefined) {
    if (edit.priority !== null && !isDealPriority(edit.priority)) {
      throw new ConvexError("A priority is high, medium or low.");
    }
    patch.priority = edit.priority ?? undefined;
  }
  if (edit.region !== undefined) {
    patch.region =
      edit.region === null
        ? undefined
        : withoutContactDetails(cleanOptional(edit.region, MAX_REGION_LENGTH, "That region"));
  }
  if (edit.physicians !== undefined) {
    patch.physicians =
      edit.physicians === null ? undefined : checkCount(edit.physicians, "physicians");
  }
  if (edit.locations !== undefined) {
    patch.locations = edit.locations === null ? undefined : checkCount(edit.locations, "locations");
  }
  if (edit.sources !== undefined) {
    patch.sources = edit.sources === null ? undefined : cleanSources(edit.sources);
  }
  return patch;
}

// ── A prospect list (deals.importProspects, scripts/import-prospects.ts) ────

/** A row of a prospect list, as `deals.importProspects` takes it. */
export type ProspectRow = {
  name: string;
  contact?: string;
  stage: string;
  nextStep?: string;
  notes?: string;
  priority?: string;
  region?: string;
  physicians?: number;
  locations?: number;
  sources?: string[];
};

/** Where an imported deal may start: nobody has seen a demo of a list. */
export const PROSPECT_STAGES = ["lead", "qualified"] as const;

/** Text an import may store, cleaned as the board cleans it, holding no address or number. */
function prospectText(text: string | undefined, max: number, what: string) {
  if (text === undefined) return undefined;
  return withoutContactDetails(cleanOptional(text, max, what));
}

const DEAL_NAME_NEEDS = "A deal needs a company name";

/**
 * Every row of a prospect list cleaned as a deal typed in on the board is
 * (`createCard` and `editCard`'s cleaning and caps, `cleanDealDetails`), plus
 * a lead or qualified stage and no email address or phone number in the name,
 * contact, next step or notes. A refusal is "Row <n>: " and a fixed sentence,
 * counted from 1: never a value, so it can be printed and logged.
 *
 * Run by the mutation and, before anything is sent, by the script.
 */
export function cleanProspectRows(rows: readonly ProspectRow[]) {
  return rows.map((row, index) => {
    try {
      if (!(PROSPECT_STAGES as readonly string[]).includes(row.stage)) {
        throw new ConvexError("An imported deal starts as a lead or qualified.");
      }
      return {
        name: withoutContactDetails(cleanName(row.name, DEAL_NAME_NEEDS)),
        contact: prospectText(row.contact, MAX_NAME_LENGTH, "That contact name"),
        stage: row.stage,
        nextStep: prospectText(row.nextStep, MAX_NEXT_STEP_LENGTH, "That next step"),
        notes: prospectText(row.notes, MAX_NOTES_LENGTH, "That note"),
        ...cleanDealDetails({
          priority: row.priority as DealPriority | undefined,
          region: row.region,
          physicians: row.physicians,
          locations: row.locations,
          sources: row.sources,
        }),
      };
    } catch (failure) {
      const said =
        failure instanceof ConvexError && typeof failure.data === "string"
          ? failure.data
          : "It could not be read.";
      throw new ConvexError(`Row ${index + 1}: ${said}`);
    }
  });
}
