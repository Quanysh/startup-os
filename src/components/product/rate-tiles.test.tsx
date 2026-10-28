// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { Rate } from "@/lib/metrics/product";
import { ActivationTile, VisitorSignupTile } from "./rate-tiles";

afterEach(cleanup);

const tile = (label: string) =>
  within(screen.getByRole("heading", { name: label }).closest("article")!);
const VERDICT = /typical for seed/i;

const activation = (patch: Partial<Extract<Rate, { kind: "value" }>> = {}): Rate => ({
  kind: "value",
  percent: 40,
  numerator: 16,
  denominator: 40,
  from: "2026-09-07",
  to: "2026-09-28",
  weeks: 4,
  expected: 4,
  ...patch,
});
const conversion = (patch: Partial<Extract<Rate, { kind: "value" }>> = {}): Rate => ({
  kind: "value",
  percent: 3.9,
  numerator: 39,
  denominator: 1_000,
  from: "2026-09-14",
  to: "2026-10-05",
  weeks: 4,
  expected: 4,
  ...patch,
});

describe("Activation rate", () => {
  test("the rate, what it is made of, and the seed benchmark", () => {
    render(<ActivationTile rate={activation()} />);
    const t = tile("Activation rate");
    expect(t.getByText("40%")).toBeTruthy();
    expect(t.getByText(VERDICT)).toBeTruthy();
    expect(
      t.getByText(
        "16 of 40 signups ran a search within 7 days of signing up. Signups of Sep 7–Oct 4.",
      ),
    ).toBeTruthy();
    expect(t.queryByText(/weeks\. The rest are not complete\./)).toBeNull();
  });

  test("with few signups there is a number but no verdict", () => {
    render(<ActivationTile rate={activation({ percent: 37.5, numerator: 3, denominator: 8 })} />);
    const t = tile("Activation rate");
    expect(t.getByText("37.5%")).toBeTruthy();
    expect(t.getByText("Fewer than 20 signups, so no benchmark verdict yet.")).toBeTruthy();
    expect(t.queryByText(VERDICT)).toBeNull();
  });

  test("exactly twenty signups is enough for a verdict", () => {
    render(<ActivationTile rate={activation({ percent: 30, numerator: 6, denominator: 20 })} />);
    expect(tile("Activation rate").getByText(VERDICT)).toBeTruthy();
  });

  test("fewer weeks than asked for is said", () => {
    render(<ActivationTile rate={activation({ weeks: 3 })} />);
    expect(
      tile("Activation rate").getByText("3 of the last 4 weeks. The rest are not complete."),
    ).toBeTruthy();
  });

  test("before PostHog's first sync", () => {
    render(<ActivationTile rate={{ kind: "none", reason: "no_data" }} />);
    const t = tile("Activation rate");
    expect(t.getByText("No value yet")).toBeTruthy();
    expect(t.getByText("Arrives with PostHog's first sync.")).toBeTruthy();
  });

  test("before any week of signups has settled", () => {
    render(<ActivationTile rate={{ kind: "none", reason: "no_complete_week" }} />);
    expect(
      tile("Activation rate").getByText(
        "Appears once a week of signups has had seven days to activate.",
      ),
    ).toBeTruthy();
  });

  test("no signups is said in words, not shown as 0%", () => {
    render(<ActivationTile rate={{ kind: "empty", from: "2026-09-07", to: "2026-09-28" }} />);
    const t = tile("Activation rate");
    expect(t.getByText("No signups")).toBeTruthy();
    expect(t.getByText("Nobody signed up in the weeks of Sep 7–Oct 4.")).toBeTruthy();
    expect(t.queryByText("0%")).toBeNull();
  });

  test("figures that disagree give no rate", () => {
    render(
      <ActivationTile
        rate={{ kind: "impossible", numerator: 9, denominator: 4, from: "2026-09-07", to: "2026-09-28" }}
      />,
    );
    const t = tile("Activation rate");
    expect(t.getByText("No value yet")).toBeTruthy();
    expect(
      t.getByText(
        "More activated signups than signups are stored for Sep 7–Oct 4, so there is no rate to show.",
      ),
    ).toBeTruthy();
  });
});

describe("Visitor to signup", () => {
  test("the rate, what it is made of, and the benchmark", () => {
    render(<VisitorSignupTile rate={conversion()} />);
    const t = tile("Visitor to signup");
    expect(t.getByText("3.9%")).toBeTruthy();
    expect(t.getByText(VERDICT)).toBeTruthy();
    expect(
      t.getByText(
        "39 signups against 1,000 weekly visitors (a returning visitor is counted each week). Weeks of Sep 14–Oct 11.",
      ),
    ).toBeTruthy();
    // The sum of four weeks' visitors is not a count of people.
    expect(t.queryByText(/from 1,000 visitors/)).toBeNull();
  });

  test("with few visitors there is a number but no verdict", () => {
    render(<VisitorSignupTile rate={conversion({ percent: 4, numerator: 6, denominator: 150 })} />);
    const t = tile("Visitor to signup");
    expect(t.getByText("4%")).toBeTruthy();
    expect(t.getByText("Fewer than 200 weekly visitors, so no benchmark verdict yet.")).toBeTruthy();
    expect(t.queryByText(VERDICT)).toBeNull();
  });

  test("fewer weeks than asked for is said", () => {
    render(<VisitorSignupTile rate={conversion({ weeks: 2 })} />);
    expect(
      tile("Visitor to signup").getByText("2 of the last 4 weeks. The rest are not complete."),
    ).toBeTruthy();
  });

  test("before PostHog's first sync, and before a full week", () => {
    const { unmount } = render(<VisitorSignupTile rate={{ kind: "none", reason: "no_data" }} />);
    expect(tile("Visitor to signup").getByText("Arrives with PostHog's first sync.")).toBeTruthy();
    unmount();
    render(<VisitorSignupTile rate={{ kind: "none", reason: "no_complete_week" }} />);
    expect(tile("Visitor to signup").getByText("Appears once a full week has been read.")).toBeTruthy();
  });

  test("no visitors is said in words", () => {
    render(<VisitorSignupTile rate={{ kind: "empty", from: "2026-09-14", to: "2026-10-05" }} />);
    const t = tile("Visitor to signup");
    expect(t.getByText("No visitors")).toBeTruthy();
    expect(t.getByText("No visits were recorded in Sep 14–Oct 11.")).toBeTruthy();
  });

  test("more signups than visitors gives no rate, and says why", () => {
    render(
      <VisitorSignupTile
        rate={{ kind: "impossible", numerator: 12, denominator: 9, from: "2026-09-14", to: "2026-10-05" }}
      />,
    );
    const t = tile("Visitor to signup");
    expect(t.getByText("No value yet")).toBeTruthy();
    expect(
      t.getByText(
        "12 signups against 9 weekly visitors in Sep 14–Oct 11: visits are being missed, so there is no rate to show.",
      ),
    ).toBeTruthy();
  });
});
