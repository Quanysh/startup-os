// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { areasOf, type Role } from "@convex/lib/roles";
import { CompanyProvider, useCompany } from "@/components/company-provider";
import { ViewerProvider } from "@/components/viewer-provider";
import type { CompanyId } from "@/lib/company";
import { AppShell } from "./app-shell";

const replace = vi.fn();
let pathname = "/";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ replace }),
}));
vi.mock("@convex-dev/auth/react", () => ({ useAuthActions: () => ({ signOut: vi.fn() }) }));
// The bell asks Convex for the viewer's notifications; it has tests of its own.
// The approvals inbox's count asks Convex too (an owner's query): a stand-in.
vi.mock("@/components/approvals/inbox-count", () => ({
  InboxCount: () => <span data-testid="inbox-count">2</span>,
}));
vi.mock("@/components/notifications/notification-bell", () => ({
  NotificationBell: () => <button type="button">the bell</button>,
}));

beforeAll(() => {
  // jsdom has no matchMedia, which the sidebar asks for the screen's width.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  replace.mockClear();
  window.localStorage.clear();
  pathname = "/";
});

const BOTH: CompanyId[] = ["us", "kz"];

/** `areas` is what `viewer.me` said: the role's unless the owner picked the teammate's pages. */
function show(role: Role, companies: CompanyId[], at = "/", areas = areasOf(role)) {
  pathname = at;
  return render(
    <ViewerProvider
      viewer={{ role, companies, areas, email: "someone@example.test", name: null }}
    >
      <AppShell viewer={{ email: "someone@example.test", name: null }}>
        <p data-testid="page">the page</p>
      </AppShell>
    </ViewerProvider>,
  );
}

const sidebar = () => document.querySelector<HTMLElement>('[data-sidebar="sidebar"]')!;
/** The navigation as it reads: each group's label, then its items. */
const nav = () =>
  [...sidebar().querySelectorAll<HTMLElement>('[data-sidebar="group"]')].map((group) => [
    group.querySelector('[data-sidebar="group-label"]')?.textContent,
    ...[...group.querySelectorAll('[data-sidebar="menu-button"]')].map((a) => a.textContent),
  ]);
const hrefs = () =>
  [...sidebar().querySelectorAll('[data-sidebar="menu-button"]')].map((a) => a.getAttribute("href"));
const companySwitch = () => within(sidebar()).queryByRole("group", { name: "Company" });
const REFUSED = "You do not have access to this page";

const COMPANY_PAGES = [
  "Finance",
  "Product",
  "Engineering",
  "Sales",
  "Fundraising",
  "Partnerships",
  "Contacts",
  "Customers",
  "Compliance",
  "Go to market",
  // The LinkedIn calendar belongs to Go to market and serves both companies.
  "LinkedIn",
  "Memory",
];

