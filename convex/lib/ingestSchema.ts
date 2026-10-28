// Wire format of POST /ingest/v1. Strict on purpose: an unknown field is a
// rejected request, so a client cannot quietly send data the OS never asked
// for (a patient count, say) and have it ignored rather than refused.
//
// One request carries one of five things:
//   - numbers and pipelines: `snapshots`, `deals`, `investors` (any of them,
//     together or alone), with `mode` for the pipelines;
//   - the client register: `customers`, with `allowShrink`, and nothing else;
//   - a work tool's mirrored records: `records`, with `empty`, and nothing
//     else (rows are checked per source in recordRows.ts); or one of Apollo's
//     shared lists: `records` with `kind`, and nothing else (sharedRecords.ts);
//   - the financial model's plan: `plan`, and nothing else;
//   - Vertical Startup's agents: `agentUsage`, `providers`, `agentConfigApplied`
//     (any of them), and nothing else (convex/lib/agentShape.ts);
//   - people for the Contacts book: `contacts`, with `mode` "upsert" at
//     most, and nothing else (rows are checked per source in contactPush.ts).
// The register travels alone so that the one token allowed to send clinic
// names can be reasoned about on its own: a request with `customers` is a
// register push or it is refused. The plan travels alone for the same kind of
// reason: its token can then be reasoned about on its own. It writes the plan
// and no number.

import { z } from "zod";
import {
  AGENTS_ALONE,
  AGENTS_EMPTY,
  AGENT_KEYS,
  agentUsageList,
  configAppliedRow,
  providerList,
  type AgentUsageIngestRow,
  type ConfigAppliedIngest,
  type ProviderIngestRow,
} from "./agentShape";
import { CUSTOMER_STATUSES, MARKETS } from "./customerShape";
import {
  MAX_CLINIC_NAME_LENGTH,
  MAX_CONTACT_PUSH_ROWS,
  MAX_CUSTOMERS,
  MAX_EXTERNAL_ID_LENGTH,
  MAX_NAME_LENGTH,
  MAX_STAGE_LABEL_LENGTH,
} from "./limits";
import {
  MAX_MIRROR_ROWS,
  SHARED_KINDS,
  SHARED_KINDS_OF,
  isSharedSource,
  type SharedKind,
  type SharedSource,
} from "./mirrorRules";
import { PERIODS, isCanonicalPeriodStart } from "./periods";
import {
  PLAN_FIRST_YEAR,
  PLAN_KEYS,
  PLAN_LAST_YEAR,
  PLAN_SCENARIOS,
  PLAN_VERSION_PATTERN,
  type PlanRow,
} from "./planShape";

export const INGEST_VERSION = 1;
export const MAX_INGEST_BYTES = 256 * 1024;
export const MAX_INGEST_ROWS = 1000;

const snapshotRow = z.strictObject({
  key: z.string().min(1).max(64),
  scope: z.string().min(1).max(32),
  period: z.enum(PERIODS),
  periodStart: z.string().min(1).max(10),
  value: z.number(),
  currency: z.string().length(3).optional(),
});

// A deal or an investor. These are all the fields there are: a name for the
// company or firm, one person's name, and what the source says about where
// the record stands. An email, a phone number or anything else is an unknown
// field, and the whole push is refused.
const pipelineRow = z.strictObject({
  /** The source's own id for the record. The key a later push matches on. */
  externalId: z.string().min(1).max(MAX_EXTERNAL_ID_LENGTH),
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  contact: z.string().min(1).max(MAX_NAME_LENGTH).optional(),
  /** The stage as the source names it. The OS maps it onto its own. */
  stage: z.string().min(1).max(MAX_STAGE_LABEL_LENGTH),
  amount: z.number().optional(),
  currency: z.string().length(3).optional(),
  /** "YYYY-MM-DD". */
  lastActivityAt: z.string().length(10).optional(),
  closedAt: z.string().length(10).optional(),
});

// An empty pipeline list is refused in the refinement below, in words
// written here, rather than by `.min(1)`.
const pipelineRows = z.array(pipelineRow).max(MAX_INGEST_ROWS);
const EMPTY_LIST = "An empty list is a failed read, not an empty pipeline. Leave the field out.";

export const INGEST_MODES = ["upsert", "replace"] as const;
export type IngestMode = (typeof INGEST_MODES)[number];

