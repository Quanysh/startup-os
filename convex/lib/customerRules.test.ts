import { describe, expect, test } from "vitest";
import { customerRowProblems } from "./customerRules";
import type { CustomerIngestRow } from "./ingestSchema";

const NOW = Date.UTC(2026, 9, 12, 9);
const clinic = (patch: Partial<CustomerIngestRow> = {}): CustomerIngestRow => ({
  name: "SECRET CLINIC ALPHA",
  market: "kz",
  status: "active",
  ...patch,
});

describe("customerRowProblems", () => {
  test("a clean register has none", () => {
    expect(
      customerRowProblems(
        [clinic({ lastPaymentDate: "2026-10-12" }), clinic({ name: "SECRET CLINIC BETA" })],
        NOW,
      ),
    ).toEqual([]);
  });

  test("the same clinic twice is named by row, not by name", () => {
    const problems = customerRowProblems(
      [clinic(), clinic({ name: "SECRET CLINIC BETA" }), clinic({ name: "  secret  clinic ALPHA " })],
      NOW,
    );
    expect(problems).toEqual([
      { path: "customers.2.name", message: "is the same clinic as row 0" },
    ]);
    expect(JSON.stringify(problems)).not.toContain("SECRET");
  });

  test("a payment or a use dated after tomorrow cannot have happened", () => {
    expect(
      customerRowProblems(
        [clinic({ lastPaymentDate: "2026-10-14", lastUsageDate: "2026-11-01" })],
        NOW,
      ),
    ).toEqual([
      { path: "customers.0.lastPaymentDate", message: "is in the future" },
      { path: "customers.0.lastUsageDate", message: "is in the future" },
    ]);
  });

  test("tomorrow is allowed: the sender's day can be ahead of UTC", () => {
    expect(customerRowProblems([clinic({ lastPaymentDate: "2026-10-13" })], NOW)).toEqual([]);
  });

  test("a contract or a BAA may be dated ahead", () => {
    expect(
      customerRowProblems([clinic({ contractDate: "2027-01-01", baaDate: "2026-12-01" })], NOW),
    ).toEqual([]);
  });
});
