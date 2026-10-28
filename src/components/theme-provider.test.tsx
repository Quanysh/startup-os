// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DARK_QUERY, THEME_COLORS, THEME_KEY } from "@/lib/theme";
import { ThemeProvider, ThemeSwitch, useTheme } from "./theme-provider";

// A system setting the test can change, with the listeners the provider adds.
let systemDark = false;
const listeners = new Set<() => void>();
function setSystem(dark: boolean) {
  systemDark = dark;
  act(() => listeners.forEach((listener) => listener()));
}

beforeEach(() => {
  systemDark = false;
  listeners.clear();
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query === DARK_QUERY && systemDark;
    },
    media: query,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  })) as unknown as typeof window.matchMedia;
  document.head.innerHTML = "";
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
});

const root = () => document.documentElement;
const bars = () =>
  [...document.querySelectorAll('meta[name="theme-color"]')].map((meta) => meta.getAttribute("content"));

function Seen() {
  const { choice, theme } = useTheme();
  return <p data-testid="seen">{`${choice}/${theme}`}</p>;
}
const show = () =>
  render(
    <ThemeProvider>
      <Seen />
      <ThemeSwitch />
    </ThemeProvider>,
  );
const seen = () => screen.getByTestId("seen").textContent;
const pressed = () =>
  screen
    .getAllByRole("button")
    .filter((button) => button.getAttribute("aria-pressed") === "true")
    .map((button) => button.getAttribute("aria-label"));

describe("ThemeProvider", () => {
  test("with nothing stored the choice is System, and the system's light is shown", () => {
    show();
    expect(seen()).toBe("system/light");
    expect(root().classList.contains("dark")).toBe(false);
    expect(root().style.colorScheme).toBe("light");
  });

  test("System follows a dark system", () => {
    systemDark = true;
    show();
    expect(seen()).toBe("system/dark");
    expect(root().classList.contains("dark")).toBe(true);
    expect(root().style.colorScheme).toBe("dark");
  });

  test("System changes live when the system does", () => {
    show();
    setSystem(true);
    expect(seen()).toBe("system/dark");
    expect(root().classList.contains("dark")).toBe(true);
    setSystem(false);
    expect(root().classList.contains("dark")).toBe(false);
    expect(root().style.colorScheme).toBe("light");
  });

  test("a stored choice wins over the system", () => {
    systemDark = true;
    window.localStorage.setItem(THEME_KEY, "light");
    show();
    expect(seen()).toBe("light/light");
    expect(root().classList.contains("dark")).toBe(false);
  });

  test("a system change does not move someone who chose", () => {
    window.localStorage.setItem(THEME_KEY, "dark");
    show();
    expect(root().classList.contains("dark")).toBe(true);
    setSystem(true);
    setSystem(false);
    expect(seen()).toBe("dark/dark");
    expect(root().classList.contains("dark")).toBe(true);
    expect(root().style.colorScheme).toBe("dark");
  });

  test.each(["", "blue", "DARK", "{}"])("a stored value that is no choice falls back to System: %j", (bad) => {
    systemDark = true;
    window.localStorage.setItem(THEME_KEY, bad);
    show();
    expect(seen()).toBe("system/dark");
  });

  test("the class it sets leaves the fonts' classes on <html> alone", () => {
    root().className = "font-a font-b";
    window.localStorage.setItem(THEME_KEY, "dark");
    show();
    expect(root().className).toBe("font-a font-b dark");
  });

  test("another tab's choice arrives here", () => {
    show();
    window.localStorage.setItem(THEME_KEY, "dark");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: THEME_KEY }));
    });
    expect(root().classList.contains("dark")).toBe(true);
  });

  test("the browser's bar (one theme-color meta) follows the choice, and the system on System", async () => {
    show();
    expect(bars()).toEqual([THEME_COLORS.light]);
    await userEvent.click(screen.getByRole("button", { name: "Dark" }));
    expect(bars()).toEqual([THEME_COLORS.dark]);
    await userEvent.click(screen.getByRole("button", { name: "System" }));
    expect(bars()).toEqual([THEME_COLORS.light]);
    setSystem(true);
    expect(bars()).toEqual([THEME_COLORS.dark]);
  });
});

describe("ThemeSwitch", () => {
  test("three choices in one named group, each with a name of its own, System pressed first", () => {
    show();
    const group = screen.getByRole("group", { name: "Theme" });
    expect([...group.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"))).toEqual([
      "Light",
      "Dark",
      "System",
    ]);
    expect(pressed()).toEqual(["System"]);
  });

  test("choosing Dark shows it at once and remembers it in this browser", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: "Dark" }));
    expect(pressed()).toEqual(["Dark"]);
    expect(root().classList.contains("dark")).toBe(true);
    expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");
  });

  test("choosing Light on a dark system stays light", async () => {
    systemDark = true;
    show();
    await userEvent.click(screen.getByRole("button", { name: "Light" }));
    expect(pressed()).toEqual(["Light"]);
    expect(root().classList.contains("dark")).toBe(false);
    expect(window.localStorage.getItem(THEME_KEY)).toBe("light");
  });

  test("back to System is stored as System and follows the system again", async () => {
    systemDark = true;
    window.localStorage.setItem(THEME_KEY, "light");
    show();
    await userEvent.click(screen.getByRole("button", { name: "System" }));
    expect(window.localStorage.getItem(THEME_KEY)).toBe("system");
    expect(root().classList.contains("dark")).toBe(true);
  });

  test("it works with the keyboard", async () => {
    show();
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Light" }));
    await user.tab();
    await user.keyboard("{Enter}");
    expect(pressed()).toEqual(["Dark"]);
  });

  test("on its own, outside the provider, it still shows and stores the choice", async () => {
    render(<ThemeSwitch />);
    await userEvent.click(screen.getByRole("button", { name: "Dark" }));
    expect(pressed()).toEqual(["Dark"]);
    expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");
  });
});