// A real calendar date: 2026-02-30 would otherwise be stored as text that
// every later comparison reads wrongly.
const day = z
  .string()
  .refine((value) => isCanonicalPeriodStart("day", value), "is not a real date (YYYY-MM-DD)");

// One clinic. The whole allow-list: nothing about a clinic's patients, staff
// or contacts has a field here, so none can be sent. Every figure is optional,
// and one that is left out is stored as "not on record", never as zero.
const customerRow = z.strictObject({
  name: z.string().trim().min(1).max(MAX_CLINIC_NAME_LENGTH),
  market: z.enum(MARKETS),
  status: z.enum(CUSTOMER_STATUSES),
  monthlyFee: z.number().nonnegative().optional(),
  lastPaymentDate: day.optional(),
  amountOwed: z.number().nonnegative().optional(),
  lastUsageDate: day.optional(),
  contractDate: day.optional(),
  baaDate: day.optional(),
});

/** What may not travel beside `customers`. */
const NOT_WITH_CUSTOMERS = ["snapshots", "deals", "investors", "contacts"] as const;
const CUSTOMERS_ALONE = "A customers push carries nothing else: no snapshots, deals or investors.";

/** What may not travel beside `records`: everything else. */
const NOT_WITH_RECORDS = [
  "snapshots",
  "deals",
  "investors",
  "customers",
  "contacts",
  "mode",
  "allowShrink",
] as const;
const RECORDS_ALONE = "A records push carries nothing else.";
export const EMPTY_RECORDS =
  'An empty list is a failed read. Where nothing waiting is the real answer, send "empty": true with it.';
// A shared list's source (Apollo) carries more than one list on one token, so
// its records say which they are. A work tool's token fixes that by itself.
const kindNeeded = (source: SharedSource) =>
  `Say which list this is: "kind" is ${SHARED_KINDS_OF[source].map((k) => `"${k}"`).join(" or ")}.`;
// One of this codebase's kinds, but another source's (a sequence from GitHub).
const KIND_NOT_THIS_SOURCES = "This source has no list of that kind.";
const KIND_NOT_HERE = "kind is for a shared list, and this source has none.";
const KIND_ALONE = "kind belongs to a records push.";

// One figure of the plan. Scenario and figure are this codebase's own lists,
// so a row can hold nothing the OS did not ask for.
const planRow = z.strictObject({
  scenario: z.enum(PLAN_SCENARIOS),
  year: z.number().int().min(PLAN_FIRST_YEAR).max(PLAN_LAST_YEAR),
  key: z.enum(PLAN_KEYS),
  value: z.number(),
});

/** What may not travel beside `plan`: everything else. */
const NOT_WITH_PLAN = [
  "snapshots",
  "deals",
  "investors",
  "customers",
  "contacts",
  "records",
  "mode",
  "allowShrink",
  "empty",
  "kind",
  "appIdCode",
] as const;
const PLAN_ALONE = "A plan push carries nothing else.";

/**
 * What may not travel beside `contacts`: everything else but `mode`, which
 * may only say "upsert" (a contacts push never deletes).
 */
const NOT_WITH_CONTACTS = [
  "snapshots",
  "deals",
  "investors",
  "customers",
  "records",
  "allowShrink",
  "empty",
  "kind",
  "appIdCode",
] as const;
const CONTACTS_ALONE = "A contacts push carries nothing else.";
export const CONTACTS_UPSERT_ONLY =
  'Contacts are only ever upserted: leave "mode" out or send "upsert". A person missing from a push stays.';
export const CONTACTS_EMPTY = "An empty list is a failed read. Leave contacts out and send nothing.";

/** What may not travel beside an agents push: everything else. */
const NOT_WITH_AGENTS = [...NOT_WITH_PLAN, "plan"] as const;