describe("the navigation, by role", () => {
  test("the owner sees every page, with Team under Settings", () => {
    show("owner", BOTH);
    expect(nav()).toEqual([
      // Assistant is the owner's alone (below): no teammate's list has it.
      ["Operate", "Today", "Approvals", "Board", "Handoffs", "Goals and targets", "Agents", "Assistant"],
      ["Company", ...COMPANY_PAGES, "Payroll", "Costs"],
      ["Settings", "Sources", "Connections", "Team", "Telegram"],
    ]);
    expect(hrefs()).toContain("/settings/team");
    expect(hrefs()).toContain("/settings/telegram");
  });

  test("a co-founder sees everything but the owner's own pages, and no Settings group", () => {
    show("cofounder", BOTH);
    expect(nav()).toEqual([
      ["Operate", "Today", "Board", "Handoffs", "Goals and targets", "Agents"],
      // Contacts is ticked for a person by name: no role starts with it.
      ["Company", ...COMPANY_PAGES.filter((page) => page !== "Contacts")],
    ]);
  });

  test("a co-founder on Globex alone sees none of the pages kept for Startup", () => {
    show("cofounder", ["kz"]);
    expect(nav()).toEqual([
      ["Operate", "Today", "Board", "Handoffs", "Goals and targets", "Agents"],
      ["Company", "Finance", "Product", "Engineering", "Sales", "Partnerships", "Customers", "Compliance", "LinkedIn", "Memory"],
    ]);
  });

  test("Support is Globex's: after Customers for the owner on Globex, never on Startup", () => {
    window.localStorage.setItem("startup-os:company", "kz");
    show("owner", BOTH);
    expect(nav()[1]).toEqual([
      "Company",
      "Finance",
      "Product",
      "Engineering",
      "Sales",
      "Partnerships",
      "Contacts",
      "Customers",
      "Support",
      "Compliance",
      "LinkedIn",
      "Memory",
      "Payroll",
      "Costs",
    ]);
    expect(hrefs()).toContain("/support");
    cleanup();
    window.localStorage.setItem("startup-os:company", "us");
    show("owner", BOTH);
    expect(hrefs()).not.toContain("/support");
  });

  test("Support is ticked by name: a teammate on Globex with it has the page, one on Startup alone does not", () => {
    show("sales", ["kz"], "/support", ["support"]);
    expect(nav()).toEqual([["Company", "Support"]]);
    expect(screen.getByTestId("page")).toBeTruthy();
    cleanup();
    show("sales", ["us"], "/support", ["support", "sales"]);
    expect(hrefs()).not.toContain("/support");
    expect(screen.queryByTestId("page")).toBeNull();
    cleanup();
    // A co-founder's starting set does not hold it.
    show("cofounder", ["kz"], "/support");
    expect(screen.getByRole("heading", { name: REFUSED })).toBeTruthy();
    expect(screen.queryByTestId("page")).toBeNull();
  });

  test("Contacts is ticked by name: a teammate with it has the page, a co-founder's starting set does not", () => {
    show("engineer", ["kz"], "/contacts", ["contacts"]);
    expect(nav()).toEqual([["Company", "Contacts"]]);
    expect(screen.getByTestId("page")).toBeTruthy();
    cleanup();
    show("cofounder", BOTH, "/contacts");
    expect(hrefs()).not.toContain("/contacts");
    expect(screen.getByRole("heading", { name: REFUSED })).toBeTruthy();
    expect(screen.queryByTestId("page")).toBeNull();
  });

  test("sales sees the scorecard, the board and the selling pages", () => {
    show("sales", BOTH);
    expect(nav()).toEqual([
      ["Operate", "Today", "Board", "Handoffs", "Goals and targets"],
      ["Company", "Sales", "Customers", "Go to market", "LinkedIn"],
    ]);
  });

  test("sales on Globex alone", () => {
    show("sales", ["kz"]);
    expect(nav()).toEqual([
      ["Operate", "Today", "Board", "Handoffs", "Goals and targets"],
      ["Company", "Sales", "Customers", "LinkedIn"],
    ]);
  });

  test.each([[BOTH], [["us"] as CompanyId[]], [["kz"] as CompanyId[]]])(
    "an engineer on %j sees the board and the product page",
    (companies) => {
      show("engineer", companies, "/board");
      expect(nav()).toEqual([
        ["Operate", "Board", "Handoffs", "Goals and targets", "Agents"],
        ["Company", "Product", "Engineering"],
      ]);
      expect(screen.getByTestId("page")).toBeTruthy();
    },
  );

  test("Today is one item at /, for the scorecard or a person's own day; an engineer with neither is not offered it", () => {
    // Given only their own day: Today, at /, and the page.
    show("engineer", BOTH, "/", ["board", "today"]);
    expect(nav()[0]).toEqual(["Operate", "Today", "Board", "Handoffs", "Goals and targets"]);
    expect(within(sidebar()).getByRole("link", { name: "Today" }).getAttribute("href")).toBe("/");
    expect(screen.getByTestId("page")).toBeTruthy();
    cleanup();
    show("engineer", BOTH, "/board");
    expect(within(sidebar()).queryByRole("link", { name: "Today" })).toBeNull();
    expect(within(sidebar()).queryByRole("link", { name: "Dashboard" })).toBeNull();
  });

  test("the logo leads to the first page the viewer can open", () => {
    show("engineer", BOTH, "/board");
    expect(sidebar().querySelector("a")?.getAttribute("href")).toBe("/board");
    cleanup();
    show("sales", BOTH);
    expect(sidebar().querySelector("a")?.getAttribute("href")).toBe("/");
  });
});

