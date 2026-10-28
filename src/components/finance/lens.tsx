"use client";

import { useSyncExternalStore } from "react";
import { COMPANIES, companyIds, type CompanyId } from "@convex/lib/company";
import { cn } from "@/lib/utils";

// Finance shows both companies on one page, whatever the sidebar's company
// switch says: the switch sets every other page. A viewer on both companies
// picks a lens here: the group (both, in US dollars) or one company in its
// own currency. A viewer on one company has that company alone, with no
// group and no lens to pick.
//
// The lens is a preference of this browser tab, not data: kept in
// sessionStorage so the Overview and Budget tabs share it, never sent to the
// server. What each lens may show is still the server's to decide.

export type Lens = "group" | CompanyId;

const KEY = "startup-os:finance-lens";
const CHANGED = "startup-os:finance-lens-changed";

/** The lenses a viewer on these companies has: the group first, where there are two. */
export function lensesOf(companies: readonly CompanyId[]): Lens[] {
  const own = companyIds().filter((id) => companies.includes(id));
  return own.length > 1 ? ["group", ...own] : own;
}

export const LENS_LABELS: Record<Lens, string> = {
  group: "Group",
  us: COMPANIES.us.name,
  kz: COMPANIES.kz.name,
};

function read(): string | null {
  try {
    return window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGED, onChange);
  return () => window.removeEventListener(CHANGED, onChange);
}

export function setLens(lens: Lens) {
  try {
    window.sessionStorage.setItem(KEY, lens);
  } catch {
    // Not remembered, then: the page still switches.
  }
  window.dispatchEvent(new Event(CHANGED));
}

/**
 * The lens in use: the one this tab last picked if the viewer has it, else
 * the first they have (the group, for a viewer on both).
 */
export function useLens(lenses: readonly Lens[]): Lens | null {
  const stored = useSyncExternalStore(subscribe, read, () => null);
  if (lenses.length === 0) return null;
  return lenses.find((lens) => lens === stored) ?? lenses[0]!;
}

/** "Group · Startup · Globex": shown only where there is more than one lens. */
export function LensControl({ lenses, lens }: { lenses: readonly Lens[]; lens: Lens }) {
  if (lenses.length < 2) return null;
  return (
    <div role="group" aria-label="Show" className="flex w-fit gap-1 rounded-full bg-surface p-1">
      {lenses.map((each) => (
        <button
          key={each}
          type="button"
          aria-pressed={each === lens}
          onClick={() => setLens(each)}
          className={cn(
            "inline-flex h-8 items-center rounded-full px-4 text-sm font-medium outline-none transition focus-visible:ring-3 focus-visible:ring-ring/50",
            each === lens ? "bg-panel text-ink shadow-soft-sm" : "text-ink-2 hover:text-ink",
          )}
        >
          {LENS_LABELS[each]}
        </button>
      ))}
    </div>
  );
}

/** The one line that says Finance does not follow the sidebar's switch, for a viewer on both companies. */
export const BOTH_COMPANIES_NOTE = "Finance shows both companies; the company switch in the sidebar sets the other pages.";
