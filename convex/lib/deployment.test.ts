import { describe, expect, test, vi } from "vitest";
import { AGENT_TOKEN_PREFIX } from "./agentRules";
import { APPROVALS_URL } from "./approvalsDigest";
import { PREVIOUS_SIGNATURE_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "./botEvents";
import { COMPANIES, hashtagOf } from "./company";
import { MADE_UP_DEPLOYMENT } from "./deployment.kit";
import { HANDOFF_REPAIR_BY } from "./handoffs";
import { APP_URL, COMPANY_IDENTITY, PAGE_TITLE, PRODUCT } from "./identity";
import { SERVER_INFO } from "./mcpProtocol";
import {
  ACCESS_TOKEN_PREFIX,
  CLIENT_ID_PREFIX,
  CLIENT_SECRET_PREFIX,
  CODE_PREFIX,
  REFRESH_TOKEN_PREFIX,
} from "./oauthRules";
import { INTERNAL_PROJECT } from "./agentProjects";
import { AGENT_HEADER, RUN_HEADER } from "./osAgents";
import { PERSONAL_TOKEN_PREFIX } from "./personalRules";
import { webhookSecret } from "./telegramCommand";
import { LABEL } from "../../scripts/assistantLaunchd";
import { PRODUCTION_URL, SERVER_NAME } from "../../scripts/assistantConfig";
import { ingestUrlProblem } from "../../scripts/ingestUrl";
import { MCP_SERVER_NAME } from "../../src/lib/assistant/snippets";

// This deployment's own values, pinned: its identity (convex/lib/identity.ts)
// and its switches and outside ids (convex/lib/features.ts). Every other test
// runs as a made-up deployment (convex/test.deployment.ts) and holds whatever
// the values are; this is the one test that pins yours.
//
// As the template ships: the placeholder identity "Startup OS", every switch off
// and placeholder ids. When you put your own values in those two files, put
// them here too.

// The real module, not the made-up deployment every other test runs as.
const features = await vi.importActual<typeof import("./features")>("./features");

describe("the switches and outside ids", () => {
  test("every switch is off: one company, dollars only", () => {
    expect(features.FEATURES).toEqual({
      secondCompany: false,
      subsidiaryFunding: false,
      kzProduct: false,
      supportInbox: false,
      verticalStartupAgents: false,
      startupInsights: false,
      verticalStartupProduct: false,
      kztCurrency: false,
    });
  });

  test("the ids are placeholders", () => {
    expect(features.DEV_REPO).toBe("your-org/your-os");
    expect(features.SUBSIDIARY_COUNTERPARTY).toBe("example subsidiary");
    expect(features.POSTHOG_TEST_COHORT).toBe(0);
    expect(features.INTERCOM_APP_ID).toBe("exampleapp");
    expect(features.LINEAR_TEAM_PREFIXES).toEqual([]);
    expect(features.KZ_APP_HOST).toBe("app.second-company.example.com");
    expect(features.KZ_STAGING_HOST).toBe("staging.second-company.example.com");
    expect(features.TEAM_EMAIL_DOMAIN).toBe("example.com");
    expect(features.KZ_APP_UTC_OFFSET_HOURS).toBe(0);
    expect(features.KZ_TEST_HOST_WORDS).toEqual(["preview.example.com"]);
    expect(features.KZ_FAILURE_WORDS).toEqual({
      gemini_timeout: ["timed out"],
      empty_answer: ["empty answer"],
      schema: ["validation failed"],
      file_type: ["unsupported file type"],
      pdf_instead: ["%PDF"],
      html_instead: ["DOCTYPE"],
      scan_unreadable: ["could not read the scan"],
      required_fields: ["required field"],
      network: ["Failed to fetch", "Load failed"],
      unauthorized: ["Unauthorized"],
      upstream: ["upstream"],
    });
    expect(features.KZ_EXPECTED_MODELS).toEqual({});
    expect(features.GPU.label).toBe("Self-hosted GPU");
    expect(features.FINANCIAL_MODEL_URL).toBe("");
  });

  test("no GitHub organisation is read until you add yours", () => {
    expect(features.GITHUB_ORGS).toEqual([]);
    expect(features.GITHUB_NAME_RULES).toEqual([]);
    expect(features.GITHUB_IGNORED).toEqual([]);
  });

  test("no repository name prefix is claimed by both companies", () => {
    const of = (company: "us" | "kz") => features.GITHUB_NAME_RULES.filter((rule) => rule.company === company).flatMap((rule) => rule.prefixes);
    for (const a of of("kz")) {
      for (const b of of("us")) expect(a.startsWith(b) || b.startsWith(a), `${a} / ${b}`).toBe(false);
    }
  });

  test("the made-up deployment the other tests run as has every id this one has, and no other", () => {
    const { FEATURES: _switches, ...ids } = features;
    expect(Object.keys(MADE_UP_DEPLOYMENT).sort()).toEqual(Object.keys(ids).sort());
  });
});

// The identity, as the template ships it: placeholders.
describe("the identity", () => {
  test("the product and the page title", () => {
    expect(PRODUCT).toEqual({
      name: "Startup OS",
      shortName: "OS",
      description: "The company's internal operating system",
      slug: "startup-os",
      logo: "startup",
    });
    expect(PAGE_TITLE).toEqual({ template: "%s · Startup OS", default: "Startup OS" });
  });

  test("the companies' names and legal names", () => {
    expect(COMPANIES).toEqual({
      us: { id: "us", name: "Startup", marketLabel: "US", legalName: "Startup Inc", currency: "USD" },
      kz: { id: "kz", name: "Globex", marketLabel: "KZ", legalName: "Globex LLP", parent: "us", currency: "KZT" },
    });
  });

  test("the Telegram hashtags, as the groups already type them", () => {
    expect(COMPANY_IDENTITY.us.hashtags).toEqual(["startup"]);
    expect(COMPANY_IDENTITY.kz.hashtags).toEqual(["globex", "globexai"]);
    expect([hashtagOf("us"), hashtagOf("kz")]).toEqual(["#startup", "#globex"]);
  });

  test("the handoff repair's signature", () => {
    expect(HANDOFF_REPAIR_BY).toBe("startup-os");
  });

  test("the addresses", () => {
    expect(APP_URL).toBe("https://os.example.com");
    expect(APPROVALS_URL).toBe("https://os.example.com/approvals");
    expect(PRODUCTION_URL).toBe("https://os.example.com/mcp/v1");
    expect(ingestUrlProblem("https://os.example.com/ingest/v1")).toBeNull();
    expect(ingestUrlProblem("https://os.example.test/ingest/v1")).toBe(
      "STARTUP_OS_INGEST_URL must be a *.convex.site address, https://os.example.com, or localhost.",
    );
  });

  test("the MCP server and the agent project", () => {
    expect(SERVER_INFO).toEqual({ name: "startup-os", title: "Startup OS", version: "1.0.0" });
    expect([SERVER_NAME, MCP_SERVER_NAME, INTERNAL_PROJECT]).toEqual(["startup-os", "startup-os", "startup-os"]);
  });

  test("the header names", () => {
    expect([AGENT_HEADER, RUN_HEADER, TIMESTAMP_HEADER, SIGNATURE_HEADER, PREVIOUS_SIGNATURE_HEADER]).toEqual([
      "X-Startup-Agent",
      "X-Startup-Run",
      "X-Startup-Timestamp",
      "X-Startup-Signature",
      "X-Startup-Signature-Previous",
    ]);
  });

  test("the token prefixes", () => {
    expect([
      PERSONAL_TOKEN_PREFIX,
      AGENT_TOKEN_PREFIX,
      ACCESS_TOKEN_PREFIX,
      REFRESH_TOKEN_PREFIX,
      CODE_PREFIX,
      CLIENT_ID_PREFIX,
      CLIENT_SECRET_PREFIX,
    ]).toEqual(["sos_", "sosa_", "soso_", "sosr_", "sosx_", "sosc_", "sosk_"]);
  });

  test("the Telegram webhook's secret is still an HMAC of the same label", async () => {
    const encoder = new TextEncoder();
    const token = "123456:made-up-bot-token";
    const key = await crypto.subtle.importKey("raw", encoder.encode(token), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    const signed = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode("startup-os-webhook-v1")));
    const expected = [...signed].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(await webhookSecret(token)).toBe(expected);
  });

  test("the launchd label", () => {
    expect(LABEL).toBe("ai.startup.os.assistant");
  });
});
