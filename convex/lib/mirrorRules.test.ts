import { describe, expect, test } from "vitest";
import {
  MAX_MIRROR_ROWS,
  cleanAddress,
  cleanDomain,
  cleanRemote,
  groupOf,
  isLinearUrl,
  keyOf,
  refusal,
  type MirrorRecord,
  type RecordOf,
} from "./mirrorRules";

// Every name, address and subject here is made up.
const AT = Date.UTC(2026, 9, 12, 6);

const mail = (over: Partial<RecordOf<"mail">> = {}): RecordOf<"mail"> => ({
  kind: "mail",
  threadId: "a1",
  fromName: "Ada Example",
  fromAddress: "ada@example-fund.test",
  subject: "Made-up subject",
  lastMessageAt: AT,
  ...over,
});

const issue = (over: Partial<RecordOf<"issue">> = {}): RecordOf<"issue"> => ({
  kind: "issue",
  issueId: "i1",
  identifier: "ENG-1",
  title: "Made-up title",
  url: "https://linear.app/startup/issue/ENG-1/made-up-title",
  stateType: "started",
  stateName: "In Progress",
  teamKey: "ENG",
  teamName: "Engineering",
  assigneeName: "Ada Example",
  mine: true,
  priority: 2,
  updatedAt: AT,
  ...over,
});

describe("cleanRemote", () => {
  test("flattens control characters and runs of space into single spaces", () => {
    expect(cleanRemote("  a\r\n\tb\u0000c d  ", 200)).toBe("a b c d");
  });

  test("takes out the invisible characters that reverse or hide text", () => {
    // A right-to-left override can make \"gpj.exe\" read as \"exe.jpg\"; C1 controls are noise.
    expect(cleanRemote("Ada\u202eelpmaxE\u202c \u2066x\u2069\u0085y", 200)).toBe("Ada elpmaxE x y");
  });

  // Characters that take no space on screen, so a name can hold one and
  // still look like another: removed outright, joining what they split.
  test.each([
    ["a zero-width space", "\u200b"],
    ["a zero-width non-joiner", "\u200c"],
    ["a zero-width joiner", "\u200d"],
    ["a word joiner", "\u2060"],
    ["a byte-order mark", "\ufeff"],
    ["a left-to-right mark", "\u200e"],
    ["a right-to-left mark", "\u200f"],
    ["an Arabic letter mark", "\u061c"],
    ["a tag character", "\u{e0041}"],
    ["the first and last tag characters", "\u{e0000}\u{e007f}"],
  ])("%s is taken out of a name and a subject", (_name, hidden) => {
    expect(cleanRemote(`Ada Ex${hidden}ample`, 100)).toBe("Ada Example");
    expect(cleanRemote(`${hidden}Made-up ${hidden}subject${hidden}`, 200)).toBe("Made-up subject");
    expect(cleanRemote(hidden.repeat(5), 200)).toBe("");
  });

  test("cuts to the cap, ending in an ellipsis", () => {
    const cut = cleanRemote("x".repeat(300), 200);
    expect(cut).toHaveLength(200);
    expect(cut.endsWith("…")).toBe(true);
  });

  test.each([[null], [7], [{}], [["a"]]])("%j is not text", (value) => {
    expect(cleanRemote(value, 200)).toBe("");
  });
});

describe("cleanAddress", () => {
  test("trims and lower-cases", () => {
    expect(cleanAddress(" Ada@Example-Fund.TEST ")).toBe("ada@example-fund.test");
  });

  test.each([[""], ["ada"], ["a@b"], ["a b@c.test"], ["<a@b.test>"], [7]])(
    "%j is not an address",
    (value) => {
      expect(cleanAddress(value)).toBe("");
    },
  );

  // An address is printable ASCII with one "@", and nothing else: it is shown,
  // grouped by its domain and compared with the owner's own.
  test.each([
    ["a direction override", "ada\u202e@example-fund.test"],
    ["a direction override in the domain", "ada@example\u202efund.test"],
    ["a control character", "ada\u0007@example-fund.test"],
    ["a delete character", "ada\u007f@example-fund.test"],
    ["a C1 control", "ada@example-fund\u0085.test"],
    ["a zero-width space", "ada\u200b@example-fund.test"],
    ["a right-to-left mark", "ada@\u200fexample-fund.test"],
    ["a byte-order mark", "ada\ufeff@example-fund.test"],
    ["a tag character", "ada@example-fund.test\u{e0041}"],
    ["a letter that only looks Latin", "аda@example-fund.test"],
    ["a non-ASCII domain", "ada@exämple.test"],
    ["two @ signs", "ada@evil.test@example-fund.test"],
    ["an inner space", "ada @example-fund.test"],
  ])("an address with %s is not an address", (_name, value) => {
    expect(cleanAddress(value)).toBe("");
  });

  test("the ordinary punctuation of an address is kept", () => {
    expect(cleanAddress("ada.o'neil+notes_1@mail.example-fund.test")).toBe(
      "ada.o'neil+notes_1@mail.example-fund.test",
    );
  });
});

