// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { QuietCards } from "@/lib/pipeline/derive";
import { QuietTile } from "./quiet-tile";

afterEach(cleanup);

const show = (quiet: QuietCards) =>
  render(
    <QuietTile
      quiet={quiet}
      limitDays={14}
      one="open deal"
      many="open deals"
      nobody="There are no open deals."
    />,
  );
const quietOnes = (...days: number[]) => days.map((d, i) => ({ id: `q${i}`, name: "n", days: d }));

describe("QuietTile", () => {
  test("nothing to judge", () => {
    show({ of: 0, quiet: [], undated: 0 });
    expect(screen.getByText("None")).toBeTruthy();
    expect(screen.getByText("There are no open deals.")).toBeTruthy();
  });

  test("none quiet", () => {
    show({ of: 3, quiet: [], undated: 0 });
    expect(screen.getByText("None")).toBeTruthy();
    expect(screen.getByText("Every open deal had activity in the last 14 days.")).toBeTruthy();
  });

  test("how many, and the longest silence", () => {
    show({ of: 5, quiet: quietOnes(41, 20), undated: 0 });
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("No activity for more than 14 days. Longest: 41 days.")).toBeTruthy();
  });

  test("some undated: the rest are judged and the undated are counted", () => {
    show({ of: 3, quiet: [], undated: 1 });
    expect(screen.getByText("None")).toBeTruthy();
    expect(
      screen.getByText("Every open deal with an activity date had activity in the last 14 days."),
    ).toBeTruthy();
    expect(screen.getByText("1 open deal has no activity date and cannot be judged.")).toBeTruthy();
    cleanup();
    show({ of: 4, quiet: quietOnes(20), undated: 2 });
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("2 open deals have no activity date and cannot be judged.")).toBeTruthy();
  });

  test("all undated: no number at all, not a reassuring None", () => {
    show({ of: 2, quiet: [], undated: 2 });
    expect(screen.getByText("No value yet")).toBeTruthy();
    expect(screen.queryByText("None")).toBeNull();
    expect(
      screen.getByText("None of the 2 open deals has an activity date, so none can be judged."),
    ).toBeTruthy();
  });

  test("one card, undated", () => {
    show({ of: 1, quiet: [], undated: 1 });
    expect(
      screen.getByText("The one open deal has no activity date, so it cannot be judged."),
    ).toBeTruthy();
  });
});
