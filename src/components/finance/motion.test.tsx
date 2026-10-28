// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { StrictMode } from "react";
import { CountUp, Reveal, forgetCountUps } from "./motion";

const format = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

let frames: FrameRequestCallback[] = [];
const runFrame = (at: number) => {
  const pending = frames;
  frames = [];
  for (const frame of pending) frame(at);
};
const motion = (reduce: boolean) =>
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches: reduce && query.includes("reduce"), media: query })),
  );

beforeEach(() => {
  frames = [];
  forgetCountUps();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(performance, "now").mockReturnValue(0);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CountUp", () => {
  test("counts from zero to the figure once, ending on the exact words", () => {
    motion(false);
    render(<CountUp id="cash" value={1_000} format={format} />);
    const figure = screen.getByTestId("count-up");
    // Before the first frame is painted it starts from nothing.
    expect(figure.textContent).toBe("$0");
    act(() => runFrame(450));
    expect(figure.textContent).not.toBe("$0");
    expect(figure.textContent).not.toBe("$1,000");
    act(() => runFrame(2_000));
    expect(figure.textContent).toBe("$1,000");
    expect(frames).toHaveLength(0);
  });

  test("with reduced motion the figure is there at once, and no frame is asked for", () => {
    motion(true);
    render(<CountUp id="cash" value={1_000} format={format} />);
    expect(screen.getByTestId("count-up").textContent).toBe("$1,000");
    expect(frames).toHaveLength(0);
  });

  test("a page nobody can see shows the figure, not a count stuck at zero", () => {
    motion(false);
    const state = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    render(<CountUp id="cash" value={1_000} format={format} />);
    expect(screen.getByTestId("count-up").textContent).toBe("$1,000");
    expect(frames).toHaveLength(0);
    state.mockRestore();
  });

  test("hidden mid-count, it ends on the figure at once", () => {
    motion(false);
    render(<CountUp id="cash" value={1_000} format={format} />);
    act(() => runFrame(300));
    const state = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(screen.getByTestId("count-up").textContent).toBe("$1,000");
    state.mockRestore();
  });

  test("starved of frames, it lands on the figure on time anyway", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      motion(false);
      render(<CountUp id="cash" value={1_000} format={format} />);
      expect(screen.getByTestId("count-up").textContent).toBe("$0");
      // No frame ever runs.
      act(() => {
        vi.advanceTimersByTime(1_100);
      });
      expect(screen.getByTestId("count-up").textContent).toBe("$1,000");
    } finally {
      vi.useRealTimers();
    }
  });

  test("mounted twice, as React's development mode does, it still counts to the figure", () => {
    motion(false);
    render(
      <StrictMode>
        <CountUp id="cash" value={1_000} format={format} />
      </StrictMode>,
    );
    expect(screen.getByTestId("count-up").textContent).toBe("$0");
    act(() => runFrame(450));
    act(() => runFrame(2_000));
    expect(screen.getByTestId("count-up").textContent).toBe("$1,000");
  });

  test("taken away mid-count, it leaves the figure, and counts again next time", () => {
    motion(false);
    const { unmount } = render(<CountUp id="cash" value={1_000} format={format} />);
    act(() => runFrame(300));
    const figure = screen.getByTestId("count-up");
    unmount();
    expect(figure.textContent).toBe("$1,000");
    render(<CountUp id="cash" value={1_000} format={format} />);
    expect(screen.getByTestId("count-up").textContent).toBe("$0");
  });

  test("once a page: the same figure seen again does not count again", () => {
    motion(false);
    const { unmount } = render(<CountUp id="cash" value={1_000} format={format} />);
    act(() => runFrame(2_000));
    unmount();
    render(<CountUp id="cash" value={1_200} format={format} />);
    expect(screen.getByTestId("count-up").textContent).toBe("$1,200");
    expect(frames).toHaveLength(0);
  });

  test("a new figure mid-count lands on the new figure, not the old", () => {
    motion(false);
    const { rerender } = render(<CountUp id="cash" value={1_000} format={format} />);
    act(() => runFrame(300));
    rerender(<CountUp id="cash" value={2_000} format={format} />);
    act(() => runFrame(3_000));
    expect(screen.getByTestId("count-up").textContent).toBe("$2,000");
  });

  test("reserves the final width, so counting moves nothing beside it", () => {
    motion(false);
    render(<CountUp id="cash" value={1_000} format={format} />);
    expect(screen.getByTestId("count-up").getAttribute("data-final")).toBe("$1,000");
  });
});

describe("Reveal", () => {
  test("rises in only where motion is welcome, after its place in the order", () => {
    render(
      <Reveal order={2}>
        <p>Inside</p>
      </Reveal>,
    );
    const wrapper = screen.getByText("Inside").parentElement!;
    expect(wrapper.className).toContain("motion-safe:animate-rise");
    expect(wrapper.style.animationDelay).toBe("140ms");
  });
});
