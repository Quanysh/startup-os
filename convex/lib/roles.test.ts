import { describe, expect, test } from "vitest";
import {
  ANY_AREA,
  AREAS,
  GRANTABLE_AREAS,
  MEMBER_ROLES,
  OWNER_ONLY_AREAS,
  PAY_AND_COSTS,
  PAY_AND_COSTS_ARE_THE_OWNERS,
  PRESET_AREAS,
  ROLES,
  SENSITIVE_AREAS,
  STORED_AREAS,
  areasOf,
  effectiveAreas,
  isGrantableArea,
  isMemberRole,
  isSensitiveArea,
  may,
} from "./roles";

// Each role's starting set, line by line: what a new teammate's boxes are
// ticked to, and what a teammate added before the owner chose pages has.
const TABLE = {
  owner: [...AREAS],
  cofounder: [
    "scorecard",
    "finance",
    "product",
    "engineering",
    "sales",
    "customers",
    "compliance",
    "fundraising",
    "partnerships",
    // What came of the bots' plays (Bot Loop v3): an ordinary area.
    "outcomes",
    "marketing",
    "gtm",
    "board",
    "review",
    // Company memory: decisions and meeting notes.
    "memory",
    // Vertical Startup's AI agents: every ordinary page is the co-founder's.
    "agents",
  ],
  sales: ["scorecard", "sales", "customers", "marketing", "gtm", "board"],
  engineer: ["product", "engineering", "board", "agents"],
} as const;

describe("a role's starting set", () => {
  test.each(ROLES)("%s starts with exactly its areas", (role) => {
    expect([...areasOf(role)].sort()).toEqual([...TABLE[role]].sort());
  });

  test("no member role starts with the personal or admin area", () => {
    for (const role of MEMBER_ROLES) {
      expect(areasOf(role)).not.toContain("personal");
      expect(areasOf(role)).not.toContain("admin");
    }
  });

  test("Support is in no member role's starting set, and the owner has it", () => {
    expect(isGrantableArea("support")).toBe(true);
    expect(isSensitiveArea("support")).toBe(false);
    for (const role of MEMBER_ROLES) expect(areasOf(role)).not.toContain("support");
    expect(areasOf("owner")).toContain("support");
    // A co-founder's row with no list of its own does not have it either.
    expect(effectiveAreas("cofounder", undefined)).not.toContain("support");
    // Ticked by name, it is theirs.
    expect(effectiveAreas("sales", ["support"])).toEqual(["support"]);
  });

  test("Contacts is in no role's starting set nor a named role's usual pages, and the owner has it", () => {
    // Real people's addresses and numbers: ticked for one person, by the owner.
    expect(isGrantableArea("contacts")).toBe(true);
    expect(isSensitiveArea("contacts")).toBe(false);
    for (const role of MEMBER_ROLES) expect(areasOf(role)).not.toContain("contacts");
    expect(effectiveAreas("cofounder", undefined)).not.toContain("contacts");
    expect(effectiveAreas("engineer", undefined)).not.toContain("contacts");
    expect(PRESET_AREAS).not.toContain("contacts");
    expect(areasOf("owner")).toContain("contacts");
    expect(effectiveAreas("engineer", ["contacts"])).toEqual(["contacts"]);
  });

  test("Today is in no member role's starting set, and the owner has it", () => {
    for (const role of MEMBER_ROLES) expect(areasOf(role)).not.toContain("today");
    expect(areasOf("owner")).toContain("today");
  });

  // Sources and Telegram, and Team: each is ticked for a person by name,
  // never by a role. A role that started with one would hand the dashboard's
  // numbers or the team itself to everyone given that role.
  test("no member role starts with a sensitive area, and the owner has them all", () => {
    expect([...SENSITIVE_AREAS]).toEqual(["settings", "team"]);
    for (const role of MEMBER_ROLES) {
      for (const area of SENSITIVE_AREAS) expect(areasOf(role)).not.toContain(area);
    }
    for (const area of SENSITIVE_AREAS) expect(areasOf("owner")).toContain(area);
  });

  test("the owner is not a role a teammate can be given", () => {
    expect(isMemberRole("owner")).toBe(false);
    expect(isMemberRole("sales")).toBe(true);
    expect(isMemberRole("admin")).toBe(false);
  });
});

