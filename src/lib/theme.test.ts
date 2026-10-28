// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import {
  DARK_QUERY,
  THEME_COLORS,
  THEME_KEY,
  THEME_SCRIPT,
  applyTheme,
  choiceOf,
  resolveTheme,
} from "./theme";

const STORED = [null, "light", "dark", "system", "", "Dark", "blue", "{}", "null"];

// What React has put in <head> by the time the script runs: nothing of ours.
function setMetas() {
  document.head.innerHTML = '<meta name="viewport" content="width=device-width, initial-scale=1">';
}

/** What the page looks like to a theme: the class, the scheme, the bar's metas in order. */
function state() {
  const root = document.documentElement;
  return {
    dark: root.classList.contains("dark"),
    scheme: root.style.colorScheme,
    bars: [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute("content")),
  };
}

function reset() {
  document.documentElement.className = "font-a font-b";
  document.documentElement.removeAttribute("style");
  window.localStorage.clear();
  setMetas();
}

function systemIs(dark: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query === DARK_QUERY ? dark : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

/** Runs the inline script's own text, as the browser would in `<head>`. */
const runScript = () => new Function(THEME_SCRIPT)();

afterEach(reset);

describe("resolveTheme", () => {
  test("with nothing stored it follows the system", () => {
    expect(resolveTheme(null, false)).toBe("light");
    expect(resolveTheme(null, true)).toBe("dark");
  });

  test("a stored choice wins over the system", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  test("System stored is the system's", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  test.each(["", "Dark", "blue", "{}", 3, undefined])("a value that is no choice falls back to System: %s", (bad) => {
    expect(choiceOf(bad)).toBe("system");
    expect(resolveTheme(bad, true)).toBe("dark");
    expect(resolveTheme(bad, false)).toBe("light");
  });
});

describe("applyTheme", () => {
  test("dark: the class and color-scheme on <html>, other classes kept", () => {
    reset();
    applyTheme(document, "dark", false);
    expect(document.documentElement.className).toBe("font-a font-b dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  test("light takes the class off again", () => {
    reset();
    applyTheme(document, "dark", false);
    applyTheme(document, "light", true);
    expect(document.documentElement.className).toBe("font-a font-b");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  test("the browser's bar is one meta, made once and changed in place", () => {
    reset();
    applyTheme(document, "dark", false);
    expect(state().bars).toEqual([THEME_COLORS.dark]);
    applyTheme(document, "light", true);
    expect(state().bars).toEqual([THEME_COLORS.light]);
    applyTheme(document, "system", true);
    expect(state().bars).toEqual([THEME_COLORS.dark]);
    applyTheme(document, null, false);
    expect(state().bars).toEqual([THEME_COLORS.light]);
  });

  test("nothing else in <head> is touched", () => {
    reset();
    applyTheme(document, "dark", false);
    expect(document.head.querySelector('meta[name="viewport"]')?.getAttribute("content")).toBe(
      "width=device-width, initial-scale=1",
    );
    expect(document.head.children).toHaveLength(2);
  });
});

describe("the pre-paint script", () => {
  test("is one fixed expression with nothing interpolated at run time", () => {
    expect(THEME_SCRIPT).toMatch(/^\(function\(\)\{.*\}\)\(\)$/);
    expect(THEME_SCRIPT).toContain(JSON.stringify(THEME_KEY));
    expect(THEME_SCRIPT).not.toMatch(/<\/?script|<!--/i);
  });

  test.each(STORED.flatMap((stored) => [false, true].map((dark) => [stored, dark] as const)))(
    "does what applyTheme does: stored %j, system dark %j",
    (stored, dark) => {
      reset();
      systemIs(dark);
      applyTheme(document, stored, dark);
      const expected = state();

      reset();
      if (stored !== null) window.localStorage.setItem(THEME_KEY, stored);
      runScript();
      expect(state()).toEqual(expected);
    },
  );

  test("run again (a page restored from the back-forward cache), it makes no second meta", () => {
    reset();
    systemIs(true);
    runScript();
    runScript();
    expect(state()).toEqual({ dark: true, scheme: "dark", bars: [THEME_COLORS.dark] });
  });

  test("storage that throws is the same as nothing stored", () => {
    reset();
    systemIs(true);
    const real = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      runScript();
    } finally {
      Object.defineProperty(window, "localStorage", real);
    }
    expect(state().dark).toBe(true);
  });

  test("a browser with no matchMedia is left light, and nothing is thrown", () => {
    reset();
    // @ts-expect-error: the old browser this test stands for has none.
    delete window.matchMedia;
    expect(runScript).not.toThrow();
    expect(state().dark).toBe(false);
  });
});