describe("Suggest a change, in the sidebar's footer", () => {
  const button = () => within(sidebar()).queryByRole("button", { name: "Suggest a change" });

  test.each(["owner", "cofounder", "sales", "engineer"] as const)(
    "a %s is offered it, whatever their pages",
    (role) => {
      show(role, BOTH, role === "engineer" ? "/board" : "/");
      expect(button()).toBeTruthy();
    },
  );

  test("so is a teammate with a single page and no board", () => {
    show("engineer", ["us"], "/finance", ["finance"]);
    expect(button()).toBeTruthy();
  });

  test("a teammate with no page at all is not: the server would refuse them", () => {
    show("engineer", ["us"], "/", []);
    expect(button()).toBeNull();
  });
});

describe("a page the role cannot open", () => {
  test.each([
    ["engineer", "/finance", "/board"],
    ["engineer", "/settings/team", "/board"],
    ["cofounder", "/settings/sources", "/"],
    ["cofounder", "/settings/connections", "/"],
    ["cofounder", "/settings/team", "/"],
    // Payroll is the owner's alone: no teammate can be given it.
    ["cofounder", "/payroll", "/"],
    ["sales", "/payroll", "/"],
    ["engineer", "/payroll", "/board"],
    ["cofounder", "/costs", "/"],
    ["sales", "/costs", "/"],
    ["engineer", "/costs", "/board"],
  ] as const)("%s at %s is told so, and the page is not rendered", (role, at, first) => {
    show(role, BOTH, at);
    expect(screen.getByRole("heading", { name: REFUSED })).toBeTruthy();
    expect(screen.queryByTestId("page")).toBeNull();
    // The panel's one link: the first page this viewer does have.
    const panel = screen.getByRole("heading", { name: REFUSED }).closest("section")!;
    expect(within(panel).getByRole("link").getAttribute("href")).toBe(first);
    expect(replace).not.toHaveBeenCalled();
  });

  test.each([
    ["owner", "/settings/team"],
    ["owner", "/payroll"],
    ["owner", "/costs"],
    ["cofounder", "/review"],
    ["sales", "/gtm"],
    ["engineer", "/product"],
    ["engineer", "/engineering"],
    ["cofounder", "/engineering"],
  ] as const)("%s at %s gets the page", (role, at) => {
    show(role, BOTH, at);
    expect(screen.getByTestId("page")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: REFUSED })).toBeNull();
  });

  test("an engineer who lands on the scorecard is sent to the board, and no scorecard is rendered", () => {
    show("engineer", BOTH, "/");
    expect(replace).toHaveBeenCalledWith("/board");
    expect(screen.queryByTestId("page")).toBeNull();
  });

  test("a viewer with the scorecard stays on it", () => {
    show("sales", ["kz"], "/");
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByTestId("page")).toBeTruthy();
  });

  test("a page kept for a company the viewer is not on is refused, with no switch offered", () => {
    show("cofounder", ["kz"], "/fundraising");
    expect(screen.getByRole("heading", { name: REFUSED })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Switch to/ })).toBeNull();
    expect(screen.queryByTestId("page")).toBeNull();
  });
});

