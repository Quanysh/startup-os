// Who a standup task is for and which company it is, worked out from what the
// daily session sends (convex/standup.ts): a person's name as it was said,
// and the task's own title and context. Pure, so the rules are tested here.
//
// A name is matched to a teammate (`people`): exactly first, then at a
// similarity of 0.9 or more, and never when two people fit equally. A company
// is read off the names the OS already holds (clinics, deals, repositories)
// and the companies' own words; when neither decides it the task is shared
// and flagged, never guessed. Nothing here keeps or logs a name or a title.

import type { CompanyId } from "./company";

/** A teammate as the match sees them: the address, the name they signed in with (or null), their companies. */
export type NamedPerson = { email: string; name: string | null; companies: readonly CompanyId[] };
/** A clinic, deal or repository the OS holds, with its company. */
export type CompanyEntity = { name: string; company: CompanyId };

/** The similarity a near spelling must reach to count as the same name. */
export const FUZZY_MATCH = 0.9;
/** A name shorter than this (once normalised) tells nothing. */
const MIN_NAME = 2;
/** An entity's name shorter than this is too common a word to decide a company. */
const MIN_ENTITY = 4;

// Russian and Kazakh letters as Latin ones, so "Константин" is "konstantin".
const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "i",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  ә: "a", ғ: "g", қ: "k", ң: "n", ө: "o", ұ: "u", ү: "u", һ: "h", і: "i",
};

/** Lower case, Latin letters, no accents, punctuation as spaces: "Léna S." is "lena s". */
export function nameKey(text: string): string {
  return [...text.toLowerCase()]
    .map((char) => CYRILLIC[char] ?? char)
    .join("")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/['’‘`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Jaro-Winkler similarity of two keys: 1 is the same, 0 nothing alike. */
export function similarity(a: string, b: string): number {
  if (a === b) return a === "" ? 0 : 1;
  if (a === "" || b === "") return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aHit = new Array<boolean>(a.length).fill(false);
  const bHit = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = Math.max(0, i - window); j < Math.min(b.length, i + window + 1); j += 1) {
      if (bHit[j] || a[i] !== b[j]) continue;
      aHit[i] = true;
      bHit[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;
  let k = 0;
  let swaps = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!aHit[i]) continue;
    while (!bHit[k]) k += 1;
    if (a[i] !== b[k]) swaps += 1;
    k += 1;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - swaps / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] !== undefined && a[prefix] === b[prefix]) prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** The names a person answers to: their full name, its first word, and their address's own part. */
function keysOf(person: NamedPerson): string[] {
  const keys = new Set<string>();
  const full = nameKey(person.name ?? "");
  if (full !== "") {
    keys.add(full);
    keys.add(full.split(" ")[0]!);
  }
  const local = nameKey((person.email.split("@")[0] ?? "").replace(/\d+/g, " "));
  if (local !== "") {
    keys.add(local);
    keys.add(local.split(" ")[0]!);
  }
  return [...keys].filter((key) => key.length >= MIN_NAME);
}

/**
 * The address of the one teammate a name said in the meeting is: an exact
 * match first (a trailing initial, "Lena S.", is read as "Lena"), then the
 * nearest at `FUZZY_MATCH` or above. Two people who fit equally well, or
 * nobody near enough, is null: a card is left unassigned rather than given
 * to the wrong person.
 */
export function matchPerson(said: string | undefined, people: readonly NamedPerson[]): string | null {
  const full = nameKey(said ?? "");
  if (full.length < MIN_NAME) return null;
  const words = full.split(" ");
  const asked = new Set([full]);
  // "lena s": the name without its trailing initial.
  if (words.length > 1 && words[words.length - 1]!.length === 1) asked.add(words.slice(0, -1).join(" "));

  const exact = people.filter((person) => keysOf(person).some((key) => asked.has(key)));
  if (exact.length === 1) return exact[0]!.email;
  if (exact.length > 1) {
    // Several answer to a first name; the one whose full name it is wins.
    const whole = exact.filter((person) => asked.has(nameKey(person.name ?? "")));
    return whole.length === 1 ? whole[0]!.email : null;
  }

  let best: { email: string; score: number } | null = null;
  let tied = false;
  for (const person of people) {
    const score = Math.max(
      ...keysOf(person).flatMap((key) => [...asked].map((name) => similarity(name, key))),
      0,
    );
    if (score < FUZZY_MATCH) continue;
    if (best === null || score > best.score) {
      best = { email: person.email, score };
      tied = false;
    } else if (score === best.score) {
      tied = true;
    }
  }
  return best === null || tied ? null : best.email;
}

// The companies' own words (docs/setup.md, "Which company"), as keys.
const COMPANY_WORDS: Record<CompanyId, readonly string[]> = {
  kz: [
    "globex", "globex kz", "globex ai", "kz crm", "tenge", "kzt", "kaspi", "halyk", "kazakhstan",
    "almaty", "astana", "globex", "egov", "damumed",
  ],
  us: [
    "startup insights", "vertical startup", "startup atlas", "payer", "payers", "cpt", "npi", "icd",
    "hipaa", "baa", "medicare", "medicaid", "athena", "athenahealth", "eclinicalworks", "ecw",
    "mercury", "investor", "investors", "fundraising", "pre seed", "delaware", "denial", "denials",
    "prior auth",
  ],
};
const NAME_WEIGHT = 2;

/**
 * The company a task's text belongs to, or null when it does not say: each
 * clinic, deal or repository the OS holds that the text names counts twice,
 * each of the companies' own words once, and the company with more wins. An
 * even split, or nothing at all, is null.
 */
export function classifyCompany(text: string, entities: readonly CompanyEntity[]): CompanyId | null {
  const padded = ` ${nameKey(text)} `;
  const score: Record<CompanyId, number> = { us: 0, kz: 0 };
  const seen = new Set<string>();
  for (const entity of entities) {
    const key = nameKey(entity.name);
    if (key.length < MIN_ENTITY || seen.has(`${entity.company}:${key}`)) continue;
    seen.add(`${entity.company}:${key}`);
    if (padded.includes(` ${key} `)) score[entity.company] += NAME_WEIGHT;
  }
  for (const company of ["us", "kz"] as const) {
    for (const word of COMPANY_WORDS[company]) {
      if (padded.includes(` ${word} `)) score[company] += 1;
    }
  }
  if (score.us === score.kz) return null;
  return score.us > score.kz ? "us" : "kz";
}
