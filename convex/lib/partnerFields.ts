// Cleaning and checking for what is typed into a partner (convex/partnerships.ts).
// Runs only inside Convex. Every refusal is one of the sentences below, never
// the text that was given.

import { ConvexError } from "convex/values";
import { looksLikeContactDetail } from "./dealDetails";
import {
  MAX_NAME_LENGTH,
  MAX_NEXT_STEP_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_PIPELINE_AMOUNT,
} from "./limits";
import {
  MAX_PARTNER_LINKS,
  MAX_PARTNER_LINK_LABEL,
  MAX_PARTNER_OWNER,
  MAX_PARTNER_REFERRALS,
  MAX_PARTNER_ROLE,
  isPartnerStage,
  isPartnerType,
  PARTNER_VALUE_KINDS,
  type PartnerStage,
  type PartnerType,
  type PartnerValueKind,
} from "./partnerStages";
import { cleanName, cleanOptional } from "./pipelineFields";
import { cleanLink } from "./text";

export const PARTNER_NEEDS_NAME = "A partner needs a name.";
export const PARTNER_ON_BOARD = "That partner is already on the board.";
export const PARTNER_GONE = "That partner is no longer on the board.";
export const NOT_A_PARTNER_STAGE = "That is not a stage a partner can be moved to.";
export const NOT_A_PARTNER_TYPE = "That is not a type of partner.";
export const NO_PARTNER_CONTACT_DETAILS =
  "Leave email addresses and phone numbers out: a partner names its contact by name and role only.";
export const BAD_PARTNER_VALUE = "That value is not a number the OS can store.";
export const VALUE_NEEDS_KIND = "Say whether the value counts referrals or revenue.";
export const BAD_PARTNER_DATE = "A date is written like 2026-10-18.";
export const BAD_PARTNER_LINK = "A link must be a full https:// address.";
export const TOO_MANY_PARTNER_LINKS = `A partner has ${MAX_PARTNER_LINKS} links at most.`;

/** A partner's name as two are compared: trimmed, one space, lower case. */
export const normalPartnerName = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/** What is typed for a partner. Null clears an optional field; leaving it out keeps it. */
export type PartnerEdit = {
  name?: string;
  type?: PartnerType;
  stage?: PartnerStage;
  owner?: string | null;
  contact?: string | null;
  contactRole?: string | null;
  value?: number | null;
  valueKind?: PartnerValueKind | null;
  notes?: string | null;
  nextStep?: string | null;
  nextStepOn?: string | null;
  links?: readonly { label: string; url: string }[] | null;
};

/** What a row is patched with. Undefined clears a field. */
export type PartnerPatch = {
  name?: string;
  type?: PartnerType;
  stage?: PartnerStage;
  owner?: string | undefined;
  contact?: string | undefined;
  contactRole?: string | undefined;
  value?: number | undefined;
  valueKind?: PartnerValueKind | undefined;
  notes?: string | undefined;
  nextStep?: string | undefined;
  nextStepOn?: string | undefined;
  links?: { label: string; url: string }[] | undefined;
};

function noContactDetails<T extends string | undefined>(text: T): T {
  if (text !== undefined && looksLikeContactDetail(text)) {
    throw new ConvexError(NO_PARTNER_CONTACT_DETAILS);
  }
  return text;
}

/** Optional text of at most `max`, clearing on null, holding no address or number. */
function plain(text: string | null, max: number, what: string): string | undefined {
  return text === null ? undefined : noContactDetails(cleanOptional(text, max, what));
}

/** A real calendar day written "YYYY-MM-DD". */
export function checkDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match !== null) {
    const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const real = new Date(Date.UTC(year, month - 1, date));
    if (
      real.getUTCFullYear() === year &&
      real.getUTCMonth() === month - 1 &&
      real.getUTCDate() === date
    ) {
      return day;
    }
  }
  throw new ConvexError(BAD_PARTNER_DATE);
}