const envelope = z
  .strictObject({
    version: z.literal(INGEST_VERSION),
    source: z.string().min(1).max(32),
    /** Caller's name for this push; echoed in the sync log. */
    batchId: z.string().min(1).max(100),
    observedAt: z.iso.datetime(),
    /**
     * For deals and investors only. "upsert" (the default) writes the rows
     * sent and leaves the rest. "replace" says the push is the source's whole
     * list: rows of this source it does not name are archived.
     */
    mode: z.enum(INGEST_MODES).optional(),
    snapshots: z.array(snapshotRow).min(1).max(MAX_INGEST_ROWS).optional(),
    deals: pipelineRows.optional(),
    investors: pipelineRows.optional(),
    /** The whole client register: clinics missing from it are archived. */
    customers: z.array(customerRow).min(1).max(MAX_CUSTOMERS).optional(),
    /** Lets a register push archive more than half of the live clinics. */
    allowShrink: z.boolean().optional(),
    /**
     * A work tool's whole current set (Gmail, Calendar, Linear, Fireflies),
     * from that tool's own token. Each row's shape depends on the source, so
     * it is checked after the token has said which source this is
     * (`parsePushedRecords`), not here.
     */
    records: z.array(z.unknown()).max(MAX_MIRROR_ROWS).optional(),
    /** Says an empty `records` list is the real answer, not a failed read. */
    empty: z.literal(true).optional(),
    /**
     * Which of a shared source's lists `records` is (Apollo's sequences, or
     * its contacts and accounts by stage). Each push is one list, whole.
     */
    kind: z.enum(SHARED_KINDS).optional(),
    /**
     * Globex's Intercom workspace id code, beside its conversations (the
     * `intercom` source's records), for links into its inbox. Checked with
     * the records (convex/lib/supportRecords.ts).
     */
    appIdCode: z.string().max(32).optional(),
    /**
     * The financial model's whole plan, from that source's own token. It
     * travels alone.
     */
    plan: z
      .strictObject({
        modelVersion: z.string().regex(PLAN_VERSION_PATTERN),
        rows: z.array(planRow).min(1).max(MAX_INGEST_ROWS),
      })
      .optional(),
    /**
     * Vertical Startup's agents (the `vertical_agents` source's token): daily totals
     * per agent and model, each provider's health, and the config version it
     * applied. Ids and numbers only. They travel alone.
     */
    agentUsage: agentUsageList.max(MAX_INGEST_ROWS).optional(),
    providers: providerList.optional(),
    agentConfigApplied: configAppliedRow.optional(),
    /**
     * People for the Contacts book, from a source that keeps them (Visible's
     * investor contacts, the owner's saved Apollo contacts). Each row's shape
     * depends on the token's source, so it is checked after the token has
     * said which source this is (`parseContactPush`), not here. Upserted,
     * never replaced.
     */
    contacts: z.array(z.unknown()).max(MAX_CONTACT_PUSH_ROWS).optional(),
  })
  .superRefine((value, ctx) => {
    if (AGENT_KEYS.some((key) => value[key] !== undefined)) {
      for (const field of NOT_WITH_AGENTS) {
        if (value[field] !== undefined) {
          ctx.addIssue({ code: "custom", path: [field], message: AGENTS_ALONE });
        }
      }
      const something =
        (value.agentUsage?.length ?? 0) > 0 ||
        (value.providers?.length ?? 0) > 0 ||
        value.agentConfigApplied !== undefined;
      if (!something) ctx.addIssue({ code: "custom", message: AGENTS_EMPTY });
      return;
    }
    if (value.plan !== undefined) {
      for (const field of NOT_WITH_PLAN) {
        if (value[field] !== undefined) {
          ctx.addIssue({ code: "custom", path: [field], message: PLAN_ALONE });
        }
      }
      return;
    }
    if (value.contacts !== undefined) {
      for (const field of NOT_WITH_CONTACTS) {
        if (value[field] !== undefined) {
          ctx.addIssue({ code: "custom", path: [field], message: CONTACTS_ALONE });
        }
      }
      if (value.mode !== undefined && value.mode !== "upsert") {
        ctx.addIssue({ code: "custom", path: ["mode"], message: CONTACTS_UPSERT_ONLY });
      }
      if (value.contacts.length === 0) {
        ctx.addIssue({ code: "custom", path: ["contacts"], message: CONTACTS_EMPTY });
      }
      return;
    }
    if (value.records !== undefined) {
      for (const field of NOT_WITH_RECORDS) {
        // Intercom's push may say it means to remove more than half of what is
        // stored (convex/support.ts), as the register's may.
        if (field === "allowShrink" && value.source === "intercom") continue;
        if (value[field] !== undefined) {
          ctx.addIssue({ code: "custom", path: [field], message: RECORDS_ALONE });
        }
      }
      if (value.records.length === 0 && value.empty !== true) {
        ctx.addIssue({ code: "custom", path: ["records"], message: EMPTY_RECORDS });
      }
      if (value.records.length > 0 && value.empty !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["empty"],
          message: "empty is for a push with no records.",
        });
      }
      // The body's own `source` decides here; the endpoint then holds it to
      // the token's, so a list cannot arrive under another source's name.
      const shared = isSharedSource(value.source) ? value.source : null;
      if (shared !== null && value.kind === undefined) {
        ctx.addIssue({ code: "custom", path: ["kind"], message: kindNeeded(shared) });
      }
      if (shared !== null && value.kind !== undefined && !SHARED_KINDS_OF[shared].includes(value.kind)) {
        ctx.addIssue({ code: "custom", path: ["kind"], message: KIND_NOT_THIS_SOURCES });
      }
      if (shared === null && value.kind !== undefined) {
        ctx.addIssue({ code: "custom", path: ["kind"], message: KIND_NOT_HERE });
      }
      return;
    }
    if (value.empty !== undefined) {
      ctx.addIssue({ code: "custom", path: ["empty"], message: "empty belongs to a records push." });
    }
    if (value.kind !== undefined) {
      ctx.addIssue({ code: "custom", path: ["kind"], message: KIND_ALONE });
    }
    if (value.appIdCode !== undefined) {
      ctx.addIssue({ code: "custom", path: ["appIdCode"], message: "appIdCode belongs to a records push." });
    }

    for (const field of ["deals", "investors"] as const) {
      if (value[field]?.length === 0) {
        ctx.addIssue({ code: "custom", path: [field], message: EMPTY_LIST });
      }
    }

    if (value.customers !== undefined) {
      for (const field of NOT_WITH_CUSTOMERS) {
        if (value[field] !== undefined) {
          ctx.addIssue({ code: "custom", path: [field], message: CUSTOMERS_ALONE });
        }
      }
    } else {
      const lists = [value.snapshots, value.deals, value.investors];
      if (lists.every((list) => list === undefined)) {
        ctx.addIssue({
          code: "custom",
          message: "Send snapshots, deals, investors, customers, records, contacts, a plan or agent usage.",
        });
      }
      const rows = lists.reduce((sum, list) => sum + (list?.length ?? 0), 0);
      if (rows > MAX_INGEST_ROWS) {
        ctx.addIssue({ code: "custom", message: `At most ${MAX_INGEST_ROWS} rows in one push.` });
      }
      if (value.allowShrink !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["allowShrink"],
          message: "allowShrink belongs to a customers push.",
        });
      }
    }

    if (value.mode !== undefined && value.deals === undefined && value.investors === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["mode"],
        message: "mode applies to deals and investors, and this push has neither.",
      });
    }
  });

