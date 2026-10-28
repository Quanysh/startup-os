// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AREAS, GRANTABLE_AREAS, MEMBER_ROLES, SENSITIVE_AREAS, areasOf } from "@convex/lib/roles";
import {
  AREA_PAGES,
  NO_PAGES,
  PAGE_ORDER,
  PageChecks,
  PagesNote,
  SENSITIVE_PAGES,
  emptyFor,
  pageNames,
  payAndCostsNames,
  presetOf,
  sensitiveNames,
} from "./page-checks";

afterEach(cleanup);

describe("the pages the owner can tick", () => {
  test("every area has a page name of its own", () => {
    const names = AREAS.map((area) => AREA_PAGES[area]);
    expect(names.every((name) => name.trim() !== "")).toBe(true);
    expect(new Set(names).size).toBe(AREAS.length);
  });

  test("each area that can be given, once, in the navigation's order", () => {
    expect(PAGE_ORDER).toEqual([
      "scorecard",
      "today",
      "board",
      "review",
      "agents",
      "finance",
      "product",
      "engineering",
      "sales",
      "fundraising",
      "partnerships",
      // No page of its own: ticked after Partnerships, as Goals is after the board.
      "outcomes",
      "contacts",
      "customers",
      "support",
      "compliance",
      "gtm",
      "memory",
    ]);
    // Marketing has no page of its own: it goes with the go-to-market page.
    // The two sensitive areas are ticked in a group of their own; payroll and
    // costs are the owner's alone and have no box.
    expect([...PAGE_ORDER, "marketing", ...SENSITIVE_AREAS].sort()).toEqual(
      [...GRANTABLE_AREAS].sort(),
    );
  });

  test("the sensitive two, each with what it lets the person do", () => {
    expect(SENSITIVE_PAGES).toEqual([
      {
        area: "settings",
        name: "Sources and Telegram",
        description:
          "can change numbers on the dashboard, run sources and change where the bot posts; never sees tokens",
      },
      {
        area: "team",
        name: "Team",
        description:
          "can add and remove people and choose their ordinary pages, within their own companies; cannot give the sensitive pages or change another manager",
      },
    ]);
    expect(SENSITIVE_PAGES.map((page) => page.area)).toEqual([...SENSITIVE_AREAS]);
  });

  test("no role's preset ticks a sensitive page", () => {
    for (const role of MEMBER_ROLES) {
      for (const area of SENSITIVE_AREAS) expect(presetOf(role)).not.toContain(area);
    }
  });

  test("sensitive pages are named apart from the ordinary ones", () => {
    expect(pageNames(["finance", "settings", "team"])).toEqual(["Finance"]);
    expect(sensitiveNames(["finance", "team", "settings"])).toEqual(["Sources and Telegram", "Team"]);
    expect(sensitiveNames(["finance"])).toEqual([]);
  });

  test("payroll and costs are named by neither: nobody is given them", () => {
    expect(pageNames(["finance", "payroll", "costs"])).toEqual(["Finance"]);
    expect(sensitiveNames(["payroll", "costs"])).toEqual([]);
    // Only the record of a change from before names them.
    expect(payAndCostsNames(["costs", "finance", "payroll"])).toEqual([
      "Payroll",
      "Costs: what the company pays for besides pay",
    ]);
  });

  test("names are listed in that order, whatever order the areas came in", () => {
    expect(pageNames(["gtm", "board", "finance"])).toEqual(["Board", "Finance", "Go to market"]);
    expect(pageNames([])).toEqual([]);
  });
});

