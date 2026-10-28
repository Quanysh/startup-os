// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { useSelection } from "./use-selection";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);

describe("useSelection", () => {
  test("ticks and unticks cards, and clears", () => {
    const { result } = renderHook(() => useSelection(["a", "b", "c"]));
    act(() => result.current.toggle("a"));
    act(() => result.current.toggle("c"));
    expect(result.current.ids).toEqual(["a", "c"]);
    expect(result.current.has("a")).toBe(true);
    act(() => result.current.toggle("a"));
    expect(result.current.ids).toEqual(["c"]);
    act(() => result.current.clear());
    expect(result.current.ids).toEqual([]);
  });

  test("a card no longer on screen is no longer selected", () => {
    const { result, rerender } = renderHook(({ shown }) => useSelection(shown), {
      initialProps: { shown: ["a", "b"] },
    });
    act(() => result.current.toggle("a"));
    act(() => result.current.toggle("b"));
    rerender({ shown: ["b"] });
    expect(result.current.ids).toEqual(["b"]);
    // And it does not come back when the card does.
    rerender({ shown: ["a", "b"] });
    expect(result.current.ids).toEqual(["b"]);
  });

  test("at most 50, and the 51st is refused with a sentence", () => {
    const { result } = renderHook(() => useSelection(ids(60)));
    act(() => {
      for (const id of ids(50)) result.current.toggle(id);
    });
    expect(result.current.ids).toHaveLength(50);
    expect(result.current.notice).toBeNull();
    act(() => result.current.toggle("t55"));
    expect(result.current.ids).toHaveLength(50);
    expect(result.current.has("t55")).toBe(false);
    expect(result.current.notice).toBe("At most 50 cards can be selected at once.");
    act(() => result.current.toggle("t0"));
    expect(result.current.notice).toBeNull();
  });

  test("keep narrows the selection to some of it", () => {
    const { result } = renderHook(() => useSelection(["a", "b", "c"]));
    act(() => {
      result.current.toggle("a");
      result.current.toggle("b");
    });
    act(() => result.current.keep(["b", "c"]));
    expect(result.current.ids).toEqual(["b"]);
  });

  test("another list may hold more, and say what it holds", () => {
    const { result } = renderHook(() => useSelection(ids(120), { max: 100, noun: "deals" }));
    act(() => {
      for (const id of ids(101)) result.current.toggle(id);
    });
    expect(result.current.ids).toHaveLength(100);
    expect(result.current.notice).toBe("At most 100 deals can be selected at once.");
  });

  test("pickAll takes what is given up to the most, and says when it stopped short", () => {
    const { result } = renderHook(() => useSelection(ids(120), { max: 100, noun: "deals" }));
    act(() => result.current.pickAll(ids(3)));
    expect(result.current.ids).toEqual(ids(3));
    expect(result.current.notice).toBeNull();
    act(() => result.current.pickAll(ids(120)));
    expect(result.current.ids).toEqual(ids(100));
    expect(result.current.notice).toBe("At most 100 deals can be selected at once.");
  });
});
