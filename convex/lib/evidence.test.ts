import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import {
  agreementAttention,
  agreementState,
  agreementText,
  coverageByFramework,
  evidenceStatus,
  hasValidEvidence,
  type AgreementRow,
  type EvidenceItemRow,
} from "./evidence";

const TODAY = "2026-10-18";
const NOW = Date.UTC(2026, 9, 18, 12);

const agreement = (patch: Partial<AgreementRow> = {}): AgreementRow => ({
  id: "a" as Id<"vendorAgreements">,
  vendor: "Initech",
  type: "baa",
  company: "us",
  signedOn: null,
  expiresOn: null,
  status: "active",
  link: null,
  notes: null,
  changedBy: null,
  changedAt: 1,
  ...patch,
});
const item = (patch: Partial<EvidenceItemRow> = {}): EvidenceItemRow => ({
  id: "i" as Id<"evidenceItems">,
  title: "Screenshot",
  link: null,
  owner: null,
  collectedOn: null,
  validUntil: null,
  status: "collected",
  changedBy: null,
  changedAt: 1,
  ...patch,
});

describe("evidenceStatus", () => {
  test("collected or accepted evidence past its date reads as expired", () => {
    expect(evidenceStatus(item({ validUntil: "2026-10-17" }), TODAY)).toBe("expired");
    expect(evidenceStatus(item({ status: "accepted", validUntil: "2026-10-01" }), TODAY)).toBe("expired");
  });
  test("a date of today still counts; no date never expires", () => {
    expect(evidenceStatus(item({ validUntil: TODAY }), TODAY)).toBe("collected");
    expect(evidenceStatus(item(), TODAY)).toBe("collected");
  });
  test("missing and expired stay as stored", () => {
    expect(evidenceStatus(item({ status: "missing", validUntil: "2030-01-01" }), TODAY)).toBe("missing");
    expect(evidenceStatus(item({ status: "expired", validUntil: "2030-01-01" }), TODAY)).toBe("expired");
  });
});

describe("coverageByFramework", () => {
  const control = (framework: "hipaa" | "soc2", items: EvidenceItemRow[]) => ({ framework, items });
  test("counts controls with valid evidence out of all, per framework, every one listed", () => {
    const rows = [
      control("hipaa", [item()]),
      control("hipaa", [item({ validUntil: "2026-01-01" })]),
      control("hipaa", []),
      control("soc2", [item({ status: "missing" }), item({ status: "accepted" })]),
    ];
    expect(coverageByFramework(rows, TODAY)).toEqual([
      { framework: "hipaa", total: 3, withEvidence: 1 },
      { framework: "soc2", total: 1, withEvidence: 1 },
      { framework: "iso27001", total: 0, withEvidence: 0 },
    ]);
    expect(coverageByFramework([], TODAY)).toEqual([
      { framework: "hipaa", total: 0, withEvidence: 0 },
      { framework: "soc2", total: 0, withEvidence: 0 },
      { framework: "iso27001", total: 0, withEvidence: 0 },
    ]);
  });
  test("one valid item among expired ones is enough", () => {
    expect(hasValidEvidence({ items: [item({ validUntil: "2026-01-01" }), item()] }, TODAY)).toBe(true);
  });
});

describe("agreements", () => {
  test("only an active, dated agreement is watched", () => {
    expect(agreementState(agreement({ status: "draft", expiresOn: "2026-10-20" }), TODAY).state).toBe("inactive");
    expect(agreementState(agreement({ status: "ended", expiresOn: "2026-01-01" }), TODAY).state).toBe("inactive");
    expect(agreementState(agreement(), TODAY).state).toBe("no_date");
    expect(agreementState(agreement({ expiresOn: "2026-10-17" }), TODAY)).toEqual({ state: "expired", days: -1 });
    expect(agreementState(agreement({ expiresOn: TODAY }), TODAY)).toEqual({ state: "expiring", days: 0 });
    expect(agreementState(agreement({ expiresOn: "2026-12-17" }), TODAY)).toEqual({ state: "expiring", days: 60 });
    expect(agreementState(agreement({ expiresOn: "2026-12-18" }), TODAY).state).toBe("current");
  });

  test("Needs you: counts and dates, never a vendor", () => {
    const rows = [
      agreement({ vendor: "SECRET Co", expiresOn: "2026-10-01" }),
      agreement({ expiresOn: "2026-11-01" }),
      agreement({ expiresOn: "2026-12-01" }),
      agreement({ expiresOn: "2027-06-01" }),
      agreement({ status: "ended", expiresOn: "2026-10-20" }),
    ];
    const items = agreementAttention(rows, TODAY, NOW);
    expect(items.map((i) => [i.id, i.severity, i.title])).toEqual([
      ["agreements:expired", "overdue", "1 vendor agreement past the expiry date"],
      ["agreements:expiring", "due", "2 vendor agreements ending in the next 60 days"],
    ]);
    expect(JSON.stringify(items)).not.toContain("SECRET");
    expect(agreementAttention(rows, TODAY, NOW, 10).map((i) => i.id)).toEqual(["agreements:expired"]);
    expect(agreementAttention([], TODAY, NOW)).toEqual([]);
  });

  test("the words", () => {
    expect(agreementText(agreement({ expiresOn: "2026-10-19" }), TODAY, NOW)).toBe("Expires tomorrow");
    expect(agreementText(agreement({ expiresOn: "2026-10-16" }), TODAY, NOW)).toMatch(/^Expired 2 days ago/);
    expect(agreementText(agreement({ status: "draft" }), TODAY, NOW)).toBe("Draft");
  });
});
