import { describe, expect, test } from "vitest";
import {
  insertMention,
  matchPeople,
  mentionParts,
  mentionQuery,
  mentionedIn,
} from "./mentions";

// Every name and address here is made up.
const ADA = { email: "ada@example.com", name: "Ada Example" };
const SAM = { email: "sam.sales@example.com", name: null };
const ADAM = { email: "adam@example.com", name: "Adam Ng" };
const PEOPLE = [ADA, ADAM, SAM];

describe("what is being typed after an @", () => {
  test.each([
    ["@", 1, { at: 0, query: "" }],
    ["@ad", 3, { at: 0, query: "ad" }],
    ["ask @ad", 7, { at: 4, query: "ad" }],
    ["line one\n@sa", 12, { at: 9, query: "sa" }],
    ["(@ad", 4, { at: 1, query: "ad" }],
    // The caret is in the middle of the text: only what is before it counts.
    ["ask @ad about it", 7, { at: 4, query: "ad" }],
  ])("%j with the caret at %i", (value, caret, found) => {
    expect(mentionQuery(value, caret)).toEqual(found);
  });

  test.each([
    ["no at sign", "hello", 5],
    ["an address is not a mention", "mail ada@example", 16],
    ["a space ends it", "@ada ", 5],
    ["the caret is before the @", "ask @ad", 3],
    ["nothing typed", "", 0],
  ])("%s", (_what, value, caret) => {
    expect(mentionQuery(value, caret)).toBeNull();
  });
});

describe("who is offered", () => {
  const names = (query: string) => matchPeople(PEOPLE, query).map((p) => p.label);

  test("everyone, by the name the picker shows, for a bare @", () => {
    expect(names("")).toEqual(["Ada Example", "Adam Ng", "sam.sales"]);
  });

  test("by the start of any word of the name or of the address, whatever the capitals", () => {
    expect(names("AD")).toEqual(["Ada Example", "Adam Ng"]);
    expect(names("ex")).toEqual(["Ada Example"]);
    expect(names("ng")).toEqual(["Adam Ng"]);
    expect(names("sam")).toEqual(["sam.sales"]);
    expect(names("sales")).toEqual(["sam.sales"]);
  });

  test("nobody for something that starts no word", () => {
    expect(names("da")).toEqual([]);
    expect(names("zz")).toEqual([]);
  });

  test("six at most, and none before the list has arrived", () => {
    const many = Array.from({ length: 9 }, (_, n) => ({ email: `p${n}@example.com`, name: null }));
    expect(matchPeople(many, "")).toHaveLength(6);
    expect(matchPeople(undefined, "")).toEqual([]);
  });
});

describe("putting a mention in the text", () => {
  test("replaces what was typed after the @ with the name and a space, and says where the caret goes", () => {
    expect(insertMention("ask @ad about it", 4, 7, "Ada Example")).toEqual({
      value: "ask @Ada Example about it",
      caret: 17,
    });
    expect(insertMention("@", 0, 1, "sam.sales")).toEqual({ value: "@sam.sales ", caret: 11 });
  });
});

describe("who a save mentions", () => {
  const picked = [
    { email: ADA.email, label: "Ada Example" },
    { email: SAM.email, label: "sam.sales" },
  ];

  test("those picked whose @name is still in the title or the description", () => {
    expect(mentionedIn(picked, ["Plan with @Ada Example", "and @sam.sales"])).toEqual([
      ADA.email,
      SAM.email,
    ]);
    expect(mentionedIn(picked, ["Plan with @Ada Example", ""])).toEqual([ADA.email]);
  });

  test("someone picked and then deleted from the text is not mentioned", () => {
    expect(mentionedIn(picked, ["Plan", "nothing here"])).toEqual([]);
    expect(mentionedIn(picked, ["@Ada Exam", ""])).toEqual([]);
  });

  test("picked twice is sent once, and a name only typed is nobody", () => {
    expect(mentionedIn([...picked, picked[0]!], ["@Ada Example @Ada Example"])).toEqual([ADA.email]);
    expect(mentionedIn([], ["@Ada Example"])).toEqual([]);
  });
});

describe("marking mentions in stored text", () => {
  const marked = (text: string, labels: string[]) =>
    mentionParts(text, labels)
      .map((part) => (part.mention ? `[${part.text}]` : part.text))
      .join("");

  test("an @name the card mentions is marked; the rest is as it was", () => {
    expect(marked("Ask @Ada Example about it", ["Ada Example"])).toBe("Ask [@Ada Example] about it");
    expect(marked("@Ada Example, please", ["Ada Example"])).toBe("[@Ada Example], please");
    expect(marked("one\n@Ada Example", ["Ada Example"])).toBe("one\n[@Ada Example]");
  });

  test("the longer name wins where one starts another", () => {
    expect(marked("@Ada Example and @Ada", ["Ada", "Ada Example"])).toBe("[@Ada Example] and [@Ada]");
  });

  test("not inside an address, and not the start of a longer word", () => {
    expect(marked("mail x@Ada Example", ["Ada Example"])).toBe("mail x@Ada Example");
    expect(marked("@Adamant", ["Ada"])).toBe("@Adamant");
  });

  test("a name the card does not mention is only text", () => {
    expect(marked("Ask @Someone Else", ["Ada Example"])).toBe("Ask @Someone Else");
    expect(mentionParts("Ask @Ada", [])).toEqual([{ text: "Ask @Ada", mention: false }]);
  });

  test("a name with characters a pattern would read is matched as written", () => {
    expect(marked("see @a.b (c)+ now", ["a.b (c)+"])).toBe("see [@a.b (c)+] now");
    expect(marked("see @axb", ["a.b"])).toBe("see @axb");
  });

  test("every part put back together is the text, unchanged", () => {
    const text = "  @Ada Example\t<b>@Ada Example</b> & @Adam Ng  ";
    expect(mentionParts(text, ["Ada Example", "Adam Ng"]).map((p) => p.text).join("")).toBe(text);
  });
});
