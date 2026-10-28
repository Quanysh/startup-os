import { describe, expect, test } from "vitest";
import { isAgentToken } from "./agentRules";
import {
  INTERNAL_PROJECT,
  LAUNCH_WORDS,
  LEGACY_PROJECT,
  PATIENT_DATA_PROVIDERS,
  PROJECT_SLUG_PATTERN,
  PROJECT_WORDS,
  allowedProvidersProblem,
  failModeOf,
  isProjectToken,
  matchesVersion,
  projectTokenFrom,
  providerPolicyProblem,
  providersFor,
  setupText,
} from "./agentProjects";
import { isPersonalToken } from "./personalRules";

describe("projects", () => {
  test("a project holding patient data fails closed; one that does not fails open", () => {
    expect(failModeOf(true)).toBe("closed");
    expect(failModeOf(false)).toBe("open");
  });

  test("only Vertex AI is for patient data; a project without it may use every known provider", () => {
    expect(PATIENT_DATA_PROVIDERS).toEqual(["vertex"]);
    expect(providersFor(true)).toEqual(["vertex"]);
    expect(providersFor(false)).toEqual(["ai_studio", "vertex", "astana_gpu"]);
  });

  test("a patient-data project's allowed providers are patient-data providers only", () => {
    expect(allowedProvidersProblem(["vertex"], true)).toBeNull();
    expect(allowedProvidersProblem(["vertex", "ai_studio"], true)).toBe(PROJECT_WORDS.patientProviders);
    expect(allowedProvidersProblem(["astana_gpu"], true)).toBe(PROJECT_WORDS.patientProviders);
    expect(allowedProvidersProblem(["ai_studio", "astana_gpu"], false)).toBeNull();
    expect(allowedProvidersProblem([], false)).toBe(PROJECT_WORDS.providers);
    expect(allowedProvidersProblem(["made_up"], false)).toBe(PROJECT_WORDS.providers);
    expect(allowedProvidersProblem(["vertex", "vertex"], false)).toBe(PROJECT_WORDS.providers);
  });

  test("a provider is chosen among the project's own, and for patient data where the project or agent needs it", () => {
    const patients = { allowedProviders: ["vertex"], holdsPatientData: true };
    const plain = { allowedProviders: ["ai_studio", "vertex"], holdsPatientData: false };
    expect(providerPolicyProblem("vertex", patients, false)).toBeNull();
    expect(providerPolicyProblem("ai_studio", patients, false)).toBe(LAUNCH_WORDS.notAllowed);
    expect(providerPolicyProblem("ai_studio", { ...patients, allowedProviders: ["ai_studio"] }, false)).toBe(
      LAUNCH_WORDS.patientData,
    );
    expect(providerPolicyProblem("ai_studio", plain, false)).toBeNull();
    expect(providerPolicyProblem("astana_gpu", plain, false)).toBe(LAUNCH_WORDS.notAllowed);
    // An agent that says it handles patient data is held to the rule in any project.
    expect(providerPolicyProblem("ai_studio", plain, true)).toBe(LAUNCH_WORDS.phiAgent);
    expect(providerPolicyProblem("vertex", plain, true)).toBeNull();
  });

  test("slugs: the legacy and internal projects are slugs too", () => {
    for (const slug of [LEGACY_PROJECT, INTERNAL_PROJECT, "startup-atlas", "globex"]) {
      expect(PROJECT_SLUG_PATTERN.test(slug)).toBe(true);
    }
    for (const slug of ["", "a", "Policy", "startup_atlas", "-x", "x".repeat(41)]) {
      expect(PROJECT_SLUG_PATTERN.test(slug)).toBe(false);
    }
  });
});

describe("the project token", () => {
  test("is told from every other token by its prefix", () => {
    const token = projectTokenFrom(new Uint8Array(32).fill(7));
    expect(token).toMatch(/^rap_[A-Za-z0-9_-]{43}$/);
    expect(isProjectToken(token)).toBe(true);
    expect(isAgentToken(token)).toBe(false);
    expect(isPersonalToken(token)).toBe(false);
    expect(isProjectToken("sosa_abc")).toBe(false);
    expect(isProjectToken("sos_abc")).toBe(false);
    expect(isProjectToken(`rap_${"x".repeat(300)}`)).toBe(false);
  });

  test("the setup text names the two variables, with placeholders where nothing is given", () => {
    expect(setupText("https://made-up-123.convex.site", "rap_x")).toBe(
      "STARTUP_AGENTS_URL=https://made-up-123.convex.site\nSTARTUP_AGENTS_TOKEN=rap_x",
    );
    expect(setupText(null, null)).toContain("STARTUP_AGENTS_TOKEN=<the token shown once>");
  });
});

describe("If-None-Match", () => {
  test("matches the version as an entity tag, weak or in a list; nothing else", () => {
    expect(matchesVersion('"7"', 7)).toBe(true);
    expect(matchesVersion('W/"7"', 7)).toBe(true);
    expect(matchesVersion('"3", "7"', 7)).toBe(true);
    expect(matchesVersion('"6"', 7)).toBe(false);
    expect(matchesVersion("7", 7)).toBe(false);
    expect(matchesVersion("*", 7)).toBe(false);
    expect(matchesVersion(null, 7)).toBe(false);
  });
});
