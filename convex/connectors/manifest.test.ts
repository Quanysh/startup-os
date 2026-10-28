import { afterEach, describe, expect, test, vi } from "vitest";
import { METRICS } from "../lib/metricRegistry";
import { MIRROR_SOURCES } from "../lib/mirrorRules";
import { SOURCES, feedOf, missingEnv, type SourceDef } from "./manifest";

// Obviously not real secrets.
const TOKEN = "fake-ingest-token-0123456789-abcdefghij";
const def = (id: string): SourceDef => SOURCES.find((s) => s.id === id)!;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("feedOf", () => {
  test("typed-in numbers are manual", () => {
    expect(feedOf(def("manual"))).toBe("manual");
  });

  test("an ingest source is pushed once its token is set, and nothing before", () => {
    expect(feedOf(def("cfo_workbook"))).toBeNull();
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", TOKEN);
    expect(feedOf(def("cfo_workbook"))).toBe("push");
  });

  test("a pulled source with neither its key nor a token is not fed", () => {
    expect(feedOf(def("mercury"))).toBeNull();
  });

  test("a pulled source with its key is pulled", () => {
    vi.stubEnv("MERCURY_API_TOKEN", "fake-mercury-token");
    expect(feedOf(def("mercury"))).toBe("pull");
  });

  test("a pulled source with only an ingest token is pushed", () => {
    vi.stubEnv("INGEST_TOKEN_MERCURY", TOKEN);
    expect(feedOf(def("mercury"))).toBe("push");
  });

  test("with both set it stays pulled: one writer at a time", () => {
    vi.stubEnv("MERCURY_API_TOKEN", "fake-mercury-token");
    vi.stubEnv("INGEST_TOKEN_MERCURY", TOKEN);
    expect(feedOf(def("mercury"))).toBe("pull");
  });

  test("some of its variables is not all of them: the token decides", () => {
    vi.stubEnv("POSTHOG_PROJECT_ID", "12345");
    expect(feedOf(def("posthog"))).toBeNull();
    vi.stubEnv("INGEST_TOKEN_POSTHOG", TOKEN);
    expect(feedOf(def("posthog"))).toBe("push");
  });

  test("a token too short to be a secret feeds nothing", () => {
    vi.stubEnv("INGEST_TOKEN_MERCURY", "short");
    expect(feedOf(def("mercury"))).toBeNull();
  });

  test("a pulled source that is not declared pushable ignores a token", () => {
    vi.stubEnv("INGEST_TOKEN_VERCEL", TOKEN);
    expect(feedOf(def("vercel"))).toBeNull();
  });

  test("exactly these pulled sources may be pushed", () => {
    const pushable = SOURCES.filter((s) => s.pushable).map((s) => s.id);
    expect([...pushable].sort()).toEqual(
      ["apollo", "mercury", "posthog", ...MIRROR_SOURCES].sort(),
    );
    for (const id of pushable) expect(def(id).kind).toBe("api");
  });
});

describe("the source that carries the plan", () => {
  test("only the financial model may send a plan, on its own ingest token", () => {
    expect(SOURCES.filter((s) => s.plan).map((s) => s.id)).toEqual(["financial_model"]);
    expect(def("financial_model")).toMatchObject({
      kind: "ingest",
      named: "the financial model",
      requiredEnv: ["INGEST_TOKEN_FINANCIAL_MODEL"],
    });
  });

  test("it owns no metric, so its token can write no number", () => {
    const owners = METRICS.flatMap((metric) => Object.values(metric.sources));
    expect(owners).not.toContain("financial_model");
  });

  test("it is pushed once its token is set, and nothing before", () => {
    expect(feedOf(def("financial_model"))).toBeNull();
    vi.stubEnv("INGEST_TOKEN_FINANCIAL_MODEL", TOKEN);
    expect(feedOf(def("financial_model"))).toBe("push");
  });
});

describe("the source that sends tasks", () => {
  test("only the standup does, on its own ingest token", () => {
    expect(SOURCES.filter((s) => s.tasks).map((s) => s.id)).toEqual(["standup"]);
    expect(def("standup")).toMatchObject({
      kind: "ingest",
      short: "Standup",
      named: "the standup",
      requiredEnv: ["INGEST_TOKEN_STANDUP"],
    });
  });

  test("it owns no metric, carries no register and no plan, and is not a pulled source", () => {
    const owners = METRICS.flatMap((metric) => Object.values(metric.sources));
    expect(owners).not.toContain("standup");
    expect(def("standup")).not.toHaveProperty("customers");
    expect(def("standup")).not.toHaveProperty("plan");
    expect(def("standup")).not.toHaveProperty("pushable");
    expect(MIRROR_SOURCES as readonly string[]).not.toContain("standup");
  });

  test("it is configured once its token is set, and not before", () => {
    expect(feedOf(def("standup"))).toBeNull();
    vi.stubEnv("INGEST_TOKEN_STANDUP", TOKEN);
    expect(feedOf(def("standup"))).toBe("push");
  });
});

describe("the sources that put people in the Contacts book", () => {
  test("ride on their source's token and have none of their own", () => {
    expect(SOURCES.filter((s) => s.carriedBy !== undefined).map((s) => [s.id, s.carriedBy])).toEqual([
      ["visible_contacts", "visible"],
      ["apollo_contacts", "apollo"],
      ["gmail_contacts", "gmail"],
      ["google_calendar_contacts", "google_calendar"],
      ["fireflies_contacts", "fireflies"],
      ["kz_crm_contacts", "kz_crm"],
    ]);
    for (const id of ["visible_contacts", "apollo_contacts", "gmail_contacts", "kz_crm_contacts"]) {
      expect(def(id)).toMatchObject({ kind: "ingest" });
      expect(def(id)).not.toHaveProperty("pushable");
    }
    expect(def("visible_contacts").requiredEnv).toEqual(["INGEST_TOKEN_VISIBLE"]);
    expect(def("apollo_contacts").requiredEnv).toEqual(["INGEST_TOKEN_APOLLO"]);
  });

  test("own no metric", () => {
    const owners = METRICS.flatMap((metric) => Object.values(metric.sources));
    expect(owners).not.toContain("visible_contacts");
    expect(owners).not.toContain("apollo_contacts");
  });

  test("are fed when their carrier is pushed, never by a token of their own", () => {
    vi.stubEnv("INGEST_TOKEN_VISIBLE_CONTACTS", TOKEN);
    expect(feedOf(def("visible_contacts"))).toBeNull();
    expect(missingEnv(def("visible_contacts"))).toEqual(["INGEST_TOKEN_VISIBLE"]);
    vi.stubEnv("INGEST_TOKEN_VISIBLE", TOKEN);
    expect(feedOf(def("visible_contacts"))).toBe("push");
    expect(missingEnv(def("visible_contacts"))).toEqual([]);

    vi.stubEnv("INGEST_TOKEN_APOLLO", TOKEN);
    expect(feedOf(def("apollo_contacts"))).toBe("push");
    // While Apollo is read with its own key, its token still carries contacts:
    // the OS's own read brings none, so there is no second writer.
    vi.stubEnv("APOLLO_API_KEY", "fake-apollo-key");
    expect(feedOf(def("apollo"))).toBe("pull");
    expect(feedOf(def("apollo_contacts"))).toBe("push");
  });
});