describe("pages the owner picked for a teammate", () => {
  test("an engineer given finance sees Finance, and gets the page", () => {
    show("engineer", BOTH, "/finance", ["finance", "product", "board"]);
    expect(nav()).toEqual([
      ["Operate", "Board", "Handoffs", "Goals and targets"],
      ["Company", "Finance", "Product"],
    ]);
    expect(screen.getByTestId("page")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: REFUSED })).toBeNull();
  });

  test("a co-founder with finance unticked has no Finance item, and is refused the page", () => {
    const areas = areasOf("cofounder").filter((area) => area !== "finance");
    show("cofounder", BOTH, "/finance", areas);
    expect(hrefs()).not.toContain("/finance");
    expect(hrefs()).toContain("/product");
    expect(screen.getByRole("heading", { name: REFUSED })).toBeTruthy();
    expect(screen.queryByTestId("page")).toBeNull();
  });

  test("a role's own page, unticked, is gone like any other", () => {
    show("engineer", BOTH, "/board", ["sales"]);
    expect(nav()).toEqual([["Company", "Sales"]]);
    expect(screen.getByRole("heading", { name: REFUSED })).toBeTruthy();
    const panel = screen.getByRole("heading", { name: REFUSED }).closest("section")!;
    expect(within(panel).getByRole("link").getAttribute("href")).toBe("/sales");
  });

  test("a ticked page kept for a company they are not on is neither listed nor opened", () => {
    show("engineer", ["kz"], "/fundraising", ["fundraising", "board"]);
    expect(nav()).toEqual([["Operate", "Board", "Handoffs", "Goals and targets"]]);
    expect(screen.getByRole("heading", { name: REFUSED })).toBeTruthy();
    expect(screen.queryByTestId("page")).toBeNull();
  });

  test.each(["/", "/board", "/finance", "/settings/team"])(
    "a teammate with no page gets the shell and the refusal at %s, with nowhere to send them",
    (at) => {
      show("cofounder", BOTH, at, []);
      expect(nav()).toEqual([]);
      expect(screen.getByRole("heading", { name: REFUSED })).toBeTruthy();
      expect(screen.queryByTestId("page")).toBeNull();
      const panel = screen.getByRole("heading", { name: REFUSED }).closest("section")!;
      expect(within(panel).queryByRole("link")).toBeNull();
      expect(replace).not.toHaveBeenCalled();
      // They can still sign out.
      expect(within(sidebar()).getByRole("button", { name: "Sign out" })).toBeTruthy();
    },
  );
});