describe("the engineering area", () => {
  test("an ordinary area: it can be given, and the engineer and the co-founder start with it", () => {
    expect(isGrantableArea("engineering")).toBe(true);
    expect(areasOf("engineer")).toContain("engineering");
    expect(areasOf("cofounder")).toContain("engineering");
    expect(areasOf("sales")).not.toContain("engineering");
  });

  test("it is its own: product does not bring it, and it does not bring product", () => {
    expect(effectiveAreas("sales", ["product"])).toEqual(["product"]);
    expect(effectiveAreas("sales", ["engineering"])).toEqual(["engineering"]);
  });
});

describe("the areas the owner can give", () => {
  test("every area but the owner's own four, in the table's order", () => {
    expect([...OWNER_ONLY_AREAS]).toEqual(["personal", "admin", "payroll", "costs"]);
    expect(GRANTABLE_AREAS).toEqual(
      AREAS.filter((a) => !["personal", "admin", "payroll", "costs"].includes(a)),
    );
    expect(isGrantableArea("finance")).toBe(true);
    expect(isGrantableArea("personal")).toBe(false);
    expect(isGrantableArea("admin")).toBe(false);
    expect(isGrantableArea("no_such_area")).toBe(false);
  });
});

// The owner's decision: payroll is theirs alone, and costs with it (the burn,
// and the run-rate incl. pay). No row, role or named role gives either.
describe("payroll and costs are the owner's alone", () => {
  test("neither can be given, by a person's list or a role's usual pages", () => {
    expect([...PAY_AND_COSTS]).toEqual(["payroll", "costs"]);
    for (const area of PAY_AND_COSTS) {
      expect(isGrantableArea(area)).toBe(false);
      expect(isSensitiveArea(area)).toBe(false);
      expect(PRESET_AREAS).not.toContain(area);
      for (const role of MEMBER_ROLES) expect(areasOf(role)).not.toContain(area);
    }
  });

  test("the owner has both", () => {
    for (const area of PAY_AND_COSTS) expect(areasOf("owner")).toContain(area);
    expect(effectiveAreas("owner", [])).toEqual(expect.arrayContaining(["payroll", "costs"]));
  });

  test("a teammate's row that still says either is read without it, whatever its role", () => {
    for (const role of [...MEMBER_ROLES, "a-role-the-owner-named"]) {
      expect(effectiveAreas(role, ["payroll", "costs", "finance"])).toEqual(["finance"]);
      expect(effectiveAreas(role, ["payroll"])).toEqual([]);
      expect(effectiveAreas(role, ["costs"])).toEqual([]);
      expect(effectiveAreas(role, undefined)).not.toContain("payroll");
      expect(effectiveAreas(role, undefined)).not.toContain("costs");
    }
  });

  test("a stored row may still hold them, until the migration takes them out", () => {
    // So a deployment with such rows passes the schema; nothing reads them as access.
    expect(STORED_AREAS).toEqual(AREAS.filter((a) => a !== "personal" && a !== "admin"));
  });

  test("the refusal says so in fixed words", () => {
    expect(PAY_AND_COSTS_ARE_THE_OWNERS).toBe("Payroll and costs are the owner's alone.");
  });
});

