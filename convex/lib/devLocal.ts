// What "a local development backend" means, for the three developer commands
// (`pnpm dev:local`, `dev:seed`, `dev:signin`; scripts/dev/) and for the
// internal functions they call (convex/devSeed.ts, convex/devSession.ts).
//
// Those functions wipe tables and mint sessions, so they are checked twice:
// the scripts refuse to start against anything but a local deployment
// (scripts/dev/guard.ts), and the functions themselves refuse to run anywhere
// else, whoever calls them and however. Pure, so both sides use the same test.

/** The one owner address a local backend has. `.test` is reserved: no mail goes there. */
export const LOCAL_OWNER_EMAIL = "owner@startup-os.test";
/** The domain every made-up local person's address is on. */
export const LOCAL_DOMAIN = "startup-os.test";

export const NOT_LOCAL = "This only runs on a local development backend.";

/**
 * Whether a URL is this machine's own: plain http to exactly `127.0.0.1` or
 * `localhost`, with no user name in it. A name that merely starts or ends
 * with one of those is another host.
 */
export function isLocalUrl(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
    url.username === "" &&
    url.password === ""
  );
}

/** Whether `CONVEX_DEPLOYMENT` names a backend that runs on this machine. */
export function isLocalDeployment(value: string | null | undefined): boolean {
  return typeof value === "string" && /^(anonymous|local):[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

/**
 * Why a function may not run where it is, or null on a local backend: both of
 * the backend's own addresses are this machine's, and its only owner is the
 * made-up local one. A cloud deployment fails all three.
 */
export function localRefusal(env: {
  cloudUrl: string | undefined;
  siteUrl: string | undefined;
  ownerEmails: string | undefined;
}): string | null {
  const owners = (env.ownerEmails ?? "").split(/[\s,]+/).filter(Boolean);
  const local =
    isLocalUrl(env.cloudUrl) &&
    isLocalUrl(env.siteUrl) &&
    owners.length === 1 &&
    owners[0]!.toLowerCase() === LOCAL_OWNER_EMAIL;
  return local ? null : NOT_LOCAL;
}

/** The backend's own check, read from its environment when a function runs. */
export function refusalHere(): string | null {
  return localRefusal({
    cloudUrl: process.env.CONVEX_CLOUD_URL,
    siteUrl: process.env.CONVEX_SITE_URL,
    ownerEmails: process.env.OWNER_EMAILS,
  });
}

// The owner, the three built-in roles, and two that stand for roles the owner
// named (the seed makes them: "Marketing" and "Customer success"), so a page
// can be looked at as someone whose role has another focus.
export const LOCAL_ROLES = [
  "owner",
  "cofounder",
  "sales",
  "engineer",
  "marketing",
  "success",
] as const;
export type LocalRole = (typeof LOCAL_ROLES)[number];
export const LOCAL_COMPANY_CHOICES = ["us", "kz", "both"] as const;
export type LocalCompanyChoice = (typeof LOCAL_COMPANY_CHOICES)[number];

/** The address of the made-up local person with a role on a set of companies. */
export function localEmail(role: LocalRole, companies: LocalCompanyChoice): string {
  return role === "owner" ? LOCAL_OWNER_EMAIL : `${role}.${companies}@${LOCAL_DOMAIN}`;
}
