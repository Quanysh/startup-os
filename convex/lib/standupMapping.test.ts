import { describe, expect, test } from "vitest";
import {
  classifyCompany,
  matchPerson,
  nameKey,
  similarity,
  type CompanyEntity,
  type NamedPerson,
} from "./standupMapping";

// Every name, clinic, deal and repository here is made up.

const PEOPLE: NamedPerson[] = [
  { email: "lena@example.test", name: "Lena Sample", companies: ["us", "kz"] },
  { email: "konstantin@example.test", name: "Konstantin Example", companies: ["kz"] },
  { email: "oskar.s@example.test", name: null, companies: ["us"] },
  { email: "bahram@kz.example.test", name: "Bahram Demo", companies: ["kz"] },
];

describe("nameKey", () => {
  test("case, accents, punctuation and Cyrillic do not matter", () => {
    expect(nameKey("  Léna S. ")).toBe("lena s");
    expect(nameKey("Константин")).toBe("konstantin");
    expect(nameKey("Жандос")).toBe("zhandos");
    expect(nameKey("Әсем Құл")).toBe("asem kul");
  });
});

describe("similarity", () => {
  test("is 1 for the same key and falls with each difference", () => {
    expect(similarity("lena", "lena")).toBe(1);
    expect(similarity("konstantin", "konstantim")).toBeGreaterThanOrEqual(0.9);
    expect(similarity("lena", "luna")).toBeLessThan(0.9);
    expect(similarity("", "lena")).toBe(0);
  });
});

describe("matchPerson", () => {
  test("an exact name, a first name or an address's own part is a match", () => {
    expect(matchPerson("Lena Sample", PEOPLE)).toBe("lena@example.test");
    expect(matchPerson("Lena", PEOPLE)).toBe("lena@example.test");
    expect(matchPerson("Lena S.", PEOPLE)).toBe("lena@example.test");
    // No name on record yet: the address before the "@" still answers.
    expect(matchPerson("Oskar", PEOPLE)).toBe("oskar.s@example.test");
  });

  test("the same name written in Cyrillic is a match", () => {
    expect(matchPerson("Константин", PEOPLE)).toBe("konstantin@example.test");
    expect(matchPerson("Лена", PEOPLE)).toBe("lena@example.test");
  });

  test("a near spelling at 0.9 or above is a match; further is nobody", () => {
    expect(matchPerson("Konstantim", PEOPLE)).toBe("konstantin@example.test");
    expect(matchPerson("Бахрам", PEOPLE)).toBe("bahram@kz.example.test");
    expect(matchPerson("Luna", PEOPLE)).toBeNull();
    expect(matchPerson("Someone Else", PEOPLE)).toBeNull();
  });

  test("two people who fit equally are nobody: the OS never guesses", () => {
    const twins: NamedPerson[] = [
      { email: "lena.a@example.test", name: "Lena Abbott", companies: ["us"] },
      { email: "lena.b@example.test", name: "Lena Brook", companies: ["us"] },
    ];
    expect(matchPerson("Lena", twins)).toBeNull();
    expect(matchPerson("Lena Brook", twins)).toBe("lena.b@example.test");
  });

  test("nothing, an address or one letter is nobody", () => {
    expect(matchPerson(undefined, PEOPLE)).toBeNull();
    expect(matchPerson("", PEOPLE)).toBeNull();
    expect(matchPerson("d", PEOPLE)).toBeNull();
  });
});

const ENTITIES: CompanyEntity[] = [
  { name: "Example Dental", company: "kz" },
  { name: "Brightside Specialty", company: "us" },
  { name: "vertical-startup", company: "us" },
  { name: "globex-crm", company: "kz" },
  // Too short to tell anything by.
  { name: "AI", company: "us" },
];

describe("classifyCompany", () => {
  test("a clinic, a deal or a repository named in the text decides it", () => {
    expect(classifyCompany("Send the contract to Example Dental", ENTITIES)).toBe("kz");
    expect(classifyCompany("Book a demo with Brightside Specialty", ENTITIES)).toBe("us");
    expect(classifyCompany("Fix the build in vertical-startup", ENTITIES)).toBe("us");
    expect(classifyCompany("Перенести отчёты в globex crm", ENTITIES)).toBe("kz");
  });

  test("the companies' own words decide it when no name does", () => {
    expect(classifyCompany("Check the CPT codes on the denial list", [])).toBe("us");
    expect(classifyCompany("Выставить счёт в тенге", [])).toBe("kz");
    expect(classifyCompany("Update the Globex landing page", [])).toBe("kz");
  });

  test("a name counts for more than a word; an even split or nothing is unclear", () => {
    expect(classifyCompany("Example Dental asked about payer rules", ENTITIES)).toBe("kz");
    expect(classifyCompany("Compare Example Dental with Brightside Specialty", ENTITIES)).toBeNull();
    expect(classifyCompany("Post the designer role", ENTITIES)).toBeNull();
    // "AI" is too short a name to decide anything.
    expect(classifyCompany("Read about AI agents", ENTITIES)).toBeNull();
  });
});
