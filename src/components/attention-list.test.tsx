// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { AttentionList } from "./attention-list";

afterEach(cleanup);

describe("AttentionList", () => {
  test("with nothing to act on it says so", () => {
    // One sentence for every kind of item: the list also covers clinics and
    // obligations, so it no longer names what it looked at.
    render(<AttentionList items={[]} />);
    expect(screen.getByText("Nothing right now.")).toBeTruthy();
  });

  test("compact, with nothing to act on it is one line under the same heading, and no panel", () => {
    render(<AttentionList compact items={[]} />);
    const section = screen.getByRole("region", { name: "Needs attention" });
    expect(section.textContent).toBe("Needs attentionNothing right now.");
    expect(section.className).not.toContain("shadow-soft");
    expect(section.className).not.toContain("bg-panel");
  });

  test("a pipeline item links to its board and says what kind of item it is", () => {
    render(
      <AttentionList
        items={[
          {
            id: "quiet-deals:us",
            severity: "stale",
            title: "2 US deals have gone quiet",
            detail: "No activity for more than 14 days. Longest: 41 days.",
            href: "/sales",
          },
        ]}
      />,
    );
    const link = screen.getByRole("link", { name: /2 US deals have gone quiet/ });
    expect(link.getAttribute("href")).toBe("/sales");
    expect(link.textContent).toContain("Stale: ");
    expect(link.textContent).toContain("Longest: 41 days.");
  });
});
