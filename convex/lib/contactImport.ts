// Contacts read out of the free text the pipelines already hold: a deal's or
// an investor's `contact` ("Name, Role", "Name — Role", "Name (Role)"). Pure:
// `migrations:contactsFromRecords` is the one caller. A part that looks like
// an email address or a phone number is never kept, and nothing here logs.

import type { CompanyId } from "./company";
import { MAX_CONTACT_TITLE, type ContactCategory } from "./contacts";
import { looksLikeContactDetail } from "./dealDetails";
import { MAX_NAME_LENGTH } from "./limits";

const HIDDEN = /[\u0000-\u001F\u007F​-‏‪-‮⁠-⁯﻿]/g;

// Between a name and a role: a comma, a semicolon, a bar, angle brackets or
// parentheses, an em or en dash, or a hyphen with a space on each side (a
// hyphen inside "Jean-Luc" joins).
const SEPARATOR = /\s*(?:[,;|()<>]|[—–]|\s-\s)\s*/;

const tidy = (value: string) => value.replace(HIDDEN, "").replace(/\s+/g, " ").trim();

/**
 * A person's name, and their role when the text gives one after it. Null when
 * the text names nobody: empty, no letter in the first part, a first part
 * that is an address or a number, or a name over the stored length. Only the
 * first role is kept, cut to the stored length.
 */
export function parseContactText(text: string): { name: string; title?: string } | null {
  const parts = tidy(text)
    .split(SEPARATOR)
    .map(tidy);
  const name = parts[0] ?? "";
  if (name === "" || !/\p{L}/u.test(name) || looksLikeContactDetail(name)) return null;
  if (name.length > MAX_NAME_LENGTH) return null;
  const role = parts.slice(1).find((part) => part !== "");
  if (role === undefined || looksLikeContactDetail(role) || !/\p{L}/u.test(role)) return { name };
  const title = role.length > MAX_CONTACT_TITLE ? role.slice(0, MAX_CONTACT_TITLE).trim() : role;
  return { name, title };
}

/** What a contact read from a record is: an investor's, a US deal's customer, a Kazakhstan deal's clinic. */
export function importCategory(kind: "deal" | "investor", company: CompanyId): ContactCategory {
  if (kind === "investor") return "investor";
  return company === "kz" ? "kz_clinic" : "customer";
}
