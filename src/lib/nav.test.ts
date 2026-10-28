import { describe, expect, test } from "vitest";
import { areasOf } from "@convex/lib/roles";
import { PAGE_ALSO, PAGE_AREAS, activeHref, areaOfPage, canOpen, pageAreas } from "./nav";

const HREFS = ["/", "/board", "/fundraising", "/fundraising/update", "/settings/sources"];

describe("activeHref", () => {
  test("the home item is active on the home page only", () => {
    expect(activeHref("/", HREFS)).toBe("/");
    expect(activeHref("/board", HREFS)).toBe("/board");
  });

  test("a page under an item keeps that item active", () => {
    expect(activeHref("/settings/sources/mercury", HREFS)).toBe("/settings/sources");
  });

  test("when one item sits under another, only the nearer one is active", () => {
    expect(activeHref("/fundraising", HREFS)).toBe("/fundraising");
    expect(activeHref("/fundraising/update", HREFS)).toBe("/fundraising/update");
    expect(activeHref("/fundraising/update/2026-09", HREFS)).toBe("/fundraising/update");
  });

  test("a name that only starts the same is not a match", () => {
    expect(activeHref("/boardroom", HREFS)).toBeNull();
    expect(activeHref("/signin", HREFS)).toBeNull();
  });
});

