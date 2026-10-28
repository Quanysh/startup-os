// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AnimatedBorder } from "./animated-border";
import { AnimatedGrid } from "./animated-grid";
import { SpotlightTracker } from "./spotlight";

afterEach(() => cleanup());

const move = (target: Element, pointerType: string) => {
  const event = new MouseEvent("pointermove", { bubbles: true, clientX: 40, clientY: 25 });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  target.dispatchEvent(event);
};

test("the light follows the pointer on the panel under it, and only there", () => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((run) => {
    run(0);
    return 1;
  });
  render(
    <>
      <SpotlightTracker />
      <section data-testid="panel" className="rounded-card bg-panel">
        <p data-testid="inside">Text</p>
      </section>
      <div data-testid="plain">Not a panel</div>
    </>,
  );
  const panel = screen.getByTestId("panel");
  panel.getBoundingClientRect = () => ({ left: 10, top: 5 }) as DOMRect;
  act(() => move(screen.getByTestId("inside"), "mouse"));
  expect(panel.style.getPropertyValue("--spot-x")).toBe("30px");
  expect(panel.style.getPropertyValue("--spot-y")).toBe("20px");
  // A finger leaves no light behind.
  panel.style.removeProperty("--spot-x");
  act(() => move(screen.getByTestId("inside"), "touch"));
  expect(panel.style.getPropertyValue("--spot-x")).toBe("");
  act(() => move(screen.getByTestId("plain"), "mouse"));
  expect(screen.getByTestId("plain").getAttribute("style")).toBeNull();
});

test("the border's light is decoration: hidden from a screen reader, the content inside it as given", () => {
  render(
    <AnimatedBorder>
      <p>Needs you</p>
    </AnimatedBorder>,
  );
  const light = document.querySelector("[data-slot=animated-border-light]")!;
  expect(light.getAttribute("aria-hidden")).toBe("true");
  expect(light.className).toContain("motion-reduce:animate-none");
  expect(screen.getByText("Needs you")).toBeTruthy();
});

test("the grid is decoration and never takes a click", () => {
  render(<AnimatedGrid data-testid="grid" />);
  const grid = screen.getByTestId("grid");
  expect(grid.getAttribute("aria-hidden")).toBe("true");
  expect(grid.className).toContain("pointer-events-none");
});
