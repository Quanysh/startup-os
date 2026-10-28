import { existsSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { AGENT_TOKEN_PREFIX } from "./agentRules";
import { APPROVALS_URL } from "./approvalsDigest";
import { PREVIOUS_SIGNATURE_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "./botEvents";
import { ALL_COMPANY_IDS, COMPANIES, hashtagOf } from "./company";
import { HANDOFF_REPAIR_BY } from "./handoffs";
import { CURRENCIES } from "./metricRegistry";
import {
  APP_HOST,
  APP_URL,
  COMPANY_IDENTITY,
  HEADER_PREFIX,
  LAUNCHD_LABEL,
  PRODUCT,
  TELEGRAM_WEBHOOK_LABEL,
  TOKEN_STEM,
} from "./identity";
import { SERVER_INFO } from "./mcpProtocol";
import {
  ACCESS_TOKEN_PREFIX,
  CLIENT_ID_PREFIX,
  CLIENT_SECRET_PREFIX,
  CODE_PREFIX,
  REFRESH_TOKEN_PREFIX,
  protectedResourceMetadata,
} from "./oauthRules";
import { AGENT_HEADER, RUN_HEADER } from "./osAgents";
import { PERSONAL_TOKEN_PREFIX } from "./personalRules";
import { INTERNAL_PROJECT, INTERNAL_PROJECT_NAME } from "./agentProjects";
import { LABEL } from "../../scripts/assistantLaunchd";
import { PRODUCTION_URL, SERVER_NAME } from "../../scripts/assistantConfig";
import { ingestUrlProblem } from "../../scripts/ingestUrl";
import { MCP_SERVER_NAME } from "../../src/lib/assistant/snippets";

// The shape any fork's identity must have. These hold whatever the values are.
describe("the identity's shape", () => {
  test("the product has every name, none blank", () => {
    for (const value of [PRODUCT.name, PRODUCT.shortName, PRODUCT.description, PRODUCT.slug]) {
      expect(value.trim()).toBe(value);
      expect(value.length).toBeGreaterThan(0);
    }
    expect(PRODUCT.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(PRODUCT.description.endsWith(".")).toBe(false);
  });

  test("the address is an https origin on the app's host", () => {
    expect(APP_URL).toBe(`https://${APP_HOST}`);
    expect(new URL(APP_URL).origin).toBe(APP_URL);
  });

  test("every company has its display data, and a parent is a company", () => {
    expect(Object.keys(COMPANY_IDENTITY).sort()).toEqual([...ALL_COMPANY_IDS].sort());
    for (const id of ALL_COMPANY_IDS) {
      const company: { name: string; legalName: string; marketLabel: string; parent?: string } =
        COMPANY_IDENTITY[id];
      expect(company.name.length).toBeGreaterThan(0);
      expect(company.legalName.length).toBeGreaterThan(0);
      expect(company.marketLabel.length).toBeGreaterThan(0);
      // A currency the OS knows: its figures are stored, formatted and converted in it.
      expect(CURRENCIES).toContain(COMPANY_IDENTITY[id].currency);
      if (company.parent !== undefined) {
        expect(ALL_COMPANY_IDS).toContain(company.parent);
        expect(company.parent).not.toBe(id);
      }
    }
  });

  test("every company has its Telegram hashtags: plain, its own, and no other board's word", () => {
    const all = ALL_COMPANY_IDS.flatMap((id) => [...COMPANY_IDENTITY[id].hashtags]);
    for (const id of ALL_COMPANY_IDS) expect(COMPANY_IDENTITY[id].hashtags.length).toBeGreaterThan(0);
    for (const tag of all) {
      // Matched lower-cased, without the "#", as Telegram marks a hashtag.
      expect(tag).toMatch(/^[a-z0-9_]{1,64}$/);
      // The ids and "both"/"shared" are hashtags the bot reads already.
      expect([...ALL_COMPANY_IDS, "both", "shared"]).not.toContain(tag);
    }
    expect(new Set(all).size).toBe(all.length);
  });

  test("tokens, headers and labels are plain", () => {
    expect(TOKEN_STEM).toMatch(/^[a-z]{3}$/);
    expect(HEADER_PREFIX).toMatch(/^X-[A-Za-z][A-Za-z-]*[A-Za-z]$/);
    expect(TELEGRAM_WEBHOOK_LABEL).toMatch(/^[a-z0-9-]+$/);
    expect(LAUNCHD_LABEL).toMatch(/^[a-z0-9]+(\.[a-z0-9-]+)+$/);
  });

  test("the app icon is where Next.js looks for it", () => {
    expect(existsSync(new URL("../../src/app/icon.svg", import.meta.url))).toBe(true);
  });
});

// Everything that used to write a name or the address out now reads it here.
describe("what reads the identity", () => {
  test("COMPANIES is built from it, field for field", () => {
    for (const id of ALL_COMPANY_IDS) {
      const { logo: _logo, hashtags: _hashtags, ...display } = COMPANY_IDENTITY[id];
      expect(COMPANIES[id]).toEqual({ id, ...display });
    }
  });

  test("the addresses are the app's", () => {
    expect(APPROVALS_URL).toBe(`${APP_URL}/approvals`);
    expect(PRODUCTION_URL).toBe(`${APP_URL}/mcp/v1`);
    expect(ingestUrlProblem(`${APP_URL}/ingest/v1`)).toBeNull();
  });

  test("the product's slug names the MCP server, the agent project and the runner's entry", () => {
    expect(SERVER_INFO.name).toBe(PRODUCT.slug);
    expect(SERVER_INFO.title).toBe(PRODUCT.name);
    expect(SERVER_NAME).toBe(PRODUCT.slug);
    expect(MCP_SERVER_NAME).toBe(PRODUCT.slug);
    expect(INTERNAL_PROJECT).toBe(PRODUCT.slug);
    expect(INTERNAL_PROJECT_NAME).toBe(PRODUCT.name);
    expect(protectedResourceMetadata(APP_URL).resource_name).toBe(PRODUCT.name);
    // What a repair of a handoff signs itself as.
    expect(HANDOFF_REPAIR_BY).toBe(PRODUCT.slug);
  });

  test("a board's hashtag in Telegram is its company's first", () => {
    for (const id of ALL_COMPANY_IDS) expect(hashtagOf(id)).toBe(`#${COMPANY_IDENTITY[id].hashtags[0]}`);
  });

  test("headers, tokens and the launchd label come from it", () => {
    for (const header of [AGENT_HEADER, RUN_HEADER, TIMESTAMP_HEADER, SIGNATURE_HEADER, PREVIOUS_SIGNATURE_HEADER]) {
      expect(header.startsWith(`${HEADER_PREFIX}-`)).toBe(true);
    }
    for (const prefix of [
      PERSONAL_TOKEN_PREFIX,
      AGENT_TOKEN_PREFIX,
      ACCESS_TOKEN_PREFIX,
      REFRESH_TOKEN_PREFIX,
      CODE_PREFIX,
      CLIENT_ID_PREFIX,
      CLIENT_SECRET_PREFIX,
    ]) {
      expect(prefix.startsWith(TOKEN_STEM)).toBe(true);
    }
    expect(LABEL).toBe(LAUNCHD_LABEL);
  });
});

// This deployment's own values are pinned in convex/lib/deployment.test.ts.
