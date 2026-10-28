"use client";

import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import { companyIds, DEFAULT_COMPANY, isCompanyId, type CompanyId } from "@/lib/company";

// The company being looked at. It is a preference of this browser, not data:
// kept in localStorage, never sent to the server. Outside the provider there
// is no company chosen and everything shows, which is what a page rendered on
// its own (in a test) gets.
const KEY = "startup-os:company";
const CHANGED = "startup-os:company-changed";

const CompanyContext = createContext<CompanyId | null>(null);

function read(): CompanyId {
  try {
    const stored = window.localStorage.getItem(KEY);
    return isCompanyId(stored) ? stored : DEFAULT_COMPANY;
  } catch {
    // Storage can be blocked; the default still gives a working page.
    return DEFAULT_COMPANY;
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGED, onChange);
  // Another tab switched.
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function setCompany(company: CompanyId) {
  try {
    window.localStorage.setItem(KEY, company);
  } catch {
    // Not remembered, then; nothing else depends on it.
  }
  window.dispatchEvent(new Event(CHANGED));
}

/**
 * `allowed` is the companies the viewer is on. A stored choice outside it is
 * ignored, so someone on one company is shown that company whatever this
 * browser remembers from another account.
 */
export function CompanyProvider({
  allowed = companyIds(),
  children,
}: {
  allowed?: readonly CompanyId[];
  children: ReactNode;
}) {
  const stored = useSyncExternalStore(subscribe, read, () => DEFAULT_COMPANY);
  const company = allowed.includes(stored) ? stored : (allowed[0] ?? DEFAULT_COMPANY);
  return <CompanyContext.Provider value={company}>{children}</CompanyContext.Provider>;
}

/** The chosen company, or null where none is (everything is then in view). */
export function useCompany(): CompanyId | null {
  return useContext(CompanyContext);
}