function cleanLinks(links: readonly { label: string; url: string }[]) {
  if (links.length > MAX_PARTNER_LINKS) throw new ConvexError(TOO_MANY_PARTNER_LINKS);
  const kept: { label: string; url: string }[] = [];
  for (const link of links) {
    let url: string;
    try {
      url = cleanLink(link.url, "A link");
    } catch {
      throw new ConvexError(BAD_PARTNER_LINK);
    }
    const label = noContactDetails(cleanOptional(link.label, MAX_PARTNER_LINK_LABEL, "A link's label"));
    if (!kept.some((one) => one.url === url)) kept.push({ label: label ?? url, url });
  }
  return kept.length === 0 ? undefined : kept;
}

/** A value of the given kind, whole referrals or a money amount, within its bound. */
export function checkValue(value: number, kind: PartnerValueKind): number {
  const bound = kind === "referrals" ? MAX_PARTNER_REFERRALS : MAX_PIPELINE_AMOUNT;
  const whole = kind === "referrals" ? Number.isInteger(value) : Number.isFinite(value);
  if (!whole || value < 0 || value > bound) throw new ConvexError(BAD_PARTNER_VALUE);
  return value;
}

export function checkStage(stage: string): PartnerStage {
  if (!isPartnerStage(stage)) throw new ConvexError(NOT_A_PARTNER_STAGE);
  return stage;
}

/**
 * An edit cleaned: names and text trimmed and bounded, no address or number
 * in any of them, the stage and type among the known ones, the date a real
 * day, the links https. The value is checked against its kind by the caller
 * (`settleValue`), which knows what the row already holds.
 */
export function cleanPartnerEdit(edit: PartnerEdit): PartnerPatch {
  const patch: PartnerPatch = {};
  if (edit.name !== undefined) patch.name = noContactDetails(cleanName(edit.name, PARTNER_NEEDS_NAME.slice(0, -1)));
  if (edit.type !== undefined) {
    if (!isPartnerType(edit.type)) throw new ConvexError(NOT_A_PARTNER_TYPE);
    patch.type = edit.type;
  }
  if (edit.stage !== undefined) patch.stage = checkStage(edit.stage);
  if (edit.owner !== undefined) patch.owner = plain(edit.owner, MAX_PARTNER_OWNER, "That owner");
  if (edit.contact !== undefined) patch.contact = plain(edit.contact, MAX_NAME_LENGTH, "That contact name");
  if (edit.contactRole !== undefined) {
    patch.contactRole = plain(edit.contactRole, MAX_PARTNER_ROLE, "That role");
  }
  if (edit.notes !== undefined) patch.notes = plain(edit.notes, MAX_NOTES_LENGTH, "That note");
  if (edit.nextStep !== undefined) {
    patch.nextStep = plain(edit.nextStep, MAX_NEXT_STEP_LENGTH, "That next step");
  }
  if (edit.nextStepOn !== undefined) {
    patch.nextStepOn = edit.nextStepOn === null ? undefined : checkDay(edit.nextStepOn);
  }
  if (edit.links !== undefined) patch.links = edit.links === null ? undefined : cleanLinks(edit.links);
  return patch;
}

/**
 * The value and its kind a row ends up with, given what it holds and what
 * the edit says: a value always has a kind, clearing the value clears the
 * kind, and the number is held to its kind's bound.
 */
export function settleValue(
  held: { value?: number; valueKind?: PartnerValueKind },
  edit: Pick<PartnerEdit, "value" | "valueKind">,
): { value: number | undefined; valueKind: PartnerValueKind | undefined } | null {
  if (edit.value === undefined && edit.valueKind === undefined) return null;
  if (edit.value === null) return { value: undefined, valueKind: undefined };
  const value = edit.value ?? held.value;
  const kind = edit.valueKind === null ? undefined : (edit.valueKind ?? held.valueKind);
  if (kind !== undefined && !PARTNER_VALUE_KINDS.includes(kind)) throw new ConvexError(BAD_PARTNER_VALUE);
  if (value === undefined) return { value: undefined, valueKind: undefined };
  if (kind === undefined) throw new ConvexError(VALUE_NEEDS_KIND);
  return { value: checkValue(value, kind), valueKind: kind };
}