describe("the Engineering page's checkbox", () => {
  test("it is named for what it holds", () => {
    expect(AREA_PAGES.engineering).toBe(
      "Engineering: pull requests, who owns them and what is stuck",
    );
  });

  test("among the ordinary pages, ticked by the engineer and co-founder presets and not by sales", () => {
    render(<PageChecks value={presetOf("engineer")} onChange={() => {}} />);
    const box = screen.getByRole("checkbox", { name: AREA_PAGES.engineering }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    cleanup();
    expect(presetOf("cofounder")).toContain("engineering");
    render(<PageChecks value={presetOf("sales")} onChange={() => {}} />);
    expect(
      (screen.getByRole("checkbox", { name: AREA_PAGES.engineering }) as HTMLInputElement).checked,
    ).toBe(false);
  });

  test("both companies have engineering, so it is never an empty page", () => {
    expect(emptyFor(["engineering"], ["kz"])).toEqual([]);
    expect(emptyFor(["engineering"], ["us"])).toEqual([]);
  });
});

describe("emptyFor: a ticked page the person's companies have nothing on", () => {
  const all = areasOf("cofounder");

  test("on Globex alone, the pages kept for Startup", () => {
    // Go to market holds the LinkedIn calendar too, which Globex has.
    expect(emptyFor(all, ["kz"])).toEqual(["fundraising"]);
    expect(emptyFor(["fundraising", "finance"], ["kz"])).toEqual(["fundraising"]);
  });

  test("none on Startup, on both, or when the page is not ticked", () => {
    expect(emptyFor(all, ["us"])).toEqual([]);
    expect(emptyFor(all, ["us", "kz"])).toEqual([]);
    expect(emptyFor(["finance", "board"], ["kz"])).toEqual([]);
  });

  test("with no company chosen there is nothing to say yet", () => {
    expect(emptyFor(all, [])).toEqual([]);
  });
});

describe("PageChecks", () => {
  test("for someone who is not the owner the sensitive boxes are read, not changed, and it says who changes them", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PageChecks value={["board", "settings"]} onChange={onChange} sensitiveLocked />);
    const group = screen.getByRole("group", { name: "Sensitive" });
    expect(within(group).getByText("Only the owner changes these.")).toBeTruthy();
    const boxes = within(group).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((box) => [box.checked, box.disabled])).toEqual([
      [true, true],
      [false, true],
    ]);
    for (const box of boxes) await user.click(box);
    expect(onChange).not.toHaveBeenCalled();
    // The ordinary pages are still theirs to tick.
    await user.click(screen.getByRole("checkbox", { name: "Finance" }));
    expect(onChange).toHaveBeenCalledWith(["finance", "board", "settings"]);
  });

  const boxes = () =>
    within(screen.getByRole("group", { name: "Pages" })).getAllByRole(
      "checkbox",
    ) as HTMLInputElement[];

  test("one labelled checkbox per page, and none for the owner's own two", () => {
    render(<PageChecks value={["finance"]} onChange={() => {}} />);
    expect(boxes().map((box) => box.labels?.[0]?.textContent)).toEqual(
      PAGE_ORDER.map((area) => AREA_PAGES[area]),
    );
    expect(screen.queryByRole("checkbox", { name: AREA_PAGES.admin })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: AREA_PAGES.personal })).toBeNull();
    // Today can be given: each person is sent only their own mail and calendar.
    expect(screen.getByRole("checkbox", { name: AREA_PAGES.today })).toBeTruthy();
    expect(boxes().filter((box) => box.checked).map((box) => box.labels?.[0]?.textContent)).toEqual([
      "Finance",
    ]);
  });

  const sensitiveBoxes = () =>
    within(screen.getByRole("group", { name: "Sensitive" })).getAllByRole(
      "checkbox",
    ) as HTMLInputElement[];

  test("the sensitive two are a group of their own, after the pages, each described", () => {
    render(<PageChecks value={["finance", "settings"]} onChange={() => {}} />);
    const pages = screen.getByRole("group", { name: "Pages" });
    const sensitive = screen.getByRole("group", { name: "Sensitive" });
    // Apart, and after.
    expect(pages.contains(sensitive)).toBe(false);
    expect(pages.compareDocumentPosition(sensitive) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sensitiveBoxes().map((box) => box.labels?.[0]?.textContent)).toEqual([
      "Sources and Telegram",
      "Team",
    ]);
    // Each box is described by its own line, so it is read with the box.
    for (const page of SENSITIVE_PAGES) {
      const box = screen.getByRole("checkbox", { name: page.name });
      const described = document.getElementById(box.getAttribute("aria-describedby")!);
      expect(described?.textContent).toBe(page.description);
    }
    expect(sensitiveBoxes().map((box) => box.checked)).toEqual([true, false]);
    // None of them is among the ordinary pages.
    expect(within(pages).queryByRole("checkbox", { name: "Team" })).toBeNull();
  });

  test("Payroll and Costs have no box anywhere, and one line says why", () => {
    render(<PageChecks value={["finance"]} onChange={() => {}} />);
    expect(screen.queryByRole("checkbox", { name: "Payroll" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /^Costs/ })).toBeNull();
    const sensitive = screen.getByRole("group", { name: "Sensitive" });
    expect(within(sensitive).getByText("Payroll and costs are the owner's alone.")).toBeTruthy();
  });

  test("nothing sensitive is ticked to begin with", () => {
    render(<PageChecks value={[]} onChange={() => {}} />);
    expect(sensitiveBoxes().some((box) => box.checked)).toBe(false);
  });

  test("ticking a sensitive page reports it in the table's order, and unticking takes it away", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<PageChecks value={["board"]} onChange={onChange} />);
    await user.click(screen.getByRole("checkbox", { name: "Team" }));
    expect(onChange).toHaveBeenLastCalledWith(["board", "team"]);
    rerender(<PageChecks value={["board", "team"]} onChange={onChange} />);
    await user.click(screen.getByRole("checkbox", { name: "Sources and Telegram" }));
    expect(onChange).toHaveBeenLastCalledWith(["board", "settings", "team"]);
    await user.click(screen.getByRole("checkbox", { name: "Team" }));
    expect(onChange).toHaveBeenLastCalledWith(["board"]);
  });

  test("a click reports the whole list in the table's order, never the order clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PageChecks value={["board"]} onChange={onChange} />);
    await user.click(screen.getByRole("checkbox", { name: "Finance" }));
    expect(onChange).toHaveBeenLastCalledWith(["finance", "board"]);
    await user.click(screen.getByRole("checkbox", { name: "Board" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});

describe("PagesNote", () => {
  test("nothing to say for pages the person's companies all have", () => {
    const { container } = render(<PagesNote areas={["finance", "board"]} companies={["kz"]} />);
    expect(container.textContent).toBe("");
  });

  test("with nothing ticked it says what the person will see", () => {
    render(<PagesNote areas={[]} companies={["us", "kz"]} />);
    expect(screen.getByText(NO_PAGES)).toBeTruthy();
    expect(NO_PAGES).toContain("You do not have access to this page");
  });

  test("a ticked page that will be empty for their companies is named", () => {
    render(<PagesNote areas={["fundraising", "finance", "gtm"]} companies={["kz"]} />);
    expect(
      screen.getByText(
        "Empty for someone on Globex only: Fundraising.",
      ),
    ).toBeTruthy();
  });
});