describe("areaOfPage and canOpen", () => {
  test("each page belongs to one area, whatever follows its path", () => {
    expect(areaOfPage("/")).toBe("scorecard");
    // /today redirects to Today at "/": no page of its own.
    expect(areaOfPage("/today")).toBeNull();
    // One Connections page: a teammate's own token is Today's; the owner's parts are refused
    // inside Convex to anyone else, and are not mounted for them.
    expect(areaOfPage("/settings/connections")).toBe("today");
    expect(areaOfPage("/fundraising/update")).toBe("fundraising");
    // Sources and Telegram are one area; Payroll and Team one each.
    expect(areaOfPage("/settings/sources?metric=cash&scope=kz")).toBe("settings");
    // The Record a figure panel is on Finance, and a link to it needs settings as well.
    expect(areaOfPage("/finance?metric=cash&scope=kz#record-a-figure")).toBe("finance");
    expect(areaOfPage("/settings/telegram")).toBe("settings");
    expect(areaOfPage("/settings/team")).toBe("team");
    expect(areaOfPage("/payroll")).toBe("payroll");
    expect(areaOfPage("/costs")).toBe("costs");
    // The Assistant stays the owner's alone.
    expect(areaOfPage("/assistant")).toBe("personal");
    expect(areaOfPage("/engineering")).toBe("engineering");
    expect(areaOfPage("/engineering?stuck=1&owner=someone")).toBe("engineering");
    expect(areaOfPage("/customers?health=at_risk#top")).toBe("customers");
  });

  test("a path that is no page of the OS has no area", () => {
    expect(areaOfPage("/signin")).toBeNull();
    expect(areaOfPage("https://example.test/finance")).toBeNull();
  });

  test("a role opens only the pages of its areas", () => {
    const engineer = areasOf("engineer");
    expect(canOpen(engineer, "/board")).toBe(true);
    expect(canOpen(engineer, "/product")).toBe(true);
    expect(canOpen(engineer, "/engineering")).toBe(true);
    // The Engineering page is its own area: product alone does not open it.
    expect(canOpen(["product"], "/engineering")).toBe(false);
    expect(canOpen(["engineering"], "/product")).toBe(false);
    expect(canOpen(areasOf("sales"), "/engineering")).toBe(false);
    expect(canOpen(engineer, "/")).toBe(false);
    expect(canOpen(engineer, "/finance?metric=mrr&scope=us#record-a-figure")).toBe(false);
    expect(canOpen(areasOf("cofounder"), "/settings/sources")).toBe(false);
    expect(canOpen(areasOf("cofounder"), "/review")).toBe(true);
    expect(canOpen(areasOf("owner"), "/settings/team")).toBe(true);
    // Payroll is ticked for a person by name: no role starts with it.
    expect(canOpen(areasOf("owner"), "/payroll")).toBe(true);
    expect(canOpen(areasOf("cofounder"), "/payroll")).toBe(false);
    // And so is Costs.
    expect(canOpen(areasOf("owner"), "/costs")).toBe(true);
    for (const role of ["cofounder", "sales", "engineer"] as const) {
      expect(canOpen(areasOf(role), "/costs")).toBe(false);
    }
  });

  test("a ticked sensitive page opens its own pages and no other", () => {
    expect(canOpen(["payroll"], "/payroll")).toBe(true);
    expect(canOpen(["payroll"], "/settings/sources")).toBe(false);
    expect(canOpen(["payroll"], "/settings/team")).toBe(false);
    expect(canOpen(["settings"], "/settings/sources")).toBe(true);
    expect(canOpen(["settings"], "/finance?metric=cash&scope=kz#record-a-figure")).toBe(false);
    expect(canOpen(["finance"], "/finance?metric=cash&scope=kz#record-a-figure")).toBe(false);
    expect(canOpen(["finance", "settings"], "/finance?metric=cash&scope=kz#record-a-figure")).toBe(true);
    expect(canOpen(["settings"], "/settings/telegram")).toBe(true);
    expect(canOpen(["settings"], "/payroll")).toBe(false);
    expect(canOpen(["settings"], "/settings/team")).toBe(false);
    expect(canOpen(["team"], "/settings/team")).toBe(true);
    expect(canOpen(["team"], "/settings/telegram")).toBe(false);
    expect(canOpen(["team"], "/payroll")).toBe(false);
    // Costs and Payroll are two pages: neither opens the other.
    expect(canOpen(["costs"], "/costs")).toBe(true);
    expect(canOpen(["costs"], "/payroll")).toBe(false);
    expect(canOpen(["payroll"], "/costs")).toBe(false);
    expect(canOpen(["payroll", "settings", "team", "finance"], "/costs")).toBe(false);
    // Work tools open for none of them, nor all three together.
    expect(canOpen(["payroll", "settings", "team"], "/settings/connections")).toBe(false);
    // Nor does the owner's Assistant, for any teammate whatever they were given.
    expect(canOpen(["payroll", "settings", "team"], "/assistant")).toBe(false);
    expect(canOpen(areasOf("cofounder"), "/assistant")).toBe(false);
    expect(canOpen(areasOf("owner"), "/assistant")).toBe(true);
  });

  test("no page of the OS is under the admin area: nothing a teammate could be given is the owner's alone by it", () => {
    expect(Object.values(PAGE_AREAS)).not.toContain("admin");
    // The two pages that are the owner's alone: no teammate can be given `personal`.
    expect(Object.entries(PAGE_AREAS).filter(([, area]) => area === "personal")).toEqual([
      ["/assistant", "personal"],
      ["/approvals", "personal"],
    ]);
  });

  test("an old address that only redirects is no page of its own", () => {
    for (const old of ["/today", "/today/connect", "/settings/work-tools", "/assistant/connection", "/review", "/fundraising/update"]) {
      expect(Object.keys(PAGE_AREAS)).not.toContain(old);
    }
  });

  test("Today at / opens to whoever could open the Dashboard or the old Today, and nobody else", () => {
    expect(pageAreas("/")).toEqual(["scorecard", "today"]);
    expect(canOpen(["scorecard"], "/")).toBe(true);
    expect(canOpen(["today"], "/")).toBe(true);
    expect(canOpen(areasOf("sales"), "/")).toBe(true);
    // An engineer has neither, as before: the shell takes them to the board.
    expect(canOpen(areasOf("engineer"), "/")).toBe(false);
    expect(canOpen([...areasOf("engineer"), "today"], "/")).toBe(true);
    // Nothing else opens a second way but Goals and targets (below).
    expect(Object.keys(PAGE_ALSO)).toEqual(["/", "/goals"]);
  });

  test("Goals and targets opens to whoever the server sends a part of it", () => {
    // goals.list: the scorecard or the board; targets.list: the scorecard or settings.
    expect(pageAreas("/goals")).toEqual(["scorecard", "board", "settings"]);
    expect(canOpen(["board"], "/goals")).toBe(true);
    expect(canOpen(["settings"], "/goals")).toBe(true);
    // Editing goals alone sends nothing to read on it.
    expect(canOpen(["review"], "/goals")).toBe(false);
  });

  test("every page in the table is one the owner can open", () => {
    for (const href of Object.keys(PAGE_AREAS)) expect(canOpen(areasOf("owner"), href)).toBe(true);
  });
});
