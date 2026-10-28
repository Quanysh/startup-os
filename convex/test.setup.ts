import type { TestConvex } from "convex-test";
import type { Id } from "./_generated/dataModel";
import type { StoredArea } from "./lib/roles";
import type schema from "./schema";

// Vite's compile-time glob import, typed here so the tests need no dependency
// on Vite's own type package.
declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

// Every Convex module, for convex-test to resolve function references. The
// two-dot filename keeps Convex itself from bundling this file.
//
// The extensions are every one Convex's bundler deploys (ENTRY_POINT_EXTENSIONS
// in convex/src/bundler/index.ts). The list is also what publicSurface.test.ts
// proves things about: an extension missing here would be deployed unchecked,
// and a test there fails if any file under convex/ is left out.
export const modules = import.meta.glob("./**/!(*.*.*)*.{js,mjs,cjs,ts,tsx,mts,cts,jsx}");

/**
 * Every file under convex/ whatever its extension, never loaded: for the test
 * that proves `modules` leaves no source file out (publicSurface.test.ts).
 */
export const everyFile = import.meta.glob("./**/*");

export const OWNER = "founder@example.test";

/** The in-memory backend a test runs against. */
export type TestBackend = TestConvex<typeof schema>;
type T = TestBackend;

/** Insert a user and return a test client signed in as them. */
export async function signInAs(
  t: T,
  user: { email: string; emailVerificationTime?: number },
) {
  const { userId, sessionId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", user);
    const sessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 24 * 60 * 60 * 1000,
    });
    return { userId, sessionId };
  });
  // Convex Auth's subject is "<userId>|<sessionId>".
  return t.withIdentity({ subject: `${userId}|${sessionId}` });
}

/** A client signed in as the verified owner. Requires OWNER_EMAILS to be stubbed. */
export function signInAsOwner(t: T) {
  return signInAs(t, { email: OWNER, emailVerificationTime: 1 });
}

type Company = "us" | "kz";
type MemberRole = "cofounder" | "sales" | "engineer";
export const BOTH: Company[] = ["us", "kz"];

/** The address a test teammate is given: one per role and set of companies. */
export const memberEmail = (role: MemberRole, companies: readonly Company[] = BOTH) =>
  `${role}.${companies.join("-")}@gmail.com`;

/**
 * Put someone on the team, as `team.add` would, without signing them in.
 * Returns the row's id. `addedBy` is a stand-in user, not a session. With no
 * `areas` the row is one from before pages could be picked: it has its role's.
 */
export async function addMember(
  t: T,
  member: {
    email: string;
    /** A built-in role, or the id of one the owner named. */
    role: MemberRole | Id<"roles">;
    companies?: Company[];
    /**
     * What the row's list holds. A stored area: payroll or costs only to
     * stand for a row from before they were the owner's alone.
     */
    areas?: readonly StoredArea[];
  },
) {
  return await t.run(async (ctx) => {
    const addedBy = await ctx.db.insert("users", {});
    return await ctx.db.insert("members", {
      email: member.email,
      role: member.role,
      companies: member.companies ?? BOTH,
      ...(member.areas === undefined ? {} : { areas: [...member.areas] }),
      addedAt: 1,
      addedBy,
    });
  });
}

/**
 * A client signed in as a verified teammate with a role, on the given
 * companies (both unless said). Pass `email` for a second person in a role,
 * and `areas` for pages the owner picked.
 */
export async function signInAsMember(
  t: T,
  role: MemberRole,
  companies: Company[] = BOTH,
  email: string = memberEmail(role, companies),
  areas?: readonly StoredArea[],
) {
  await addMember(t, { email, role, companies, areas });
  return signInAs(t, { email, emailVerificationTime: 1 });
}

/** A verified teammate with the pages the owner picked, whatever their role starts with. */
export const signInWithAreas = (
  t: T,
  role: MemberRole,
  areas: readonly StoredArea[],
  companies: Company[] = BOTH,
) => signInAsMember(t, role, companies, memberEmail(role, companies), areas);

export const signInAsCofounder = (t: T, companies?: Company[]) =>
  signInAsMember(t, "cofounder", companies);
export const signInAsSales = (t: T, companies?: Company[]) =>
  signInAsMember(t, "sales", companies);
export const signInAsEngineer = (t: T, companies?: Company[]) =>
  signInAsMember(t, "engineer", companies);
