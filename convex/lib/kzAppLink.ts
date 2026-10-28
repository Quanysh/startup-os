// How a clinic in Globex's app is matched to its row in Customers by
// name, once: the two are typed by different people, so quotes, punctuation,
// capitals and the legal form ("ТОО", "ГКП на ПХВ") do not count. A name that
// still differs is linked by hand on the clinic's page. Pure, shared with the UI.

import { nameKeyOf } from "./customerShape";

/** Legal forms and their parts, as whole words, lower case. */
const LEGAL_WORDS = new Set(["тоо", "ао", "ип", "гкп", "гккп", "кгп", "кгкп", "ргп", "ргкп", "на", "пхв", "llp", "jsc", "llc"]);

export function appNameKey(name: string): string {
  return nameKeyOf(name)
    .replace(/[«»"'“”„‘’`]/g, " ")
    .replace(/[.,;:()[\]{}!?/\\|–—-]/g, " ")
    .split(/\s+/)
    .filter((word) => word !== "" && !LEGAL_WORDS.has(word))
    .join(" ");
}

/** A clinic's id in Globex's app, as the app's PostHog events carry it. */
export const APP_ORG_ID = /^[A-Za-z0-9_-]{1,64}$/;
