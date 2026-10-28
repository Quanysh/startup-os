import { describe, expect, test } from "vitest";
import {
  CONTACTS_EMPTY,
  CONTACTS_UPSERT_ONLY,
  MAX_INGEST_ROWS,
  isAgentsEnvelope,
  isContactsEnvelope,
  isCustomersEnvelope,
  isPlanEnvelope,
  isRecordsEnvelope,
  parseIngestEnvelope,
} from "./ingestSchema";
import { MAX_CONTACT_PUSH_ROWS, MAX_CUSTOMERS } from "./limits";
import { MAX_MIRROR_ROWS } from "./mirrorRules";

const row = {
  key: "mrr",
  scope: "kz",
  period: "month",
  periodStart: "2026-10-01",
  value: 4_200_000,
  currency: "KZT",
};

const envelope = {
  version: 1,
  source: "cfo_workbook",
  batchId: "retention-2026-10-11",
  observedAt: "2026-10-11T09:30:00Z",
  snapshots: [row],
};

const issuePaths = (raw: unknown) => {
  const result = parseIngestEnvelope(raw);
  return result.ok ? [] : result.issues.map((i) => i.path);
};

describe("parseIngestEnvelope", () => {
  test("accepts a well-formed envelope", () => {
    const result = parseIngestEnvelope(envelope);
    expect(result.ok).toBe(true);
    if (
      result.ok &&
      !isCustomersEnvelope(result.envelope) &&
      !isRecordsEnvelope(result.envelope) &&
      !isPlanEnvelope(result.envelope) &&
      !isAgentsEnvelope(result.envelope) &&
      !isContactsEnvelope(result.envelope)
    ) {
      expect(result.envelope.snapshots?.[0]?.value).toBe(4_200_000);
    } else {
      throw new Error("expected a snapshots envelope");
    }
  });

  test("accepts a row without a currency", () => {
    const { currency: _omit, ...count } = row;
    expect(parseIngestEnvelope({ ...envelope, snapshots: [count] }).ok).toBe(true);
  });

  test("rejects a version other than 1", () => {
    expect(issuePaths({ ...envelope, version: 2 })).toContain("version");
  });

  test("rejects an unknown top-level field", () => {
    // Each of `customers`, `deals` and `investors` once stood here as the
    // unknown field; all three are real now.
    expect(issuePaths({ ...envelope, patients: [] })).toEqual(["envelope"]);
  });

  test("rejects an unknown field on a row", () => {
    const result = parseIngestEnvelope({
      ...envelope,
      snapshots: [{ ...row, clientName: "Clinic A" }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects an empty batch", () => {
    expect(issuePaths({ ...envelope, snapshots: [] })).toContain("snapshots");
  });

  test("rejects a batch over the row cap", () => {
    const snapshots = Array.from({ length: MAX_INGEST_ROWS + 1 }, () => row);
    expect(issuePaths({ ...envelope, snapshots })).toContain("snapshots");
  });

  test("rejects a value sent as a string and names the row", () => {
    const paths = issuePaths({
      ...envelope,
      snapshots: [row, { ...row, periodStart: "2026-09-01", value: "4200000" }],
    });
    expect(paths).toContain("snapshots.1.value");
  });

  test("rejects a period outside day, week, month", () => {
    expect(
      issuePaths({ ...envelope, snapshots: [{ ...row, period: "quarter" }] }),
    ).toContain("snapshots.0.period");
  });

  test("rejects an observedAt that is not an ISO timestamp", () => {
    expect(issuePaths({ ...envelope, observedAt: "yesterday" })).toContain("observedAt");
  });

  test("rejects a body that is not an object", () => {
    expect(parseIngestEnvelope("hello").ok).toBe(false);
    expect(parseIngestEnvelope(null).ok).toBe(false);
  });
});

describe("parseIngestEnvelope: deals and investors", () => {
  const { snapshots: _none, ...bare } = envelope;
  const investor = {
    externalId: "inv_123",
    name: "Seedline Capital",
    contact: "Dana Lee",
    stage: "Contacted",
    amount: 250_000,
    currency: "USD",
    lastActivityAt: "2026-10-09",
  };
  const push = { ...bare, source: "visible", investors: [investor] };

  test("accepts a push of investors alone, with or without a mode", () => {
    expect(parseIngestEnvelope(push).ok).toBe(true);
    expect(parseIngestEnvelope({ ...push, mode: "replace" }).ok).toBe(true);
    expect(parseIngestEnvelope({ ...push, mode: "upsert" }).ok).toBe(true);
  });

  test("accepts deals, and a row with only its required fields", () => {
    const deals = [{ externalId: "1", name: "Almaty Dental", stage: "Новая" }];
    expect(parseIngestEnvelope({ ...bare, source: "kz_crm", deals }).ok).toBe(true);
  });

  test("a push with nothing in it is refused", () => {
    const result = parseIngestEnvelope(bare);
    expect(result.ok ? [] : result.issues).toEqual([
      { path: "envelope", message: "Send snapshots, deals, investors, customers, records, contacts, a plan or agent usage." },
    ]);
  });

  test("an empty list is refused, in either mode: an empty read is a failed read", () => {
    // In replace mode an empty list would archive every row of the source.
    for (const mode of [undefined, "upsert", "replace"]) {
      for (const field of ["deals", "investors"]) {
        const result = parseIngestEnvelope({ ...bare, mode, [field]: [] });
        expect(result.ok ? [] : result.issues, `${mode} ${field}`).toEqual([
          {
            path: field,
            message:
              "An empty list is a failed read, not an empty pipeline. Leave the field out.",
          },
        ]);
      }
    }
  });

  test("a mode other than upsert or replace is refused", () => {
    expect(issuePaths({ ...push, mode: "delete" })).toEqual(["mode"]);
  });

  test("a mode on a push of snapshots alone is refused", () => {
    // "replace" never applies to numbers; accepting it would suggest it did.
    const result = parseIngestEnvelope({ ...envelope, mode: "replace" });
    expect(result.ok ? [] : result.issues).toEqual([
      {
        path: "mode",
        message: "mode applies to deals and investors, and this push has neither.",
      },
    ]);
  });

  test("rejects an unknown field on a deal or an investor, by row and in fixed words", () => {
    // The row has no place for an email, a phone number or a patient. The
    // field is not named back: a key is sender-chosen text, and these rows
    // carry names.
    for (const extra of ["email", "phone", "patientName", "notes", "nextStep", "market"]) {
      const result = parseIngestEnvelope({ ...push, investors: [{ ...investor, [extra]: "x" }] });
      expect(result.ok ? [] : result.issues, extra).toEqual([
        { path: "investors.0", message: "has a field the OS does not accept" },
      ]);
    }
  });

  test("no issue in a push of deals or investors quotes what was sent", () => {
    // A key, a value, or a stray field beside the rows may be a name.
    const secret = "Zzyzx Capital";
    for (const field of ["deals", "investors"]) {
      const result = parseIngestEnvelope({
        ...bare,
        [secret]: 1,
        version: secret,
        observedAt: secret,
        [field]: [
          { ...investor, [secret]: 1 },
          { ...investor, externalId: "b", currency: secret, lastActivityAt: secret },
          { ...investor, externalId: "c", name: 42, contact: "" },
        ],
      });
      const issues = result.ok ? [] : result.issues;
      expect(JSON.stringify(issues), field).not.toMatch(/zzyzx/i);
      expect(issues, field).toEqual([
        { path: "version", message: "is not one of the allowed values" },
        { path: "observedAt", message: "is not in the expected form" },
        { path: `${field}.0`, message: "has a field the OS does not accept" },
        { path: `${field}.1.currency`, message: "is too long or too large" },
        { path: `${field}.1.lastActivityAt`, message: "is too long or too large" },
        { path: `${field}.2.name`, message: "is missing or of the wrong type" },
        { path: `${field}.2.contact`, message: "is empty or too small" },
        { path: "envelope", message: "has a field the OS does not accept" },
      ]);
    }
  });

  test("the snapshots beside deals or investors get fixed words too", () => {
    const result = parseIngestEnvelope({
      ...push,
      snapshots: [{ ...row, "Zzyzx Capital": 1 }, { ...row, value: "Zzyzx" }],
    });
    expect(result.ok ? [] : result.issues).toEqual([
      { path: "snapshots.0", message: "has a field the OS does not accept" },
      { path: "snapshots.1.value", message: "is missing or of the wrong type" },
    ]);
  });

  test("a push of snapshots alone still gets zod's own words", () => {
    // No names travel in it, and the sender's script needs to read what is wrong.
    const result = parseIngestEnvelope({ ...envelope, snapshots: [{ ...row, clientName: "x" }] });
    expect(result.ok ? [] : result.issues).toEqual([
      { path: "snapshots.0", message: 'Unrecognized key: "clientName"' },
    ]);
  });

  test("a row must have an id, a name and a stage", () => {
    for (const field of ["externalId", "name", "stage"]) {
      const { [field]: _omit, ...row } = investor as Record<string, unknown>;
      expect(issuePaths({ ...push, investors: [row] }), field).toEqual([`investors.0.${field}`]);
    }
  });

  test("text is capped", () => {
    expect(issuePaths({ ...push, investors: [{ ...investor, name: "x".repeat(121) }] })).toEqual([
      "investors.0.name",
    ]);
    expect(issuePaths({ ...push, investors: [{ ...investor, contact: "x".repeat(121) }] })).toEqual(
      ["investors.0.contact"],
    );
    expect(issuePaths({ ...push, investors: [{ ...investor, stage: "x".repeat(65) }] })).toEqual([
      "investors.0.stage",
    ]);
    expect(
      issuePaths({ ...push, investors: [{ ...investor, externalId: "x".repeat(101) }] }),
    ).toEqual(["investors.0.externalId"]);
  });

  test("a message about a refused value never repeats the value", () => {
    const secret = "Zzyzx Capital";
    const result = parseIngestEnvelope({
      ...push,
      mode: secret,
      investors: [
        { ...investor, name: `${secret} `.repeat(20), amount: secret, closedAt: secret, stage: 7 },
      ],
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/zzyzx/i);
  });

  test("the row cap counts every list in the push together", () => {
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...investor, externalId: `inv_${i}` }));
    const snapshots = Array.from({ length: MAX_INGEST_ROWS - 1 }, () => row);
    expect(parseIngestEnvelope({ ...push, snapshots, investors: rows(1) }).ok).toBe(true);
    const over = parseIngestEnvelope({ ...push, snapshots, investors: rows(2) });
    expect(over.ok ? [] : over.issues).toEqual([
      { path: "envelope", message: `At most ${MAX_INGEST_ROWS} rows in one push.` },
    ]);
  });
});

// Made-up clinics. Every name contains "SECRET", so one assertion can prove a
// surface holds none of them.
const clinic = {
  name: "SECRET CLINIC ALPHA",
  market: "kz",
  status: "active",
  monthlyFee: 200_000,
  lastPaymentDate: "2026-10-01",
  amountOwed: 0,
  contractDate: "2025-03-01",
};

const register = {
  version: 1,
  source: "client_register",
  batchId: "register-2026-10-12",
  observedAt: "2026-10-12T09:30:00Z",
  customers: [clinic],
};

const issuesOf = (raw: unknown) => {
  const result = parseIngestEnvelope(raw);
  return result.ok ? [] : result.issues;
};

describe("parseIngestEnvelope: a client register", () => {
  test("accepts a register push", () => {
    const result = parseIngestEnvelope(register);
    expect(result.ok).toBe(true);
    if (result.ok && isCustomersEnvelope(result.envelope)) {
      expect(result.envelope.customers[0]?.monthlyFee).toBe(200_000);
    } else {
      throw new Error("expected a customers envelope");
    }
  });

  test("a clinic needs only a name, a market and a status", () => {
    const bare = { name: "SECRET CLINIC BETA", market: "us", status: "churned" };
    const result = parseIngestEnvelope({ ...register, customers: [bare] });
    // Nothing is filled in for what was not sent: a missing number is not a zero.
    expect(result.ok && isCustomersEnvelope(result.envelope) && result.envelope.customers[0]).toEqual(
      bare,
    );
  });

  test("the name is trimmed", () => {
    const result = parseIngestEnvelope({
      ...register,
      customers: [{ ...clinic, name: "  SECRET CLINIC ALPHA " }],
    });
    expect(
      result.ok && isCustomersEnvelope(result.envelope) && result.envelope.customers[0]?.name,
    ).toBe("SECRET CLINIC ALPHA");
  });

  test("a register travels alone: nothing else may ride with customers", () => {
    const ALONE = "A customers push carries nothing else: no snapshots, deals or investors.";
    const deal = { externalId: "1", name: "SECRET CLINIC ALPHA", stage: "Lead" };
    expect(issuesOf({ ...register, snapshots: [row] })).toEqual([
      { path: "snapshots", message: ALONE },
    ]);
    expect(issuesOf({ ...register, deals: [deal] })).toEqual([{ path: "deals", message: ALONE }]);
    expect(issuesOf({ ...register, investors: [deal] })).toEqual([
      { path: "investors", message: ALONE },
    ]);
    const all = issuesOf({ ...register, snapshots: [row], deals: [deal], investors: [deal] });
    expect(all).toEqual([
      { path: "snapshots", message: ALONE },
      { path: "deals", message: ALONE },
      { path: "investors", message: ALONE },
    ]);
    expect(JSON.stringify(all)).not.toContain("SECRET");
  });

  test("a mode on a register push is refused: the register is always the whole list", () => {
    expect(issuesOf({ ...register, mode: "replace" })).toEqual([
      {
        path: "mode",
        message: "mode applies to deals and investors, and this push has neither.",
      },
    ]);
  });

  test("a request with no payload at all is refused", () => {
    const { customers: _omit, ...neither } = register;
    expect(issuesOf(neither)).toEqual([
      { path: "envelope", message: "Send snapshots, deals, investors, customers, records, contacts, a plan or agent usage." },
    ]);
  });

  test("an empty register is refused", () => {
    expect(issuePaths({ ...register, customers: [] })).toContain("customers");
  });

  test("a register over the cap is refused", () => {
    const customers = Array.from({ length: MAX_CUSTOMERS + 1 }, (_, i) => ({
      ...clinic,
      name: `SECRET CLINIC ${i}`,
    }));
    expect(issuePaths({ ...register, customers })).toContain("customers");
  });

  test("allowShrink belongs to a register push only", () => {
    expect(parseIngestEnvelope({ ...register, allowShrink: true }).ok).toBe(true);
    expect(issuePaths({ ...envelope, allowShrink: true })).toContain("allowShrink");
  });

  test.each([
    ["an unknown market", { market: "uk" }, "customers.0.market", "is not one of the allowed values"],
    ["an unknown status", { status: "trial" }, "customers.0.status", "is not one of the allowed values"],
    ["a fee sent as text", { monthlyFee: "200000" }, "customers.0.monthlyFee", "is missing or of the wrong type"],
    ["a negative balance", { amountOwed: -1 }, "customers.0.amountOwed", "is empty or too small"],
    ["a date that does not exist", { lastPaymentDate: "2026-02-30" }, "customers.0.lastPaymentDate", "is not a real date (YYYY-MM-DD)"],
    ["a blank name", { name: "   " }, "customers.0.name", "is empty or too small"],
    ["a name too long", { name: "S".repeat(201) }, "customers.0.name", "is too long or too large"],
  ])("%s is named by its path, in fixed words", (_label, patch, path, message) => {
    expect(issuesOf({ ...register, customers: [{ ...clinic, ...patch }] })).toEqual([
      { path, message },
    ]);
  });

  test("no issue under customers quotes what was sent", () => {
    // Zod's own messages name unknown keys and can quote values. A key or a
    // value here may be a clinic's name.
    const issues = issuesOf({
      ...register,
      customers: [
        { ...clinic, "SECRET CLINIC GAMMA": 1, patientCount: 40 },
        { ...clinic, name: "SECRET CLINIC DELTA", market: "SECRET MARKET" },
        { ...clinic, name: 42 },
      ],
    });
    expect(issues.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(issues)).not.toContain("SECRET");
    expect(JSON.stringify(issues)).not.toContain("patientCount");
    expect(issues).toContainEqual({
      path: "customers.0",
      message: "has a field the OS does not accept",
    });
  });

  test("nor does an issue beside customers, in a request that carries clinics", () => {
    const issues = issuesOf({ ...register, "SECRET CLINIC OMEGA": 1, version: "SECRET" });
    expect(issues).toEqual([
      { path: "version", message: "is not one of the allowed values" },
      { path: "envelope", message: "has a field the OS does not accept" },
    ]);
  });

  test("a patient field on a clinic is refused, not ignored", () => {
    for (const field of ["patients", "patientCount", "patientNames", "contact", "director"]) {
      expect(issuesOf({ ...register, customers: [{ ...clinic, [field]: 1 }] })).toEqual([
        { path: "customers.0", message: "has a field the OS does not accept" },
      ]);
    }
  });
});

describe("parseIngestEnvelope: told that the sender carries names", () => {
  // The endpoint knows from the token which source is writing. A source that
  // carries names gets fixed words even when its body has none of the three
  // name-bearing arrays: the body is the part that may be wrong.
  const { snapshots: _none, ...bare } = envelope;

  test("a stray key is not echoed, though the body has no customers, deals or investors", () => {
    const raw = { ...bare, "SECRET CLINIC ALPHA": 1, version: "SECRET" };
    const told = parseIngestEnvelope(raw, { carriesNames: true });
    expect(told.ok ? [] : told.issues).toEqual([
      { path: "version", message: "is not one of the allowed values" },
      { path: "envelope", message: "has a field the OS does not accept" },
    ]);
    // Untold, a body like this is a metrics push, and keeps zod's own words.
    const untold = parseIngestEnvelope(raw);
    expect(JSON.stringify(untold)).toContain("SECRET CLINIC ALPHA");
  });

  test("its snapshots get fixed words too", () => {
    const told = parseIngestEnvelope(
      { ...envelope, snapshots: [{ ...row, "SECRET CLINIC": 1 }] },
      { carriesNames: true },
    );
    expect(told.ok ? [] : told.issues).toEqual([
      { path: "snapshots.0", message: "has a field the OS does not accept" },
    ]);
  });
});

describe("parseIngestEnvelope: records", () => {
  const header = {
    version: 1,
    source: "gmail",
    batchId: "gmail-2026-10-12",
    observedAt: "2026-10-12T06:00:00Z",
  };
  const row = { threadId: "18c2f0a1", fromAddress: "ada@example-fund.test" };
  const issuesOf = (raw: unknown) => {
    const result = parseIngestEnvelope(raw);
    return result.ok ? [] : result.issues;
  };

  test("accepts records alone; the rows are left for the source's own rules", () => {
    const result = parseIngestEnvelope({ ...header, records: [row, "anything"] });
    expect(result.ok && isRecordsEnvelope(result.envelope)).toBe(true);
  });

  test("an envelope of numbers is not a records envelope", () => {
    const result = parseIngestEnvelope({
      ...header,
      source: "cfo_workbook",
      snapshots: [
        { key: "clinics_using", scope: "kz_product", period: "month", periodStart: "2026-10-01", value: 1 },
      ],
    });
    expect(result.ok && isRecordsEnvelope(result.envelope)).toBe(false);
  });

  test.each(["snapshots", "deals", "investors", "customers"])(
    "records beside %s are refused",
    (field) => {
      expect(issuesOf({ ...header, records: [row], [field]: [] })).toContainEqual({
        path: field,
        message: "A records push carries nothing else.",
      });
    },
  );

  test("records beside mode or allowShrink are refused", () => {
    expect(issuesOf({ ...header, records: [row], mode: "replace" })).toEqual([
      { path: "mode", message: "A records push carries nothing else." },
    ]);
    expect(issuesOf({ ...header, records: [row], allowShrink: true })).toEqual([
      { path: "allowShrink", message: "A records push carries nothing else." },
    ]);
  });

  test("an empty list needs `empty`, and `empty` needs an empty list", () => {
    expect(issuesOf({ ...header, records: [] })).toEqual([
      {
        path: "records",
        message:
          'An empty list is a failed read. Where nothing waiting is the real answer, send "empty": true with it.',
      },
    ]);
    expect(parseIngestEnvelope({ ...header, records: [], empty: true }).ok).toBe(true);
    expect(issuesOf({ ...header, records: [row], empty: true })).toEqual([
      { path: "empty", message: "empty is for a push with no records." },
    ]);
    // Only `true`: "empty": false says nothing a sender needs to say.
    expect(issuesOf({ ...header, records: [], empty: false }).map((i) => i.path)).toContain("empty");
  });

  test("`empty` without records is refused", () => {
    expect(issuesOf({ ...header, empty: true })).toContainEqual({
      path: "empty",
      message: "empty belongs to a records push.",
    });
  });

  test("more rows than one push may hold are refused", () => {
    const records = Array.from({ length: MAX_MIRROR_ROWS + 1 }, () => row);
    expect(issuesOf({ ...header, records })).toEqual([
      { path: "records", message: "is too long or too large" },
    ]);
  });

  test("a request that carries records gets fixed words for every issue, whoever sent it", () => {
    const issues = issuesOf({ ...header, records: [row], "SECRET Person": 1, version: "SECRET" });
    expect(issues).toEqual([
      { path: "version", message: "is not one of the allowed values" },
      { path: "envelope", message: "has a field the OS does not accept" },
    ]);
    expect(JSON.stringify(issues)).not.toContain("SECRET");
  });
});

describe("parseIngestEnvelope: a shared list's kind", () => {
  const apollo = {
    version: 1,
    source: "apollo",
    batchId: "apollo-2026-10-13",
    observedAt: "2026-10-13T06:00:00Z",
  };
  const gmail = { ...apollo, source: "gmail" };
  const snapshot = { key: "apollo_contacts", scope: "us", period: "week", periodStart: "2026-10-12", value: 760 };
  const issuesOf = (raw: unknown) => {
    const result = parseIngestEnvelope(raw);
    return result.ok ? [] : result.issues;
  };
  const NEEDS_KIND = 'Say which list this is: "kind" is "sequence" or "stage_count".';

  test.each(["sequence", "stage_count"])("Apollo's records say which list they are: %s", (kind) => {
    const result = parseIngestEnvelope({ ...apollo, kind, records: [{ any: "row" }] });
    expect(result.ok).toBe(true);
    if (result.ok && isRecordsEnvelope(result.envelope)) expect(result.envelope.kind).toBe(kind);
    else throw new Error("not a records envelope");
  });

  test("Apollo's records without a kind are refused", () => {
    expect(issuesOf({ ...apollo, records: [{}] })).toEqual([{ path: "kind", message: NEEDS_KIND }]);
  });

  test("a kind the OS does not know is refused, and not echoed", () => {
    const issues = issuesOf({ ...apollo, kind: "SECRET contact", records: [{}] });
    expect(issues).toEqual([{ path: "kind", message: "is not one of the allowed values" }]);
    expect(JSON.stringify(issues)).not.toContain("SECRET");
  });

  test("a work tool's records carry no kind: its token fixes what they are", () => {
    expect(issuesOf({ ...gmail, kind: "sequence", records: [{}] })).toEqual([
      { path: "kind", message: "kind is for a shared list, and this source has none." },
    ]);
  });

  test("a kind without records is refused: beside numbers, a pipeline, a register or a plan", () => {
    const WORDS = "kind belongs to a records push.";
    expect(issuesOf({ ...apollo, kind: "sequence", snapshots: [snapshot] })).toEqual([
      { path: "kind", message: WORDS },
    ]);
    expect(
      issuesOf({ ...apollo, kind: "sequence", deals: [{ externalId: "d", name: "n", stage: "s" }] }),
    ).toContainEqual({ path: "kind", message: WORDS });
    expect(
      issuesOf({
        ...apollo,
        kind: "sequence",
        customers: [{ name: "SECRET clinic", market: "us", status: "active" }],
      }),
    ).toContainEqual({ path: "kind", message: WORDS });
    expect(
      issuesOf({
        ...apollo,
        kind: "sequence",
        plan: { modelVersion: "a1b2c3d", rows: [{ scenario: "base", year: 2027, key: "arr", value: 1 }] },
      }),
    ).toEqual([{ path: "kind", message: "A plan push carries nothing else." }]);
  });

  test("each envelope carries one kind of payload: a list beside numbers is refused", () => {
    expect(
      issuesOf({ ...apollo, kind: "sequence", records: [{}], snapshots: [snapshot] }),
    ).toEqual([{ path: "snapshots", message: "A records push carries nothing else." }]);
  });

  test("an empty shared list still needs `empty` to get past the envelope (its own rules then refuse it)", () => {
    expect(issuesOf({ ...apollo, kind: "stage_count", records: [] }).map((i) => i.path)).toEqual([
      "records",
    ]);
    expect(parseIngestEnvelope({ ...apollo, kind: "stage_count", records: [], empty: true }).ok).toBe(
      true,
    );
  });
});

describe("parseIngestEnvelope: a plan", () => {
  const header = {
    version: 1,
    source: "financial_model",
    batchId: "plan-2026-10-13",
    observedAt: "2026-10-13T08:00:00Z",
  };
  const planRow = { scenario: "base", year: 2026, key: "arr", value: 0 };
  const plan = { modelVersion: "920ac834b5b2", rows: [planRow] };
  const push = { ...header, plan };
  const ALONE = "A plan push carries nothing else.";
  const issuesOf = (raw: unknown) => {
    const result = parseIngestEnvelope(raw);
    return result.ok ? [] : result.issues;
  };

  // One valid value for each field that may not ride with a plan.
  const beside = {
    snapshots: [row],
    deals: [{ externalId: "1", name: "SECRET CLINIC ALPHA", stage: "Lead" }],
    investors: [{ externalId: "1", name: "SECRET FUND", stage: "Contacted" }],
    customers: [clinic],
    records: [{ threadId: "18c2f0a1" }],
    mode: "replace",
    allowShrink: true,
    empty: true,
  };

  test("accepts a plan alone, and only the plan guard is true for it", () => {
    const result = parseIngestEnvelope(push);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a plan envelope");
    expect(isPlanEnvelope(result.envelope)).toBe(true);
    expect(isCustomersEnvelope(result.envelope)).toBe(false);
    expect(isRecordsEnvelope(result.envelope)).toBe(false);
    if (isPlanEnvelope(result.envelope)) {
      expect(result.envelope.plan).toEqual(plan);
    }
  });

  test("an envelope of numbers, a register and records are not plan envelopes", () => {
    for (const raw of [envelope, register, { ...header, source: "gmail", records: [{}] }]) {
      const result = parseIngestEnvelope(raw);
      expect(result.ok && isPlanEnvelope(result.envelope)).toBe(false);
    }
  });

  test("the first and last year are inside the plan, a negative figure is a figure", () => {
    for (const year of [2020, 2045]) {
      expect(parseIngestEnvelope({ ...push, plan: { ...plan, rows: [{ ...planRow, year }] } }).ok).toBe(
        true,
      );
    }
    expect(
      parseIngestEnvelope({
        ...push,
        plan: { ...plan, rows: [{ scenario: "bear", year: 2027, key: "net_burn", value: -1_250_000.5 }] },
      }).ok,
    ).toBe(true);
  });

  test.each(Object.keys(beside))("a plan beside %s is refused, at that field", (field) => {
    expect(issuesOf({ ...push, [field]: beside[field as keyof typeof beside] })).toEqual([
      { path: field, message: ALONE },
    ]);
  });

  test("a plan beside everything else says so once for each field", () => {
    const all = issuesOf({ ...push, ...beside });
    expect(all).toEqual(Object.keys(beside).map((path) => ({ path, message: ALONE })));
    expect(JSON.stringify(all)).not.toContain("SECRET");
  });

  test("a plan beside an empty list is refused too: presence is what counts", () => {
    expect(issuesOf({ ...push, deals: [] })).toContainEqual({ path: "deals", message: ALONE });
  });

  test("an unknown field in a plan row is refused, not ignored", () => {
    expect(
      issuesOf({ ...push, plan: { ...plan, rows: [{ ...planRow, note: "x" }] } }),
    ).toEqual([{ path: "plan.rows.0", message: 'Unrecognized key: "note"' }]);
  });

  test("an unknown field in the plan is refused, not ignored", () => {
    expect(issuesOf({ ...push, plan: { ...plan, notes: "x" } })).toEqual([
      { path: "plan", message: 'Unrecognized key: "notes"' },
    ]);
  });

  test.each([
    ["a scenario the plan does not have", { scenario: "best" }, "plan.rows.0.scenario"],
    ["a figure the plan does not have", { key: "mrr" }, "plan.rows.0.key"],
    ["a year with a fraction", { year: 2026.5 }, "plan.rows.0.year"],
    ["a year before the first", { year: 2019 }, "plan.rows.0.year"],
    ["a year after the last", { year: 2046 }, "plan.rows.0.year"],
    ["a year sent as text", { year: "2026" }, "plan.rows.0.year"],
    ["a value sent as text", { value: "1000" }, "plan.rows.0.value"],
    ["a missing value", { value: undefined }, "plan.rows.0.value"],
  ])("%s is refused, by its path", (_label, patch, path) => {
    const rows = [{ ...planRow, ...patch }];
    expect(issuePaths({ ...push, plan: { ...plan, rows } })).toEqual([path]);
  });

  test.each([
    ["a version that is not a hash", "v9"],
    ["a version in capitals", "920AC834B5B2"],
    ["a version too short", "920ac"],
    ["a version too long", "a".repeat(41)],
    ["a version that is not text", 920],
  ])("%s is refused, by its path", (_label, modelVersion) => {
    expect(issuePaths({ ...push, plan: { ...plan, modelVersion } })).toEqual(["plan.modelVersion"]);
  });

  test("a plan needs a model version and rows", () => {
    expect(issuePaths({ ...push, plan: { rows: [planRow] } })).toEqual(["plan.modelVersion"]);
    expect(issuePaths({ ...push, plan: { modelVersion: plan.modelVersion } })).toEqual([
      "plan.rows",
    ]);
  });

  test("an empty list of rows is refused", () => {
    expect(issuePaths({ ...push, plan: { ...plan, rows: [] } })).toEqual(["plan.rows"]);
  });

  test("more rows than one push may hold are refused", () => {
    const rows = (n: number) => Array.from({ length: n }, () => planRow);
    expect(parseIngestEnvelope({ ...push, plan: { ...plan, rows: rows(MAX_INGEST_ROWS) } }).ok).toBe(
      true,
    );
    expect(issuePaths({ ...push, plan: { ...plan, rows: rows(MAX_INGEST_ROWS + 1) } })).toEqual([
      "plan.rows",
    ]);
  });

  test("a plan that is not an object is refused", () => {
    for (const bad of [[], "plan", 1, null]) {
      expect(issuePaths({ ...push, plan: bad }), String(bad)).toEqual(["plan"]);
    }
  });

  test("the plan's rows hold no names, so a refusal keeps zod's own words", () => {
    // Unlike deals, investors and customers: the script that sends a plan
    // needs to read what is wrong with it.
    const issues = issuesOf({ ...push, plan: { ...plan, rows: [{ ...planRow, scenario: "best" }] } });
    expect(issues).toEqual([
      { path: "plan.rows.0.scenario", message: 'Invalid option: expected one of "bear"|"base"|"bull"' },
    ]);
  });
});

describe("parseIngestEnvelope: contacts", () => {
  // Made-up people. A value that must never come back carries SECRET.
  const people = (contacts: unknown[], extra: Record<string, unknown> = {}) => ({
    version: 1,
    source: "visible",
    batchId: "visible-contacts-2026-10-14",
    observedAt: "2026-10-14T06:00:00Z",
    contacts,
    ...extra,
  });
  const jane = { externalId: "c-1", name: "Jane Example", emails: ["jane@fund.test"] };

  test("a list of people travels alone, with or without mode upsert; rows are checked per source later", () => {
    for (const extra of [{}, { mode: "upsert" }]) {
      const result = parseIngestEnvelope(people([jane, { anything: "SECRET" }], extra));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(isContactsEnvelope(result.envelope)).toBe(true);
        expect(isRecordsEnvelope(result.envelope)).toBe(false);
      }
    }
  });

  test("replace is refused: a person missing from a push stays", () => {
    const result = parseIngestEnvelope(people([jane], { mode: "replace" }));
    expect(result).toEqual({
      ok: false,
      issues: [{ path: "mode", message: CONTACTS_UPSERT_ONLY }],
    });
  });

  test("an empty list is a failed read", () => {
    const result = parseIngestEnvelope(people([]));
    expect(result).toEqual({ ok: false, issues: [{ path: "contacts", message: CONTACTS_EMPTY }] });
  });

  test("nothing else travels beside it", () => {
    for (const [field, value] of [
      ["snapshots", [row]],
      ["investors", [{ externalId: "i-1", name: "Example Capital", stage: "Contacted" }]],
      ["records", [{}]],
      ["customers", [{ name: "Clinic", market: "kz", status: "active" }]],
      ["kind", "sequence"],
      ["empty", true],
      ["allowShrink", true],
    ] as const) {
      expect(issuePaths(people([jane], { [field]: value }))).toContain(field);
    }
    expect(issuePaths({ ...people([jane]), plan: { modelVersion: "abc1234", rows: [] } })).toContain(
      "contacts",
    );
  });

  test("over the row cap is refused, and an issue never quotes a person", () => {
    const many = Array.from({ length: MAX_CONTACT_PUSH_ROWS + 1 }, (_, i) => ({ ...jane, externalId: `c-${i}` }));
    expect(issuePaths(people(many))).toEqual(["contacts"]);
    const result = parseIngestEnvelope({ ...people([jane]), SECRET: "secret.person@fund.test" });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("secret.person");
  });
});
