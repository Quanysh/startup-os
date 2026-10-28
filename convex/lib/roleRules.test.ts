import { describe, expect, test } from "vitest";
import { isFocus } from "./focus";
import {
  GITHUB_NOT_A_USERNAME,
  MAX_ROLES,
  MAX_ROLE_NAME_LENGTH,
  PRESET_IS_ORDINARY,
  ROLE_NAME_TAKEN,
  SUGGESTED_ROLES,
  cleanGithub,
  cleanPreset,
  cleanRoleName,
  isReservedRoleName,
  roleNameKey,
  sameGithub,
} from "./roleRules";
import {
  PRESET_AREAS,
  ROLE_LABELS,
  SENSITIVE_AREAS,
  areasOf,
  effectiveAreas,
  isPresetArea,
  roleKind,
} from "./roles";

const message = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as { data?: unknown }).data;
  }
  return "did not throw";
};

describe("a stored role", () => {
  test("one of the three built-in words is itself; anything else is a role the owner named", () => {
    expect(roleKind("cofounder")).toBe("cofounder");
    expect(roleKind("sales")).toBe("sales");
    expect(roleKind("engineer")).toBe("engineer");
    expect(roleKind("k17abc")).toBe("custom");
    // Never the owner: the owner is not a row.
    expect(roleKind("owner")).toBe("custom");
  });

  test("a named role gives nothing by itself: a row with no list of its own has no page", () => {
    expect(areasOf("custom")).toEqual([]);
    expect(effectiveAreas("custom", undefined)).toEqual([]);
    expect(effectiveAreas("custom", ["sales", "admin"])).toEqual(["sales"]);
  });
});

describe("a role's name", () => {
  test("trimmed, one line, single spaces, nothing invisible", () => {
    expect(cleanRoleName("  Customer   success ")).toBe("Customer success");
    expect(cleanRoleName("Pro​duct\n lead")).toBe("Product lead");
    expect(cleanRoleName("Doctor/Clinical")).toBe("Doctor/Clinical");
  });

  test("one to forty characters; longer is refused, never cut", () => {
    expect(MAX_ROLE_NAME_LENGTH).toBe(40);
    expect(cleanRoleName("x".repeat(40))).toHaveLength(40);
    expect(message(() => cleanRoleName("x".repeat(41)))).toBe(
      "That name is too long (40 characters at most).",
    );
    expect(message(() => cleanRoleName("   "))).toBe("A role needs a name.");
    expect(message(() => cleanRoleName("​"))).toBe("A role needs a name.");
  });

  test("its key ignores capitals, so two names that differ only by them are one", () => {
    expect(roleNameKey("Customer Success")).toBe(roleNameKey("customer success"));
    expect(roleNameKey("Product")).not.toBe(roleNameKey("Products"));
  });

  test("the built-in names and the owner's are taken, whatever their capitals", () => {
    for (const label of Object.values(ROLE_LABELS)) {
      expect(isReservedRoleName(label)).toBe(true);
      expect(isReservedRoleName(label.toUpperCase())).toBe(true);
    }
    expect(isReservedRoleName("Product")).toBe(false);
    expect(ROLE_NAME_TAKEN).toBe("There is already a role with that name.");
  });

  test("at most thirty", () => {
    expect(MAX_ROLES).toBe(30);
  });
});

describe("a role's usual pages", () => {
  test("the ordinary pages only: what a co-founder starts with", () => {
    expect([...PRESET_AREAS]).toEqual([...areasOf("cofounder")]);
    expect(isPresetArea("sales")).toBe(true);
    expect(isPresetArea("today")).toBe(false);
    for (const area of SENSITIVE_AREAS) expect(isPresetArea(area)).toBe(false);
  });

  test("each once, in the table's order; none is allowed", () => {
    expect(cleanPreset(["board", "sales", "board"])).toEqual(["sales", "board"]);
    expect(cleanPreset([])).toEqual([]);
  });

  test.each([...SENSITIVE_AREAS, "today", "personal", "admin"])(
    "%s can never be in one",
    (area) => {
      expect(message(() => cleanPreset(["sales", area]))).toBe(PRESET_IS_ORDINARY);
    },
  );

  test("a name that is no page is refused without being quoted", () => {
    expect(message(() => cleanPreset(["SECRET page"]))).toBe("That is not a page of the OS.");
  });
});

describe("the names offered when adding a role", () => {
  test("the eight the owner asked for, each with a focus and ordinary pages", () => {
    expect(SUGGESTED_ROLES.map((role) => role.name)).toEqual([
      "Product",
      "Marketing",
      "Customer success",
      "Operations",
      "Finance",
      "Designer",
      "Doctor/Clinical",
      "Advisor",
    ]);
    for (const role of SUGGESTED_ROLES) {
      expect(isFocus(role.focus)).toBe(true);
      expect(cleanPreset(role.areas)).toEqual(role.areas);
      expect(cleanRoleName(role.name)).toBe(role.name);
      expect(isReservedRoleName(role.name)).toBe(false);
    }
  });
});

describe("a GitHub username", () => {
  test("letters, digits and hyphens, one to thirty-nine, with or without the @", () => {
    expect(cleanGithub(" @octo-cat ")).toBe("octo-cat");
    expect(cleanGithub("a")).toBe("a");
    expect(cleanGithub("a".repeat(39))).toHaveLength(39);
  });

  test("blank is none", () => {
    expect(cleanGithub("")).toBeUndefined();
    expect(cleanGithub("  @ ")).toBeUndefined();
  });

  test.each(["a".repeat(40), "octo cat", "octo_cat", "octo/cat", "окто"])(
    "%s is refused in fixed words",
    (typed) => {
      expect(message(() => cleanGithub(typed))).toBe(GITHUB_NOT_A_USERNAME);
      expect(GITHUB_NOT_A_USERNAME).not.toContain(typed);
    },
  );

  test("two are one person's whatever their capitals", () => {
    expect(sameGithub("Octo-Cat", "octo-cat")).toBe(true);
    expect(sameGithub("octo", "octo-cat")).toBe(false);
  });
});
