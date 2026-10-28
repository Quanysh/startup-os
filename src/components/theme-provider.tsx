"use client";

import { MonitorIcon, MoonIcon, SunIcon, type LucideIcon } from "lucide-react";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import {
  DARK_QUERY,
  DEFAULT_THEME,
  THEME_CHOICES,
  THEME_KEY,
  applyTheme,
  choiceOf,
  resolveTheme,
  type Theme,
  type ThemeChoice,
} from "@/lib/theme";
import { cn } from "@/lib/utils";

// The theme in view. A preference of this browser, like the company
// (company-provider.tsx): localStorage, never the server. The inline script
// in the root layout has already put the right theme on <html> before first
// paint; from then on this keeps it there as the choice or the system changes.
const CHANGED = "startup-os:theme-changed";

function readChoice(): ThemeChoice {
  try {
    return choiceOf(window.localStorage.getItem(THEME_KEY));
  } catch {
    // Storage can be blocked; System still gives a working page.
    return DEFAULT_THEME;
  }
}

function subscribeChoice(onChange: () => void) {
  window.addEventListener(CHANGED, onChange);
  // Another tab chose.
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}

const systemDark = () => window.matchMedia?.(DARK_QUERY).matches ?? false;

function subscribeSystem(onChange: () => void) {
  const query = window.matchMedia?.(DARK_QUERY);
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}

export function setTheme(choice: ThemeChoice) {
  try {
    window.localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Not remembered, then: the page still changes for this visit's reads.
  }
  window.dispatchEvent(new Event(CHANGED));
}

/** The choice made in this browser, and the theme it comes to. */
export function useTheme(): { choice: ThemeChoice; theme: Theme } {
  const choice = useSyncExternalStore(subscribeChoice, readChoice, () => DEFAULT_THEME);
  const dark = useSyncExternalStore(subscribeSystem, systemDark, () => false);
  return { choice, theme: resolveTheme(choice, dark) };
}

/**
 * Keeps `<html>` wearing the theme. The system's setting is read on every
 * render but only counts while the choice is System, so an OS change does not
 * move someone who chose.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const choice = useSyncExternalStore(subscribeChoice, readChoice, () => DEFAULT_THEME);
  const dark = useSyncExternalStore(subscribeSystem, systemDark, () => false);
  useEffect(() => {
    applyTheme(document, choice, dark);
  }, [choice, dark]);
  return <>{children}</>;
}

const LABELS: Record<ThemeChoice, { name: string; icon: LucideIcon }> = {
  light: { name: "Light", icon: SunIcon },
  dark: { name: "Dark", icon: MoonIcon },
  system: { name: "System", icon: MonitorIcon },
};

/** Light, Dark or System: one button each, one pressed. Icons only, each with its name. */
export function ThemeSwitch({ className }: { className?: string }) {
  const { choice } = useTheme();
  return (
    <div
      role="group"
      aria-label="Theme"
      className={cn("inline-flex w-fit gap-0.5 rounded-full bg-page p-0.5 ring-1 ring-line", className)}
    >
      {THEME_CHOICES.map((id) => {
        const { name, icon: Icon } = LABELS[id];
        return (
          <button
            key={id}
            type="button"
            aria-label={name}
            title={name}
            aria-pressed={id === choice}
            onClick={() => setTheme(id)}
            className={cn(
              "inline-flex size-7 items-center justify-center rounded-full text-ink-2 outline-none transition hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50",
              id === choice && "bg-panel text-ink shadow-soft-sm",
            )}
          >
            <Icon aria-hidden className="size-3.5" />
          </button>
        );
      })}
    </div>
  );
}
