// The theme: light, dark, or whatever the system says. Like the company in
// view it is a preference of this browser, kept in localStorage and never
// sent to the server. The colours themselves are in src/styles/globals.css:
// the light values in `@theme` and `:root`, the dark ones under `.dark`.

export const THEME_KEY = "startup-os:theme";
export const THEME_CHOICES = ["light", "dark", "system"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];
export type Theme = "light" | "dark";
export const DEFAULT_THEME: ThemeChoice = "system";

/** The browser's own bar, per theme: the page colour (`--color-page`). */
export const THEME_COLORS: Record<Theme, string> = { light: "#fcfcfc", dark: "#0c1219" };

export const DARK_QUERY = "(prefers-color-scheme: dark)";

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === "string" && (THEME_CHOICES as readonly string[]).includes(value);
}

/** What was stored, or System when nothing readable was. */
export function choiceOf(stored: unknown): ThemeChoice {
  return isThemeChoice(stored) ? stored : DEFAULT_THEME;
}

/** The theme to show: the stored choice, or the system's when there is none (or "system"). */
export function resolveTheme(stored: unknown, systemDark: boolean): Theme {
  const choice = choiceOf(stored);
  if (choice === "system") return systemDark ? "dark" : "light";
  return choice;
}

/**
 * Puts a theme on the page: the `dark` class and `color-scheme` on `<html>`
 * (so native controls and scrollbars follow), and the browser's bar.
 *
 * The bar is one `<meta name="theme-color">` made here, not by React, holding
 * the colour of the theme in view. It is not rendered from the layout's
 * `viewport` on purpose: React keeps the metas it renders, matches them by
 * name and content alone, and so adds a second when one is changed and can
 * take one made here for its own. With none of React's there is nothing to
 * collide with.
 */
export function applyTheme(doc: Document, stored: unknown, systemDark: boolean): void {
  const theme = resolveTheme(stored, systemDark);
  const root = doc.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
  let meta = doc.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = doc.createElement("meta");
    meta.setAttribute("name", "theme-color");
    doc.head.appendChild(meta);
  }
  meta.setAttribute("content", THEME_COLORS[theme]);
}

/**
 * The same, as the text of the one inline script in the root layout's
 * `<head>`: it runs before first paint, so a page never flashes the wrong
 * theme. It is a fixed string (nothing from a request or from storage is
 * written into it), so its SHA-256 can be pinned in a Content-Security-Policy
 * (`THEME_SCRIPT_SHA256` in `src/lib/theme-hash.ts`). It must do exactly what `applyTheme` does:
 * `src/lib/theme.test.ts` runs this text against every stored value and both
 * system settings and compares the two.
 */
export const THEME_SCRIPT =
  `(function(){try{var d=document,r=d.documentElement,s=null;` +
  `try{s=localStorage.getItem(${JSON.stringify(THEME_KEY)})}catch(e){}` +
  `var f=s==="light"||s==="dark",` +
  `k=f?s==="dark":matchMedia(${JSON.stringify(DARK_QUERY)}).matches,` +
  `m=d.querySelector('meta[name="theme-color"]');` +
  `r.classList.toggle("dark",k);r.style.colorScheme=k?"dark":"light";` +
  `if(!m){m=d.createElement("meta");m.setAttribute("name","theme-color");d.head.appendChild(m)}` +
  `m.setAttribute("content",k?${JSON.stringify(THEME_COLORS.dark)}:${JSON.stringify(THEME_COLORS.light)})` +
  `}catch(e){}})()`;