describe("the sensitive areas", () => {
  test("can be given, one by one", () => {
    for (const area of SENSITIVE_AREAS) {
      expect(isGrantableArea(area)).toBe(true);
      expect(isSensitiveArea(area)).toBe(true);
      expect(effectiveAreas("engineer", [area])).toEqual([area]);
    }
    expect(isSensitiveArea("finance")).toBe(false);
    expect(isSensitiveArea("admin")).toBe(false);
    expect(isSensitiveArea("no_such_area")).toBe(false);
  });

  test("a row with no list of its own never has one, whatever its role", () => {
    for (const role of MEMBER_ROLES) {
      for (const area of SENSITIVE_AREAS) {
        expect(effectiveAreas(role, undefined)).not.toContain(area);
      }
    }
  });

  test("a co-founder's own list holds them only where it names them", () => {
    expect(effectiveAreas("cofounder", ["finance", "team"])).toEqual(["finance", "team"]);
    expect(effectiveAreas("cofounder", ["finance"])).toEqual(["finance"]);
  });
});

describe("effectiveAreas", () => {
  test.each(MEMBER_ROLES)("a %s with no list of their own has the role's", (role) => {
    expect(effectiveAreas(role, undefined)).toEqual(areasOf(role));
  });

  test("a list of their own replaces the role's, both ways", () => {
    // More than an engineer starts with, and less: no board.
    expect(effectiveAreas("engineer", ["finance", "product"])).toEqual(["finance", "product"]);
    // Less than a co-founder starts with.
    expect(effectiveAreas("cofounder", ["scorecard"])).toEqual(["scorecard"]);
  });

  test("Today can be given, and is a teammate's only when the owner ticked it", () => {
    expect(isGrantableArea("today")).toBe(true);
    expect(effectiveAreas("engineer", ["today"])).toEqual(["today"]);
    expect(effectiveAreas("cofounder", undefined)).not.toContain("today");
    expect(effectiveAreas("cofounder", ["board"])).not.toContain("today");
  });

  test("an empty list is no pages, not the role's", () => {
    expect(effectiveAreas("cofounder", [])).toEqual([]);
  });

  test("personal and admin are never a teammate's, even if a row holds them", () => {
    for (const role of MEMBER_ROLES) {
      expect(effectiveAreas(role, ["admin", "personal", "finance"])).toEqual(["finance"]);
      expect(effectiveAreas(role, ["admin", "personal"])).toEqual([]);
    }
  });

  test("an unknown name and a repeat are dropped, and the order is the table's", () => {
    expect(effectiveAreas("sales", ["board", "nonsense", "finance", "board"])).toEqual([
      "finance",
      "board",
    ]);
  });

  test("the owner has every area, whatever is passed", () => {
    expect(effectiveAreas("owner", undefined)).toEqual(AREAS);
    expect(effectiveAreas("owner", [])).toEqual(AREAS);
  });
});

describe("may", () => {
  const engineer = { areas: effectiveAreas("engineer", undefined) };

  test("asks the caller's own areas, never their role", () => {
    expect(may(engineer, "product")).toBe(true);
    expect(may(engineer, "finance")).toBe(false);
    expect(may({ areas: ["finance"] }, "finance")).toBe(true);
    expect(may({ areas: ["finance"] }, "product")).toBe(false);
  });

  test("given a list it needs one of them, and an empty list is nobody's", () => {
    expect(may(engineer, ["scorecard", "board"])).toBe(true);
    expect(may(engineer, ["scorecard", "finance"])).toBe(false);
    expect(may({ areas: AREAS }, [])).toBe(false);
  });

  test("ANY_AREA admits anyone with a page, and nobody without one", () => {
    for (const role of ROLES) expect(may({ areas: areasOf(role) }, ANY_AREA)).toBe(true);
    expect(may({ areas: [] }, ANY_AREA)).toBe(false);
  });
});

describe("marketing goes with the go-to-market page", () => {
  test("ticking go to market brings marketing; marketing alone is nothing", () => {
    expect(effectiveAreas("sales", ["gtm"])).toEqual(["marketing", "gtm"]);
    expect(effectiveAreas("sales", ["marketing"])).toEqual([]);
    expect(effectiveAreas("sales", ["marketing", "finance"])).toEqual(["finance"]);
  });
});