type Parsed = z.infer<typeof envelope>;
type Header = Pick<Parsed, "version" | "source" | "batchId" | "observedAt">;
export type SnapshotRow = NonNullable<Parsed["snapshots"]>[number];
export type PipelineIngestRow = NonNullable<Parsed["deals"]>[number];
export type CustomerIngestRow = NonNullable<Parsed["customers"]>[number];

/** Numbers and pipelines: at least one of the three lists is there. */
export type DataEnvelope = Header & {
  mode?: IngestMode;
  snapshots?: SnapshotRow[];
  deals?: PipelineIngestRow[];
  investors?: PipelineIngestRow[];
};
/** An envelope that is known to carry snapshots: what a metrics push script builds. */
export type SnapshotEnvelope = Header & { snapshots: SnapshotRow[] };
/** The client register, which travels alone. */
export type CustomersEnvelope = Header & { customers: CustomerIngestRow[]; allowShrink?: boolean };
/** A work tool's mirrored records, which travel alone. Rows are still unchecked. */
export type RecordsEnvelope = Header & {
  records: unknown[];
  empty?: true;
  kind?: SharedKind;
  /** Intercom's push only: the workspace's id code. */
  appIdCode?: string;
  /** Intercom's push only: it may remove more than half of the chats stored for its window. */
  allowShrink?: boolean;
};
/** The financial model's plan, which travels alone. */
export type PlanEnvelope = Header & { plan: { modelVersion: string; rows: PlanRow[] } };
/** People for the Contacts book, which travel alone. Rows are still unchecked. */
export type ContactsEnvelope = Header & { mode?: "upsert"; contacts: unknown[] };
/** Vertical Startup's agents: usage, providers and the applied config, which travel alone. */
export type AgentsEnvelope = Header & {
  agentUsage?: AgentUsageIngestRow[];
  providers?: ProviderIngestRow[];
  agentConfigApplied?: ConfigAppliedIngest;
};
export type IngestEnvelope =
  | DataEnvelope
  | CustomersEnvelope
  | RecordsEnvelope
  | PlanEnvelope
  | AgentsEnvelope
  | ContactsEnvelope;