describe("cleanDomain", () => {
  test("strips the @ and lower-cases", () => {
    expect(cleanDomain(" @Example-Fund.test ")).toBe("example-fund.test");
  });

  test.each([[""], ["fund"], ["a b.test"], ["https://x.test"], ["x@y.test"]])(
    "%j is not a domain",
    (value) => {
      expect(cleanDomain(value)).toBeNull();
    },
  );
});

describe("groupOf", () => {
  const lists = {
    investorDomains: ["example-fund.test", "both.test"],
    customerDomains: ["clinic.test", "both.test"],
  };

  test("a listed domain and its subdomains take that list's group", () => {
    expect(groupOf("ada@example-fund.test", lists)).toBe("investor");
    expect(groupOf("ada@mail.example-fund.test", lists)).toBe("investor");
    expect(groupOf("bo@clinic.test", lists)).toBe("customer");
    expect(groupOf("bo@north.clinic.test", lists)).toBe("customer");
  });

  test("a domain in both lists is an investor", () => {
    expect(groupOf("cy@both.test", lists)).toBe("investor");
  });

  test("a domain that only ends with a listed one does not match", () => {
    expect(groupOf("dee@notclinic.test", lists)).toBe("other");
  });

  test("anything else is other", () => {
    expect(groupOf("eve@elsewhere.test", lists)).toBe("other");
    expect(groupOf("", lists)).toBe("other");
  });
});

describe("isLinearUrl", () => {
  test("an issue's page on linear.app", () => {
    expect(isLinearUrl("https://linear.app/startup/issue/ENG-1/a-title")).toBe(true);
  });

  test.each([
    ["javascript:alert(1)"],
    ["http://linear.app/x"],
    ["https://linear.app.evil.test/x"],
    ["https://linear.app/a b"],
    [`https://linear.app/${"x".repeat(300)}`],
  ])("%s is refused", (url) => {
    expect(isLinearUrl(url)).toBe(false);
  });
});

describe("keyOf", () => {
  test("names each kind's id and the time it sorts by", () => {
    expect(keyOf(mail())).toEqual({ externalId: "a1", sortAt: AT });
    expect(keyOf(issue())).toEqual({ externalId: "i1", sortAt: AT });
  });
});

describe("refusal", () => {
  test("a clean batch and an empty batch are accepted", () => {
    expect(refusal("gmail", [mail(), mail({ threadId: "a2" })])).toBeNull();
    expect(refusal("gmail", [])).toBeNull();
    expect(refusal("linear", [issue()])).toBeNull();
  });

  test("counts the bad records and never quotes one", () => {
    const rows = [
      mail(),
      mail({ threadId: "a2", subject: "REMOTE-TEXT".repeat(400).slice(0, 4000) }),
      mail({ threadId: "a3", fromAddress: "REMOTE-TEXT not an address" }),
    ];
    const message = refusal("gmail", rows);
    expect(message).toBe(
      "2 of 3 records broke the size and shape rules, so nothing was written.",
    );
    expect(message).not.toContain("REMOTE-TEXT");
  });

  const broken: [string, "gmail" | "linear", MirrorRecord[]][] = [
    ["a record of another source's kind", "gmail", [issue()]],
    ["two records with one id", "gmail", [mail(), mail()]],
    ["an empty id", "gmail", [mail({ threadId: "" })]],
    ["a control character in a subject", "gmail", [mail({ subject: "a\nb" })]],
    ["a direction override in a sender's name", "gmail", [mail({ fromName: "Ada\u202eelpmaxE" })]],
    ["a zero-width space in a subject", "gmail", [mail({ subject: "Made\u200b-up" })]],
    ["a right-to-left mark in a sender's name", "gmail", [mail({ fromName: "Ada\u200f Example" })]],
    ["a tag character in a sender's name", "gmail", [mail({ fromName: "Ada\u{e0041}" })]],
    ["a direction override in an address", "gmail", [mail({ fromAddress: "ada\u202e@example-fund.test" })]],
    ["a control character in an address", "gmail", [mail({ fromAddress: "ada\u0007@example-fund.test" })]],
    ["a non-ASCII address", "gmail", [mail({ fromAddress: "аda@example-fund.test" })]],
    ["a link to Linear that is not https", "linear", [issue({ url: "http://linear.app/startup/issue/ENG-1" })]],
    ["a time that is not a number", "gmail", [mail({ lastMessageAt: Number.NaN })]],
    ["a time in seconds, not milliseconds", "gmail", [mail({ lastMessageAt: 1_760_000_000 })]],
    ["a sender with no address", "gmail", [mail({ fromAddress: "" })]],
    ["an upper-case address", "gmail", [mail({ fromAddress: "Ada@Example-Fund.test" })]],
    ["a link that is not Linear's", "linear", [issue({ url: "javascript:alert(1)" })]],
    ["a priority out of range", "linear", [issue({ priority: 9 })]],
    ["a due date that is not a day", "linear", [issue({ dueDate: "soon" })]],
  ];
  test.each(broken)("%s is refused", (_name, source, rows) => {
    expect(refusal(source, rows)).toMatch(/broke the size and shape rules/);
  });

  test("more than the cap is refused outright", () => {
    const rows = Array.from({ length: MAX_MIRROR_ROWS + 1 }, (_, n) =>
      mail({ threadId: `a${n}` }),
    );
    expect(refusal("gmail", rows)).toBe("More than 1000 records in one read.");
  });
});
