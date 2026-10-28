import type { Person } from "@convex/lib/mirrorRules";

const SHOWN = 3;

/**
 * Who was there, briefly: "Ada Example, Bo Example and 3 more". Names, or
 * addresses where there is no name; at most three are named. `total` is the
 * full count when the stored list was cut short.
 */
export function peopleLabel(people: readonly Person[], total = people.length): string {
  const named = people
    .map((person) => person.name || person.address)
    .filter((label) => label !== "")
    .slice(0, SHOWN);
  const more = Math.max(total, people.length) - named.length;
  if (named.length === 0) return more > 0 ? `${more} ${more === 1 ? "person" : "people"}` : "";
  return more > 0 ? `${named.join(", ")} and ${more} more` : named.join(", ");
}