export type IngestIssue = { path: string; message: string };

export function isCustomersEnvelope(value: IngestEnvelope): value is CustomersEnvelope {
  return (value as { customers?: unknown }).customers !== undefined;
}

export function isRecordsEnvelope(value: IngestEnvelope): value is RecordsEnvelope {
  return (value as { records?: unknown }).records !== undefined;
}

export function isContactsEnvelope(value: IngestEnvelope): value is ContactsEnvelope {
  return (value as { contacts?: unknown }).contacts !== undefined;
}

export function isPlanEnvelope(value: IngestEnvelope): value is PlanEnvelope {
  return (value as { plan?: unknown }).plan !== undefined;
}

export function isAgentsEnvelope(value: IngestEnvelope): value is AgentsEnvelope {
  return AGENT_KEYS.some((key) => (value as Record<string, unknown>)[key] !== undefined);
}

// The arrays whose rows hold names: a clinic's, a company's, a person's, and
// whatever a mirrored record says (a sender, a subject, a meeting's title), and
// the Contacts book's people with their addresses.
const NAMED = ["customers", "deals", "investors", "records", "contacts"] as const;

// What an issue says in a request that carries names, by zod's code for it.
// Zod's own message names unknown keys and can quote a value, and here either
// may be a name: these messages end up in the sync log and the HTTP reply.
const FIXED_WORDS: Record<string, string> = {
  invalid_type: "is missing or of the wrong type",
  invalid_value: "is not one of the allowed values",
  invalid_format: "is not in the expected form",
  too_big: "is too long or too large",
  too_small: "is empty or too small",
  unrecognized_keys: "has a field the OS does not accept",
};

/** Paths are built from field names declared here and row numbers; capped all the same. */
const MAX_PATH_LENGTH = 100;

type ZodIssue = z.ZodError["issues"][number];

/**
 * An issue's words for a request that carries names: ours for a `custom`
 * issue (only ever raised in this codebase, in words written here), and the
 * fixed words for zod's own, whose message can quote a key or a value.
 */
export function fixedWords(issue: ZodIssue): string {
  return issue.code === "custom" ? issue.message : (FIXED_WORDS[issue.code] ?? "is not valid");
}

function issueOf(issue: ZodIssue, carriesNames: boolean): IngestIssue {
  // An issue about the envelope as a whole has no path of its own.
  const path = (issue.path.join(".") || "envelope").slice(0, MAX_PATH_LENGTH);
  const named = carriesNames || (NAMED as readonly PropertyKey[]).includes(issue.path[0]!);
  if (!named) return { path, message: issue.message };
  return { path, message: fixedWords(issue) };
}

/**
 * `carriesNames` is the caller saying the sender is a source that carries
 * names (the endpoint knows it from the token). Such a sender gets fixed
 * words for every issue whatever its body holds: a body with no `customers`
 * key can still have a clinic's name where a field name should be.
 */
export function parseIngestEnvelope(
  raw: unknown,
  options: { carriesNames?: boolean } = {},
): { ok: true; envelope: IngestEnvelope } | { ok: false; issues: IngestIssue[] } {
  const result = envelope.safeParse(raw);
  // The refinement above leaves a register on its own, or no register at all.
  if (result.success) return { ok: true, envelope: result.data as IngestEnvelope };
  // A request from a source that carries names, or one that carries clinics,
  // deals or investors whoever sent it, gets fixed words for every issue,
  // wherever it is: a stray field beside the rows could be named after a
  // clinic or a person too.
  const carriesNames =
    options.carriesNames === true ||
    (typeof raw === "object" && raw !== null && NAMED.some((field) => field in raw));
  return { ok: false, issues: result.error.issues.map((issue) => issueOf(issue, carriesNames)) };
}
