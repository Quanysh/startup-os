// Everyone the OS lets in, for the two things that need to look a person up:
// who a task may be assigned to, and how an assignee is shown. Runs only
// inside Convex. A teammate's address and name are personal data: nothing
// here puts one in an error or a log, and what a caller is sent about another
// person is decided by `knows`.

import type { QueryCtx } from "../_generated/server";
import { ownerEmailList } from "../authOwner";
import { companyIds, isCompanyId, type CompanyId } from "./company";
import type { Member } from "./owner";
import { effectiveAreas } from "./roles";

export type Person = {
  /** Lower-cased. */
  email: string;
  companies: readonly CompanyId[];
  /** Holds the board: an owner, or a teammate whose areas include it. */
  board: boolean;
};

/**
 * The one rule for who work may be given to, a task (assignee or mention) or
 * a handoff to a person alike: someone on its company (any of theirs, for a
 * shared task: `company` undefined) who holds the board. Without the board a
 * person can open no page that shows them a task or a handoff (the board,
 * Today's "your tasks" and a notification's link all need it), so work given
 * to them would be work they cannot see.
 */
export function mayTakeWork(person: Person, company: CompanyId | undefined): boolean {
  return person.board && (company === undefined || person.companies.includes(company));
}

/** Owners (both companies) and teammates, by lower-cased address. */
export async function teamDirectory(db: QueryCtx["db"]): Promise<Map<string, Person>> {
  const people = new Map<string, Person>();
  for (const email of ownerEmailList()) people.set(email, { email, companies: companyIds(), board: true });
  // At most MAX_MEMBERS rows: `team.add` refuses more.
  for (const row of await db.query("members").collect()) {
    // An owner's address is the owner, whatever a row says.
    if (people.has(row.email)) continue;
    people.set(row.email, {
      email: row.email,
      companies: row.companies.filter(isCompanyId),
      board: effectiveAreas(row.role, row.areas).includes("board"),
    });
  }
  return people;
}

/**
 * Whether a caller may be told who a person is: they share a company. The
 * owner is on both, so the owner knows everyone and everyone knows the owner.
 */
export function knows(member: Member, person: Pick<Person, "companies"> & { email?: string }): boolean {
  return person.companies.some((company) => member.companies.includes(company));
}

/** The name a person signed in with, or null before their first sign-in. */
export async function nameOf(db: QueryCtx["db"], email: string): Promise<string | null> {
  const user = await db
    .query("users")
    .withIndex("email", (q) => q.eq("email", email))
    .first();
  return user?.name ?? null;
}

/**
 * The people this person may name, as an address and a name and nothing
 * else: the owner, and the teammates who share a company with them; given a
 * company, only those on it. With `work`, only those a task may be given to
 * (`mayTakeWork`: who hold the board): what `team.assignable` returns and
 * what the owner's agent reads (convex/lib/mcpTools.ts), one function.
 * Without it, anyone (a decision's owner, a meeting's teammates, a post's
 * author). In address order. The caller checks the company is one of the
 * person's own.
 */
export async function assignablePeople(
  ctx: QueryCtx,
  member: Member,
  company?: CompanyId,
  options: { work?: boolean } = {},
) {
  const people = [];
  for (const person of (await teamDirectory(ctx.db)).values()) {
    if (!knows(member, person)) continue;
    if (company !== undefined && !person.companies.includes(company)) continue;
    if (options.work === true && !mayTakeWork(person, company)) continue;
    people.push({ email: person.email, name: await nameOf(ctx.db, person.email) });
  }
  return people.sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
}
