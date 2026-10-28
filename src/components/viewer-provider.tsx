"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { companyIds, isCompanyId, type CompanyId } from "@convex/lib/company";
import { focusOf, type Focus } from "@convex/lib/focus";
import { AREAS, ROLE_LABELS, type Area, type Role } from "@convex/lib/roles";

// Who is looking, for components that show or hide by area without asking
// the server again. It is what `viewer.me` said, handed down by the app
// layout. This is presentation only: every Convex function checks the caller
// itself, so hiding something here protects nothing.

/** What `viewer.me` returns for someone the OS lets in. */
export type ViewerProfile = {
  role: Role;
  companies: readonly CompanyId[];
  areas: readonly Area[];
  email: string | null;
  name: string | null;
  /** What their role is called. Left out, it is the built-in name for `role`. */
  roleName?: string;
  /** What their Dashboard and Today are arranged for. Left out, it is `role`'s own. */
  focus?: Focus;
};

export type Viewer = ViewerProfile & {
  roleName: string;
  /** Order and emphasis only: what the viewer may see is `can(area)`. */
  focus: Focus;
  isOwner: boolean;
  /** Whether the viewer has an area: one of those the owner gave them (convex/lib/roles.ts). */
  can: (area: Area) => boolean;
};

const withCan = (profile: ViewerProfile): Viewer => ({
  ...profile,
  roleName: profile.roleName ?? ROLE_LABELS[profile.role],
  focus: profile.focus ?? focusOf(profile.role),
  isOwner: profile.role === "owner",
  can: (area) => profile.areas.includes(area),
});

// Outside the provider there is nobody to ask about, and everything shows,
// which is what a page rendered on its own (in a test) gets. The server
// would still refuse whoever is really there.
// Built when asked: the companies are this OS's (`companyIds()`).
const everything = (): Viewer =>
  withCan({
    role: "owner",
    companies: companyIds(),
    areas: AREAS,
    email: null,
    name: null,
  });

const ViewerContext = createContext<Viewer | null>(null);

export function ViewerProvider({
  viewer,
  children,
}: {
  viewer: ViewerProfile;
  children: ReactNode;
}) {
  const { role, areas, email, name, roleName, focus } = viewer;
  // Only companies this OS is run for: in one-company mode, never the second.
  const companies = viewer.companies.filter(isCompanyId);
  // Keyed on what the lists hold: a query result is a new array each time.
  const companyKey = companies.join(",");
  const areaKey = areas.join(",");
  const value = useMemo(
    () => withCan({ role, companies, areas, email, name, roleName, focus }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [role, companyKey, areaKey, email, name, roleName, focus],
  );
  return <ViewerContext.Provider value={value}>{children}</ViewerContext.Provider>;
}

/** The signed-in viewer: `{ role, roleName, focus, companies, areas, can(area), email, name, isOwner }`. */
export function useViewer(): Viewer {
  return useContext(ViewerContext) ?? everything();
}