describe("the company switch", () => {
  test("a viewer on both companies can switch, and the other-company notice still works", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("startup-os:company", "kz");
    show("owner", BOTH, "/fundraising");
    const buttons = within(companySwitch()!).getAllByRole("button");
    expect(buttons.map((b) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([
      ["StartupUS", "false"],
      ["GlobexKZ", "true"],
    ]);
    expect(screen.getByRole("heading", { name: "Nothing here for Globex" })).toBeTruthy();
    expect(screen.queryByTestId("page")).toBeNull();
    expect(hrefs()).not.toContain("/fundraising");
    await user.click(screen.getByRole("button", { name: "Switch to Startup" }));
    expect(screen.getByTestId("page")).toBeTruthy();
    expect(hrefs()).toContain("/fundraising");
  });

  test.each([
    ["kz", "us"],
    ["us", "kz"],
  ] as const)(
    "a viewer on %s alone has no switch, and is shown it whatever the browser remembers (%s)",
    (own, stored) => {
      window.localStorage.setItem("startup-os:company", stored);
      show("sales", [own], "/gtm");
      expect(companySwitch()).toBeNull();
      // The pages kept for Startup are there for Startup's viewer only.
      expect(hrefs().includes("/gtm")).toBe(own === "us");
      expect(screen.queryByTestId("page") !== null).toBe(own === "us");
      expect(screen.queryByRole("button", { name: /Switch to/ })).toBeNull();
      expect(sidebar().textContent?.includes("Globex")).toBe(own === "kz");
    },
  );
});

describe("CompanyProvider", () => {
  function Probe() {
    return <p data-testid="company">{String(useCompany())}</p>;
  }
  const shown = (allowed?: CompanyId[]) => {
    render(
      <CompanyProvider allowed={allowed}>
        <Probe />
      </CompanyProvider>,
    );
    const text = screen.getByTestId("company").textContent;
    cleanup();
    return text;
  };

  test("a stored choice outside the allowed list is ignored", () => {
    window.localStorage.setItem("startup-os:company", "us");
    expect(shown(["kz"])).toBe("kz");
    expect(shown(["us", "kz"])).toBe("us");
    window.localStorage.setItem("startup-os:company", "kz");
    expect(shown(["us"])).toBe("us");
    expect(shown(["us", "kz"])).toBe("kz");
    expect(shown()).toBe("kz");
  });

  test("with nothing stored, the first allowed company is in view", () => {
    expect(shown(["kz"])).toBe("kz");
    expect(shown(["us", "kz"])).toBe("us");
    expect(shown()).toBe("us");
  });
});

// Payroll, Costs, Sources and Telegram, and Team: held, its item is in the
// navigation and its page opens; not held, there is no item and the page is
// the refused panel. The shell goes by the viewer's areas alone: Sources and
// Telegram and Team are ticked for a person by name, and the server never
// sends a teammate Payroll or Costs (they are the owner's alone), so the
// viewers below holding those stand for what the shell does with the list.
describe("the sensitive and owner-only pages", () => {
  test("a teammate given Costs sees Costs beside no Payroll, and gets the page", () => {
    show("engineer", ["kz"], "/costs", ["board", "costs"]);
    expect(nav()).toEqual([
      ["Operate", "Board", "Handoffs", "Goals and targets"],
      ["Company", "Costs"],
    ]);
    expect(screen.getByTestId("page")).toBeTruthy();
    expect(hrefs()).not.toContain("/payroll");
  });

  test("a teammate given Payroll sees Payroll, and gets the page", () => {
    show("engineer", BOTH, "/payroll", ["board", "payroll"]);
    expect(nav()).toEqual([
      ["Operate", "Board", "Handoffs", "Goals and targets"],
      ["Company", "Payroll"],
    ]);
    expect(screen.getByTestId("page")).toBeTruthy();
    expect(screen.queryByText(REFUSED)).toBeNull();
  });

  test("a teammate given Sources and Telegram sees both items, and gets both pages", () => {
    show("engineer", ["kz"], "/settings/sources", ["settings"]);
    // Settings sets the targets, so Goals and targets opens to them too.
    expect(nav()).toEqual([["Operate", "Goals and targets"], ["Settings", "Sources", "Telegram"]]);
    expect(screen.getByTestId("page")).toBeTruthy();
    cleanup();
    show("engineer", ["kz"], "/settings/telegram", ["settings"]);
    expect(screen.getByTestId("page")).toBeTruthy();
  });

  test("a teammate given Team sees Team, and gets the page", () => {
    show("engineer", ["kz"], "/settings/team", ["team"]);
    expect(nav()).toEqual([["Settings", "Team"]]);
    expect(screen.getByTestId("page")).toBeTruthy();
  });

  test.each([
    ["/payroll", ["settings", "team"]],
    ["/costs", ["payroll", "settings", "team", "finance"]],
    ["/payroll", ["costs", "finance"]],
    ["/settings/sources", ["payroll", "team"]],
    ["/settings/telegram", ["payroll", "team"]],
    ["/settings/team", ["payroll", "settings"]],
  ] as const)("%s is refused to someone with the other two and not its own", (at, areas) => {
    show("engineer", BOTH, at, [...areas]);
    expect(screen.getByText(REFUSED)).toBeTruthy();
    expect(screen.queryByTestId("page")).toBeNull();
    expect(hrefs()).not.toContain(at);
  });

  test("a co-founder with the role's own pages has none of them, in the navigation or by address", () => {
    for (const at of ["/payroll", "/costs", "/settings/sources", "/settings/telegram", "/settings/team"]) {
      show("cofounder", BOTH, at);
      expect(screen.getByText(REFUSED)).toBeTruthy();
      expect(screen.queryByTestId("page")).toBeNull();
      expect(hrefs()).not.toContain(at);
      cleanup();
    }
  });

  test("Work tools stays the owner's: all three together do not open it", () => {
    show("engineer", BOTH, "/settings/connections", ["payroll", "settings", "team"]);
    expect(screen.getByText(REFUSED)).toBeTruthy();
    expect(hrefs()).not.toContain("/settings/connections");
    expect(nav()).toEqual([
      ["Operate", "Goals and targets"],
      ["Company", "Payroll"],
      ["Settings", "Sources", "Team", "Telegram"],
    ]);
  });
});

describe("Approvals, the owner's alone", () => {
  test("the owner has the item after Today, with the inbox's count beside its link", () => {
    show("owner", BOTH, "/approvals");
    expect(screen.getByTestId("page")).toBeTruthy();
    const counts = screen.getAllByTestId("inbox-count");
    expect(counts).toHaveLength(1);
    const item = counts[0]!.closest('[data-sidebar="menu-item"]')!;
    expect(item.querySelector('[data-sidebar="menu-button"]')!.getAttribute("href")).toBe("/approvals");
    expect(item.querySelector('[data-sidebar="menu-button"]')!.textContent).toBe("Approvals");
  });

  test.each(["cofounder", "sales", "engineer"] as const)("a %s has no item, no count, and is refused the page", (role) => {
    show(role, BOTH, "/approvals", [...areasOf(role), "today", "payroll", "settings", "team"]);
    expect(screen.getByRole("heading", { name: REFUSED })).toBeTruthy();
    expect(hrefs()).not.toContain("/approvals");
    expect(screen.queryByTestId("inbox-count")).toBeNull();
  });
});

describe("the Assistant, the owner's alone", () => {
  test("the owner has the item under Operate, and gets the page", () => {
    show("owner", BOTH, "/assistant");
    expect(nav()[0]).toEqual(["Operate", "Today", "Approvals", "Board", "Handoffs", "Goals and targets", "Agents", "Assistant"]);
    expect(hrefs()).toContain("/assistant");
    expect(screen.getByTestId("page")).toBeTruthy();
    expect(screen.queryByText(REFUSED)).toBeNull();
  });

  test.each([
    ["cofounder", undefined],
    ["sales", undefined],
    ["engineer", undefined],
    // Every page a viewer can hold, Payroll, the sensitive ones and Today included.
    ["cofounder", [...areasOf("cofounder"), "today", "payroll", "settings", "team"]],
  ] as const)("a %s has no item for it and is refused the page", (role, areas) => {
    show(role, BOTH, "/assistant", areas === undefined ? areasOf(role) : [...areas]);
    expect(screen.getByRole("heading", { name: REFUSED })).toBeTruthy();
    expect(screen.queryByTestId("page")).toBeNull();
    expect(hrefs()).not.toContain("/assistant");
    expect(nav().flat()).not.toContain("Assistant");
  });

  test("the Assistant carries no count of its own: what waits is counted once, on Approvals", () => {
    show("owner", BOTH);
    const counts = screen.getAllByTestId("inbox-count");
    expect(counts).toHaveLength(1);
    const assistant = [...document.querySelectorAll('[data-sidebar="menu-item"]')].find(
      (item) => item.querySelector('[data-sidebar="menu-button"]')?.getAttribute("href") === "/assistant",
    )!;
    expect(assistant.textContent).toBe("Assistant");
  });

  test.each([
    ["cofounder", undefined],
    ["sales", undefined],
    ["engineer", undefined],
    ["cofounder", [...areasOf("cofounder"), "today", "payroll", "settings", "team"]],
  ] as const)("a %s's navigation has no count: it is never mounted, so never asked for", (role, areas) => {
    for (const at of ["/", "/board", "/assistant"]) {
      show(role, BOTH, at, areas === undefined ? areasOf(role) : [...areas]);
      expect(screen.queryByTestId("inbox-count")).toBeNull();
      cleanup();
    }
  });
});

describe("the notification bell", () => {
  const topBar = () => document.querySelector<HTMLElement>("[data-slot=top-bar]")!;

  test("is in the sidebar and, for the phone, in the top bar, for everyone with a page", () => {
    show("owner", BOTH);
    expect(within(topBar()).getByRole("button", { name: "the bell" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "the bell" })).toHaveLength(2);
    cleanup();
    // An engineer, who has neither the scorecard nor Finance, on a page that is refused.
    show("engineer", ["kz"], "/finance");
    expect(screen.getAllByRole("button", { name: "the bell" })).toHaveLength(2);
  });

  test("the top bar is the phone's alone: from md up the sidebar holds the bell", () => {
    show("owner", BOTH);
    expect(topBar().className).toContain("md:hidden");
    const outside = screen
      .getAllByRole("button", { name: "the bell" })
      .filter((button) => !topBar().contains(button));
    expect(outside).toHaveLength(1);
  });

  test("someone with no page at all is refused every function, so is not shown one", () => {
    show("sales", ["us"], "/", []);
    expect(screen.queryByRole("button", { name: "the bell" })).toBeNull();
  });
});

test("the weekly review is put away: no item for anyone, the owner included", () => {
  show("owner", BOTH, "/");
  expect(hrefs()).not.toContain("/review");
});

describe("the Engineering page in the navigation", () => {
  test("under Company, straight after Product, for whoever has the area", () => {
    show("engineer", BOTH, "/board");
    expect(nav()).toEqual([
      ["Operate", "Board", "Handoffs", "Goals and targets", "Agents"],
      ["Company", "Product", "Engineering"],
    ]);
    expect(hrefs()).toContain("/engineering");
  });
});

describe("the Agents page in the navigation", () => {
  test("under Operate, for whoever has the area, on either company: a product's, not a company's", () => {
    for (const companies of [BOTH, ["kz"] as CompanyId[], ["us"] as CompanyId[]]) {
      show("engineer", companies, "/agents");
      expect(nav()[0]).toEqual(["Operate", "Board", "Handoffs", "Goals and targets", "Agents"]);
      expect(within(sidebar()).getByRole("link", { name: "Agents" }).getAttribute("href")).toBe("/agents");
      expect(screen.getByTestId("page")).toBeTruthy();
      cleanup();
    }
  });

  test("without the area it is not offered, and the page is refused", () => {
    show("sales", BOTH, "/agents");
    expect(hrefs()).not.toContain("/agents");
    expect(screen.getByRole("heading", { name: REFUSED })).toBeTruthy();
  });

  test("for either company: it is not one company's page", () => {
    show("engineer", ["kz"], "/engineering");
    expect(hrefs()).toContain("/engineering");
    expect(screen.getByTestId("page")).toBeTruthy();
  });

  test("the product area alone does not show it, and the page is refused", () => {
    show("engineer", BOTH, "/engineering", ["product", "board"]);
    expect(hrefs()).not.toContain("/engineering");
    expect(screen.getByRole("heading", { name: REFUSED })).toBeTruthy();
    expect(screen.queryByTestId("page")).toBeNull();
  });

  test("the engineering area alone shows it and nothing of Product", () => {
    show("sales", BOTH, "/engineering", ["engineering"]);
    expect(nav()).toEqual([["Company", "Engineering"]]);
    expect(screen.getByTestId("page")).toBeTruthy();
  });
});
