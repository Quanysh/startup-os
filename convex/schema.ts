import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { DOCTOR_WEEKS, TRIAL_OUTCOMES } from "./lib/kzProductDetail";
import {
  mirrorSourceValidator,
  storedRecordValidator,
  storedSourceValidator,
} from "./lib/mirrorValidators";
import { HANDOFF_ACTIONS, HANDOFF_LINK_KINDS, HANDOFF_STATUSES } from "./lib/handoffs";
import { DUPLICATE_CHECK_TOOLS, DUPLICATE_DECISIONS } from "./lib/duplicates";
import { AGENT_IDS, DRAFT_ABOUT, PROPOSAL_KINDS, PROPOSAL_STATUSES, REJECT_CODES, SOURCE_KINDS, URGENCIES, WITHDRAW_REASONS } from "./lib/agents";
import { COST_BUCKETS, COST_CADENCES, COST_CATEGORIES } from "./lib/costs";
import { BUDGET_CATEGORIES } from "./lib/budget";
import { CHANGE_KINDS } from "./lib/runway";
import { CHAT_FAILURE_KEYS, CHAT_STATUSES } from "./lib/chatRules";
import { FOCUSES } from "./lib/focus";
import { PARTNER_STAGES, PARTNER_TYPES, PARTNER_VALUE_KINDS } from "./lib/partnerStages";
import { CONTACT_CATEGORIES, CONTACT_LINK_TYPES, CONTACT_PUSH_SOURCES } from "./lib/contacts";
import { COMMENT_SUBJECTS } from "./lib/comments";
import { DECISION_STATUSES, MEETING_KINDS } from "./lib/memory";
import { ACCOUNT_KINDS, POST_STATUSES } from "./lib/linkedin";
import { AREAS, STORED_AREAS } from "./lib/roles";
import { ERROR_CLASSES, PROVIDER_STATES, PUSH_FAILURES, PUSH_OUTCOMES } from "./lib/agentControl";
import { ASSERT_OPS, RESULT_ERRORS, RUN_STATUSES } from "./lib/agentJobs";
import { AGENT_KINDS, PROJECT_STATUSES, REGIONS } from "./lib/agentProjects";
import { AGENT_RUN_STATUSES, APPROVAL_STATES, RUN_TRIGGERS, TOOL_CALL_STATUSES, TOOL_EFFECTS } from "./lib/agentBuilder";
import { RUNS_ON } from "./lib/osAgents";
import { BOT_AREAS, BOT_REFUSAL_CODES } from "./lib/botRules";
import { OUTCOME_CHANNELS, OUTCOME_RESULTS, OUTCOME_SIGNALS, OUTCOME_SUBJECT_KINDS } from "./lib/outcomes";
import { FIN_OUTCOMES, SUPPORT_ORIGINS, SUPPORT_STATES } from "./lib/support";
import { DEV_REQUEST_STATUSES } from "./lib/devRequests";

export const periodValidator = v.union(
  v.literal("day"),
  v.literal("week"),
  v.literal("month"),
);

// What a source's last run came to. "not_configured" means a required env
// var is missing; "empty" means the source answered with nothing, which is
// treated as a failure so a blank response can never look like good news.
export const runStatusValidator = v.union(
  v.literal("ok"),
  v.literal("error"),
  v.literal("not_configured"),
  v.literal("empty"),
);

export const goalStatusValidator = v.union(
  v.literal("on_track"),
  v.literal("at_risk"),
  v.literal("off_track"),
  v.literal("done"),
);

export const taskColumnValidator = v.union(
  v.literal("backlog"),
  v.literal("this_week"),
  v.literal("doing"),
  v.literal("done"),
);

export const taskKindValidator = v.union(v.literal("task"), v.literal("issue"));

/** What a notification is about. The words for each are the client's (src/lib/notifications.ts). */
export const notificationKindValidator = v.union(
  v.literal("assigned"),
  v.literal("reassigned"),
  v.literal("unassigned"),
  v.literal("mentioned"),
  v.literal("moved"),
  v.literal("finished"),
  v.literal("due"),
  // A decision the person owns came due for its revisit (convex/decisions.ts).
  v.literal("decision_revisit"),
  // The daily count of what waits on /approvals (convex/approvalsDigest.ts): no free text.
  v.literal("approvals_digest"),
  // A bot handed the person work (convex/handoffs.ts): its title, summary and the bot.
  v.literal("handoff"),
);

/** A decision's state, and what kind of meeting a note is of (convex/lib/memory.ts). */
export const decisionStatusValidator = v.union(...DECISION_STATUSES.map((s) => v.literal(s)));
export const meetingKindValidator = v.union(...MEETING_KINDS.map((k) => v.literal(k)));

/** Who did it: a person, by their `users` row, or a part of the OS with no person behind it. */
export const notificationActorValidator = v.union(
  v.object({ type: v.literal("user"), userId: v.id("users") }),
  v.object({
    type: v.literal("system"),
    // "memory": the daily sweep of decisions due for a revisit.
    source: v.union(
      v.literal("standup"),
      v.literal("telegram"),
      v.literal("memory"),
      v.literal("digest"),
    ),
  }),
  // The owner's Claude, acting through the agent endpoint (convex/mcp.ts).
  // `userId` is the owner whose token it was: they are not told of what their
  // own agent did, as they are not told of what they do themselves.
  v.object({ type: v.literal("agent"), userId: v.id("users") }),
  // One of the owner's bots, by its profile's id (a slug): a handoff to a person.
  v.object({ type: v.literal("bot"), name: v.string() }),
);

/** What an agent token may do: read the OS, or read it and act in it. */
export const agentScopeValidator = v.union(v.literal("read"), v.literal("act"));

/**
 * Which connected client made a call (convex/lib/agentToken.ts): one of the
 * owner's named tokens, or a client the owner approved with OAuth. Its name is kept beside it on the audit row, so a
 * client revoked since is still said by name.
 */
export const agentClientValidator = v.union(
  v.object({ kind: v.literal("token"), id: v.id("agentTokens") }),
  v.object({ kind: v.literal("oauth"), id: v.id("oauthGrants") }),
);

/** How a call to an agent tool ended. Words for each: convex/lib/agentRules.ts. */
export const agentOutcomeValidator = v.union(
  v.literal("ok"),
  v.literal("refused"),
  v.literal("invalid"),
  v.literal("error"),
);

/**
 * What the audit keeps of a bot's refusal (convex/lib/botRules.ts, "Refusal
 * codes"): the code, and for a tool it may not call that tool's area and the
 * level it needs. Closed sets only: never a word the call sent.
 */
export const agentRefusalValidator = v.object({
  code: v.union(...BOT_REFUSAL_CODES.map((code) => v.literal(code))),
  area: v.optional(v.union(...AREAS.map((area) => v.literal(area)))),
  need: v.optional(v.union(v.literal("read"), v.literal("write"))),
});

export const marketValidator = v.union(v.literal("us"), v.literal("kz"));
/** A company's id is its market (convex/lib/company.ts). */
export const companyValidator = marketValidator;

/**
 * One Intercom conversation as the OS keeps it (convex/lib/support.ts,
 * `SupportRow`): ids, times, states, where it began as a class and a page
 * area, Fin's outcome, the assignee, counts, a rating's score, help-article
 * titles (never tags). No field holds a message, a subject, a contact, a
 * customer's name, address or phone, a company or a URL, and none may be added.
 */
export const supportRowValidator = v.object({
  intercomId: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
  state: v.union(...SUPPORT_STATES.map((state) => v.literal(state))),
  open: v.boolean(),
  priority: v.boolean(),
  waitingSince: v.union(v.number(), v.null()),
  origin: v.union(...SUPPORT_ORIGINS.map((origin) => v.literal(origin))),
  pageArea: v.union(v.string(), v.null()),
  finParticipated: v.boolean(),
  finOutcome: v.union(...FIN_OUTCOMES.map((outcome) => v.literal(outcome)), v.null()),
  humanRepliedAt: v.union(v.number(), v.null()),
  timeToHumanReply: v.union(v.number(), v.null()),
  lastCustomerReplyAt: v.union(v.number(), v.null()),
  lastHumanReplyAt: v.union(v.number(), v.null()),
  assigneeId: v.union(v.string(), v.null()),
  assigneeName: v.union(v.string(), v.null()),
  parts: v.union(v.number(), v.null()),
  reopens: v.union(v.number(), v.null()),
  rating: v.union(v.number(), v.null()),
  articles: v.array(v.string()),
});

/** A Telegram group the bot posts in: its id and the title it had when picked. */
export const telegramChatValidator = v.object({
  id: v.string(),
  title: v.string(),
  /** How many are in it, as Telegram last said: what tells two groups of one name apart. */
  members: v.optional(v.number()),
  /** When Telegram said the bot left it or was removed; cleared once the bot is seen there again. */
  leftAt: v.optional(v.number()),
});

export const memberRoleValidator = v.union(
  v.literal("cofounder"),
  v.literal("sales"),
  v.literal("engineer"),
);

/**
 * A teammate's role as it is stored: one of the three built-in words, or the
 * id of a role the owner named (the `roles` table). Rows from before roles
 * could be named hold a word and still validate; nothing was migrated.
 */
export const storedRoleValidator = v.union(memberRoleValidator, v.id("roles"));

/** What a role's pages are arranged for (convex/lib/focus.ts). */
export const focusValidator = v.union(...FOCUSES.map((focus) => v.literal(focus)));

export const payrollKindValidator = v.union(v.literal("employee"), v.literal("contractor"));
/** Who a line's amount comes from: the person's pay, or the company on top. */
export const payerValidator = v.union(v.literal("employee"), v.literal("company"));
export const payrollCurrencyValidator = v.union(v.literal("USD"), v.literal("KZT"));
export const payrollRunStatusValidator = v.union(v.literal("draft"), v.literal("paid"));
/** How a person's pay is entered: what they receive, or what it is before anything is withheld. */
export const payBasisValidator = v.union(v.literal("net"), v.literal("gross"));

/** What kind of cost a line is, and how often it is paid (convex/lib/costs.ts). */
export const costCategoryValidator = v.union(...COST_CATEGORIES.map((c) => v.literal(c)));
export const costCadenceValidator = v.union(...COST_CADENCES.map((c) => v.literal(c)));
/** What a cost line counts as in unit economics (COGS, sales and marketing, running the company). */
export const costBucketValidator = v.union(...COST_BUCKETS.map((b) => v.literal(b)));
// The budget and its runway scenarios (convex/budget.ts, convex/scenarios.ts).
export const budgetCategoryValidator = v.union(...BUDGET_CATEGORIES.map((c) => v.literal(c)));
export const scenarioChangeValidator = v.object({
  kind: v.union(...CHANGE_KINDS.map((k) => v.literal(k))),
  label: v.string(),
  startMonth: v.string(),
  /** Inclusive; absent for an open-ended change and for a one-off. */
  endMonth: v.optional(v.string()),
  /** Minor units: a monthly figure, or a one-off's amount. */
  amount: v.number(),
  currency: payrollCurrencyValidator,
  /** A hire costed at the payroll rates: the salary typed and what it was. Never a person. */
  fromPayroll: v.optional(v.object({ salary: v.number(), basis: payBasisValidator })),
});

// One person in a saved month, copied at the time: later changes to the
// person, a salary or a rate never reach it. A line with no `amount` was not
// computed, and `skipped` says why (convex/lib/payroll.ts).
export const payrollRowValidator = v.object({
  personId: v.id("payrollPeople"),
  name: v.string(),
  title: v.optional(v.string()),
  kind: payrollKindValidator,
  currency: payrollCurrencyValidator,
  // For someone entered as net: `basis` says so, `targetNet` is the net that
  // was entered and `gross` the one worked out from it. A row with no `gross`
  // is one whose gross could not be worked out (`grossMissing` says why): it
  // then has no `cost` either. A row from before pay could be entered as net
  // has neither `basis` nor `targetNet`, and always a gross and a cost.
  basis: v.optional(v.literal("net")),
  targetNet: v.optional(v.number()),
  gross: v.optional(v.number()),
  grossMissing: v.optional(
    v.union(v.literal("rate_not_set"), v.literal("other_currency"), v.literal("no_gross")),
  ),
  adjustment: v.optional(v.number()),
  adjustmentNote: v.optional(v.string()),
  lines: v.array(
    v.object({
      name: v.string(),
      paidBy: payerValidator,
      rateBp: v.optional(v.number()),
      base: v.optional(v.number()),
      amount: v.optional(v.number()),
      skipped: v.optional(
        v.union(
          v.literal("rate_not_set"),
          v.literal("other_currency"),
          v.literal("gross_unknown"),
        ),
      ),
    }),
  ),
  net: v.number(),
  cost: v.optional(v.number()),
});

/**
 * An area as a stored list holds it: every one but `personal` and `admin`.
 * Payroll and costs are the owner's alone and nothing writes them any more,
 * but a row from before may hold one (and the record of a team change keeps
 * what was so), so the validator still takes them: `effectiveAreas` gives
 * them to no teammate, and `migrations:dropOwnerOnlyAreas` takes them out of
 * `members` and `roles`.
 */
export const storedAreaValidator = v.union(
  ...STORED_AREAS.map((area) => v.literal(area)),
);

/** Where one of Startup OS's own four agents runs (convex/lib/osAgents.ts): the Mac through Claude, or Startup OS on Gemini. */
export const runsOnValidator = v.union(...RUNS_ON.map((where) => v.literal(where)));

/** An agent's desired state at one moment, for the record of a change (convex/agentControl.ts). */
export const agentDesiredValidator = v.object({
  enabled: v.boolean(),
  provider: v.string(),
  model: v.string(),
  fallbackProvider: v.optional(v.string()),
  fallbackModel: v.optional(v.string()),
  monthlyBudgetUsd: v.optional(v.number()),
  promptVersionPin: v.optional(v.string()),
  /** The published harness version it runs: "h7" (convex/agentHarness.ts). */
  harnessVersion: v.optional(v.string()),
  /** One of Startup OS's own four: where it runs. Absent for every other agent. */
  runsOn: v.optional(runsOnValidator),
});

/** Model parameters a harness may set (convex/lib/agentHarness.ts, PARAM_BOUNDS). */
export const harnessParamsValidator = v.object({
  temperature: v.optional(v.number()),
  maxOutputTokens: v.optional(v.number()),
  thinkingBudget: v.optional(v.number()),
  timeoutMs: v.optional(v.number()),
  retries: v.optional(v.number()),
});

/** One prompt variant (Protocol v1.2): its system template, and its user template unless the agent sends messages. */
export const variantValidator = v.object({ system: v.string(), user: v.optional(v.string()) });
/** Variants by name (`^[a-z][a-z0-9_]{0,31}$`, checked before they are stored). */
export const variantsValidator = v.record(v.string(), variantValidator);

/** A version's parts: only what it changes; a part left out is the code's own. */
export const harnessPartsFields = {
  /**
   * v1.1 rows: the prompt inline. Newer rows keep their prompt's variants in
   * `agentHarnessPrompts` (one row per version), so a list of versions never
   * reads every prompt; `promptVariants` names them.
   */
  prompt: v.optional(v.object({ system: v.string(), user: v.string() })),
  promptVariants: v.optional(v.array(v.string())),
  params: v.optional(harnessParamsValidator),
  /** The tools switched on, by id. */
  tools: v.optional(v.array(v.string())),
  /** JSON text: a schema's `$` keys cannot be field names here. */
  outputSchema: v.optional(v.string()),
};

/** The code's defaults, as a project's usage report declares them. */
export const harnessDefaultsValidator = v.object({
  prompt: v.optional(
    v.object({
      version: v.string(),
      /** v1.2: `messages` for an agent that sends its own conversation; left out, `text`. */
      input: v.optional(v.union(v.literal("text"), v.literal("messages"))),
      /** v1.1's templates; v1.2 sends `variants` instead. */
      system: v.optional(v.string()),
      user: v.optional(v.string()),
      variables: v.array(v.object({ name: v.string(), required: v.boolean() })),
      variants: v.optional(variantsValidator),
    }),
  ),
  params: v.optional(harnessParamsValidator),
  tools: v.optional(
    v.array(
      v.object({
        id: v.string(),
        name: v.string(),
        description: v.string(),
        phi: v.boolean(),
        /** v1.2: left out, a function; `provider`, built into the provider (skipped in test runs). */
        kind: v.optional(v.union(v.literal("function"), v.literal("provider"))),
      }),
    ),
  ),
  defaultTools: v.optional(v.array(v.string())),
  output: v.optional(v.object({ schemaVersion: v.string(), schema: v.string() })),
});

/**
 * A declarative agent's definition (Protocol v1.3, convex/lib/agentBuilder.ts),
 * kept on each of its harness versions. Its prompt, parameters, tools and
 * schema are the version's parts, as any agent's.
 */
export const definitionValidator = v.object({
  name: v.string(),
  description: v.string(),
  input: v.object({
    mode: v.union(v.literal("text"), v.literal("messages")),
    variables: v.array(v.object({ name: v.string(), required: v.boolean() })),
  }),
  /** The model it is published on: the OS's, sent as the agent's provider and model. */
  model: v.optional(
    v.object({
      provider: v.string(),
      model: v.string(),
      fallbackProvider: v.optional(v.string()),
      fallbackModel: v.optional(v.string()),
    }),
  ),
  triggers: v.object({
    api: v.boolean(),
    schedule: v.optional(v.object({ cron: v.string(), variables: v.record(v.string(), v.string()) })),
    subAgent: v.optional(v.object({ toolId: v.string(), description: v.string() })),
    chat: v.optional(v.object({ enabled: v.boolean(), title: v.string(), greeting: v.string() })),
  }),
  approvals: v.array(v.string()),
  limits: v.object({ maxSteps: v.number(), timeoutMs: v.number(), monthlyBudgetUsd: v.optional(v.number()) }),
});

/** One tool call of a run summary (v1.3): ids and states only. */
export const runToolCallValidator = v.object({
  toolId: v.string(),
  status: v.union(...TOOL_CALL_STATUSES.map((status) => v.literal(status))),
  approval: v.optional(v.union(...APPROVAL_STATES.map((state) => v.literal(state)))),
});

/** A test case's conversation (v1.2), for an agent that sends its own: text only. */
export const caseMessagesValidator = v.array(
  v.object({ role: v.union(v.literal("user"), v.literal("assistant")), content: v.string() }),
);

/** One expectation of a test case: its value as JSON text. */
export const assertionValidator = v.object({
  path: v.string(),
  op: v.union(...ASSERT_OPS.map((op) => v.literal(op))),
  value: v.string(),
});

export const pushOutcomeValidator = v.union(
  ...PUSH_OUTCOMES.map((outcome) => v.literal(outcome)),
);
export const pushFailureValidator = v.union(
  ...PUSH_FAILURES.map((failure) => v.literal(failure)),
);

/** A teammate's role, companies and pages at one moment, for the record of a change. */
export const teamStateValidator = v.object({
  role: storedRoleValidator,
  companies: v.array(companyValidator),
  areas: v.array(storedAreaValidator),
});

// What a deal and an investor have in common. A row is either native
// (source "manual": created and edited here) or mirrored (pushed through the
// ingest endpoint by the system that owns it). On a mirrored row everything
// down to `closedAt` belongs to the source and is rewritten by each push;
// `order`, `nextStep` and `notes` belong to the owner and no push touches them.
//
// The only names stored are `name` (the company, clinic or investment firm)
// and `contact` (one person there). No email, phone or address, and never a
// patient: the envelope has no field for them and refuses unknown ones.
const pipelineFields = {
  source: v.string(),
  // The source's own id for the record. A native row uses its document id.
  externalId: v.string(),
  name: v.string(),
  contact: v.optional(v.string()),
  // One of the pipeline's stages (convex/lib/pipelineStages.ts), or
  // "unmapped" for a mirrored row whose stage name the OS does not know.
  stage: v.string(),
  // The stage as the source names it, kept so an unmapped one can be read.
  sourceStage: v.optional(v.string()),
  amount: v.optional(v.number()),
  lastActivityAt: v.optional(v.number()),
  closedAt: v.optional(v.number()),
  order: v.number(),
  nextStep: v.optional(v.string()),
  notes: v.optional(v.string()),
  // Set when a "replace" push no longer lists the row. Archived rows leave
  // the board and keep their notes; a later push that lists them clears it.
  archivedAt: v.optional(v.number()),
};

// A deal's details (convex/lib/dealDetails.ts), deals only and native deals
// only: written by `deals.update` and `deals.importProspects`, cleaned by
// `cleanDealDetails`, and never by a push, so a mirrored deal has none. The
// research behind a deal is named by its titles, never a link.
export const dealPriorityValidator = v.union(
  v.literal("high"),
  v.literal("medium"),
  v.literal("low"),
);
export const partnerTypeValidator = v.union(...PARTNER_TYPES.map((type) => v.literal(type)));
export const partnerStageValidator = v.union(...PARTNER_STAGES.map((stage) => v.literal(stage)));
export const partnerValueKindValidator = v.union(...PARTNER_VALUE_KINDS.map((kind) => v.literal(kind)));
export const contactCategoryValidator = v.union(
  ...CONTACT_CATEGORIES.map((category) => v.literal(category)),
);
export const contactLinkTypeValidator = v.union(...CONTACT_LINK_TYPES.map((type) => v.literal(type)));
/** A source that pushes people into the Contacts book (convex/lib/contactPush.ts). */
export const contactSourceValidator = v.union(...CONTACT_PUSH_SOURCES.map((source) => v.literal(source)));
const dealDetailFields = {
  priority: v.optional(dealPriorityValidator),
  // A US state code, or a few words.
  region: v.optional(v.string()),
  physicians: v.optional(v.number()),
  locations: v.optional(v.number()),
  sources: v.optional(v.array(v.string())),
};

// These mirror the lists in convex/lib/customerShape.ts and obligationShape.ts.
export const customerStatusValidator = v.union(
  v.literal("active"),
  v.literal("paused"),
  v.literal("churned"),
);

export const obligationCategoryValidator = v.union(
  v.literal("hipaa"),
  v.literal("soc2"),
  v.literal("kz_data"),
  v.literal("iso27001"),
  v.literal("corporate_tax"),
  v.literal("contracts"),
);

export const recurrenceValidator = v.union(
  v.literal("none"),
  v.literal("monthly"),
  v.literal("quarterly"),
  v.literal("annual"),
);

export const obligationStatusValidator = v.union(
  v.literal("open"),
  v.literal("in_progress"),
  v.literal("done"),
  v.literal("not_applicable"),
);

// Mirrors PLAN_SCENARIOS in convex/lib/planShape.ts.
export const planScenarioValidator = v.union(
  v.literal("bear"),
  v.literal("base"),
  v.literal("bull"),
);

/** One of the owner's agents (convex/lib/agents.ts): a closed set, never typed text. */
export const agentValidator = v.union(...AGENT_IDS.map((agent) => v.literal(agent)));

/** An area a bot may hold (convex/lib/botRules.ts): never a sensitive area, the owner's own, or Today. */
export const botAreaValidator = v.union(...BOT_AREAS.map((area) => v.literal(area)));
export const botPermissionValidator = v.object({
  area: botAreaValidator,
  level: v.union(v.literal("read"), v.literal("write")),
});
export const botLimitsValidator = v.object({
  proposalsPerDay: v.number(),
  changesPer10Min: v.number(),
  callsPer10Min: v.number(),
});

/** Which company a bot works for (convex/lib/botRules.ts, `BOT_COMPANIES`). */
export const botCompanyValidator = v.union(v.literal("us"), v.literal("kz"), v.literal("both"));

/** Where a bot's calls came from, as its client shows it (convex/lib/botTelemetry.ts, `providerOf`): a closed set. */
export const botProviderValidator = v.union(v.literal("external_grok"), v.literal("external"));

/** A chat message's state, and why an answer failed (convex/lib/chatRules.ts): closed sets. */
export const chatStatusValidator = v.union(...CHAT_STATUSES.map((status) => v.literal(status)));
export const chatFailureValidator = v.union(...CHAT_FAILURE_KEYS.map((key) => v.literal(key)));

/** A proposal's kind, and what became of it (convex/lib/agents.ts). */
export const proposalKindValidator = v.union(...PROPOSAL_KINDS.map((kind) => v.literal(kind)));
export const urgencyValidator = v.union(...URGENCIES.map((urgency) => v.literal(urgency)));
export const rejectCodeValidator = v.union(...REJECT_CODES.map((code) => v.literal(code)));
export const withdrawReasonValidator = v.union(...WITHDRAW_REASONS.map((reason) => v.literal(reason)));
/** A proposal's evidence: a row of that company (or a metric key), checked to exist when proposed. */
export const proposalSourceValidator = v.object({
  kind: v.union(...SOURCE_KINDS.map((kind) => v.literal(kind))),
  id: v.string(),
});
/** One field the owner changed before approving: as proposed, and as approved. */
export const proposalEditValidator = v.object({
  field: v.string(),
  before: v.union(v.string(), v.null()),
  after: v.union(v.string(), v.null()),
});
export const proposalStatusValidator = v.union(
  ...PROPOSAL_STATUSES.map((status) => v.literal(status)),
);

/**
 * What a proposal would do, one shape a kind (convex/lib/proposals.ts holds
 * it to its kind, cleans it and checks it against the live data):
 * `task_create`, `task_change` (null clears), `deal_next_step`, `draft`.
 */
export const proposalPayloadValidator = v.union(
  v.object({
    title: v.string(),
    notes: v.optional(v.string()),
    assignee: v.optional(v.string()),
    due: v.optional(v.string()),
    column: v.optional(taskColumnValidator),
  }),
  v.object({
    taskId: v.id("tasks"),
    assignee: v.optional(v.union(v.string(), v.null())),
    due: v.optional(v.union(v.string(), v.null())),
    column: v.optional(taskColumnValidator),
  }),
  v.object({ dealId: v.id("deals"), nextStep: v.string() }),
  // decision_record: a decision an agent saw (in a meeting's notes), to record.
  v.object({
    title: v.string(),
    decision: v.string(),
    context: v.optional(v.string()),
    ownerEmail: v.optional(v.string()),
    revisitOn: v.optional(v.string()),
    meetingId: v.optional(v.id("meetingNotes")),
  }),
  // goal_create: a goal for a quarter (the proposal's company); goal_update: a rename or a re-rating.
  // Both may carry an owner (an address in `people`), a bot (a profile's id), a target and a due day; an update's null clears one.
  v.object({
    quarter: v.string(),
    title: v.string(),
    status: v.optional(goalStatusValidator),
    ownerEmail: v.optional(v.string()),
    ownerBot: v.optional(v.string()),
    target: v.optional(v.string()),
    dueOn: v.optional(v.string()),
  }),
  v.object({
    goalId: v.id("goals"),
    title: v.optional(v.string()),
    status: v.optional(goalStatusValidator),
    ownerEmail: v.optional(v.union(v.string(), v.null())),
    ownerBot: v.optional(v.union(v.string(), v.null())),
    target: v.optional(v.union(v.string(), v.null())),
    dueOn: v.optional(v.union(v.string(), v.null())),
  }),
  // bot_permission: the bot that asked (the proposal's own `bot`), an area a bot may hold and the level.
  v.object({
    bot: v.string(),
    area: botAreaValidator,
    level: v.union(v.literal("read"), v.literal("write")),
  }),
  // deal_create (Bot Loop v3): a new deal on the proposal's company's board.
  // Contact by name and role only; region, size, priority and intel US only.
  v.object({
    name: v.string(),
    stage: v.optional(v.string()),
    contact: v.optional(v.string()),
    amount: v.optional(v.union(v.number(), v.null())),
    region: v.optional(v.string()),
    physicians: v.optional(v.union(v.number(), v.null())),
    locations: v.optional(v.union(v.number(), v.null())),
    priority: v.optional(dealPriorityValidator),
    sources: v.optional(v.array(v.string())),
    intel: v.optional(
      v.object({
        summary: v.optional(v.string()),
        fit: v.optional(v.union(v.number(), v.null())),
        ehr: v.optional(v.string()),
        billingModel: v.optional(v.string()),
        ownership: v.optional(v.string()),
        angle: v.optional(v.string()),
        nextBestAction: v.optional(v.string()),
        signals: v.optional(v.array(v.object({ date: v.optional(v.string()), kind: v.string(), text: v.string() }))),
      }),
    ),
    nextStep: v.optional(v.string()),
  }),
  // memory_note: a note that is not a meeting's, on the proposal's company.
  v.object({ title: v.string(), body: v.string() }),
  // comment: on a task, a deal or a handoff.
  v.object({
    subjectKind: v.union(...COMMENT_SUBJECTS.map((kind) => v.literal(kind))),
    subjectId: v.string(),
    body: v.string(),
  }),
  // task_archive: take a task off the board without deleting it. `{ taskId }` also matches task_change.
  v.object({ taskId: v.id("tasks") }),
  // handoff_reassign: hand an open handoff to another bot, or to a person.
  v.object({
    handoffId: v.id("handoffs"),
    to: v.string(),
    note: v.optional(v.string()),
  }),
  v.object({
    title: v.string(),
    body: v.string(),
    about: v.optional(
      v.object({
        type: v.union(...DRAFT_ABOUT.map((type) => v.literal(type))),
        id: v.optional(v.string()),
      }),
    ),
  }),
);

export default defineSchema({
  ...authTables,

  // ── The team ─────────────────────────────────────────────────────────────

  // Teammates the owner has added. The owner is never a row here: an
  // OWNER_EMAILS address is always the owner, with both companies. A
  // teammate's address is stored here, in `users` once they sign in, and in
  // `tasks.assignee`; nowhere else, and never in a log or an error.
  members: defineTable({
    /** Lower-cased. One row per address. */
    email: v.string(),
    /**
     * A label and an arrangement, never access: a built-in word, or the id of
     * a role the owner named. What they may open is `areas`.
     */
    role: storedRoleValidator,
    /** One or both. Never empty. */
    companies: v.array(companyValidator),
    /**
     * The areas the owner picked for them, possibly none. Absent on a row
     * from before pages could be picked: it has its role's
     * (`effectiveAreas`). Never `personal` or `admin`, which the validator
     * does not hold; the two sensitive areas only where they were ticked;
     * payroll or costs only on a row from before they were the owner's
     * alone, and then giving nothing.
     */
    areas: v.optional(v.array(storedAreaValidator)),
    addedAt: v.number(),
    addedBy: v.id("users"),
    // ── Telegram (convex/telegram.ts) ──
    /**
     * Their Telegram username, as the owner typed it and without the "@":
     * what the bot tags when a task is given to them. Sent only to the owner
     * and to whoever manages the team (`team.list`).
     */
    telegram: v.optional(v.string()),
    /**
     * The numeric Telegram id of whoever first used that username in a picked
     * group. From then on both must match: a username can be given up and
     * taken by someone else. Sent to nobody; cleared when the username changes.
     */
    telegramUserId: v.optional(v.string()),
    /** When that id was stored: what the owner is shown as "Linked". Absent for an older link. */
    telegramBoundAt: v.optional(v.number()),
    /**
     * Their GitHub username, as the owner typed it and without the "@": what
     * "my pull requests" is matched against, for them alone. Sent to them
     * (`team.myGithub`) and to whoever is sent their row (`team.list`).
     */
    github: v.optional(v.string()),
  }).index("by_email", ["email"]),

  // The roles the owner named, beside the three built in (convex/roles.ts,
  // convex/lib/roleRules.ts). A role is a label, a focus the Dashboard and
  // Today pages are arranged for, and the pages the form ticks when it is
  // chosen. It gives nothing: a person's pages are their own `areas`.
  roles: defineTable({
    /** Cleaned typed text, 1 to 40 characters. Rendered as text; never logged. */
    name: v.string(),
    /** The name lower-cased: two names that differ by capitals are one. */
    nameKey: v.string(),
    focus: focusValidator,
    /** Its usual pages: ordinary ones only, never a sensitive area or Today. */
    areas: v.array(storedAreaValidator),
    createdBy: v.id("users"),
  }).index("by_nameKey", ["nameKey"]),

  // What an owner keeps about themselves that a teammate keeps on their
  // `members` row: an owner has no row. One per owner, by their `users` row.
  ownerProfiles: defineTable({
    userId: v.id("users"),
    /** The owner's own GitHub username (`team.setMyGithub`). */
    github: v.optional(v.string()),
  }).index("by_userId", ["userId"]),

  // What a teammate with the `team` area changed on the team (convex/team.ts):
  // one row per addition, change or removal that changed something. The
  // owner's own changes are recorded only where they widen someone's reach (a
  // sensitive area given, a company added), so who was given what is on record. Read by the owner alone (`team.changes`); written only by the
  // three team mutations, and never changed or deleted by anything.
  //
  // Ids, a fixed word and lists of fixed words only: no address, name,
  // username or typed text. Who the two people are is looked up when the owner
  // reads it, for as long as their rows still say.
  teamChanges: defineTable({
    at: v.number(),
    kind: v.union(v.literal("add"), v.literal("update"), v.literal("remove")),
    /** The manager who did it: their own `users` row. */
    actor: v.id("users"),
    /** Whose record: their `members` row, which a removal deletes. */
    member: v.id("members"),
    /**
     * Their `users` row, where they had signed in by then: what lets the
     * owner still be told who was removed.
     */
    memberUser: v.optional(v.id("users")),
    /** What they had before; absent for an addition. */
    before: v.optional(teamStateValidator),
    /** What they have after; absent for a removal. */
    after: v.optional(teamStateValidator),
    /** True when their Telegram username was changed too. Never the username. */
    telegramChanged: v.optional(v.boolean()),
    /**
     * Whether the change widened what someone can reach: a sensitive area
     * they did not have, or a company they were not on. Written with the row
     * and never changed. Absent only on a row from before it was written,
     * which is read for what it says instead (`team.changes`).
     */
    widens: v.optional(v.boolean()),
  }).index("by_widens", ["widens"]),

  // ── The operating routine ────────────────────────────────────────────────

  // The handful of priorities for a quarter ("2026-Q4").
  goals: defineTable({
    quarter: v.string(),
    title: v.string(),
    status: goalStatusValidator,
    order: v.number(),
    /** One company's goal; none (every goal from before this field) is both companies'. */
    company: v.optional(companyValidator),
    /** When it was last renamed or re-rated; a goal never changed has only its `_creationTime`. */
    updatedAt: v.optional(v.number()),
    /**
     * A cash goal (pre-seed, collections): proposals tied to it are pinned in
     * "Cash and runway" at the top of /approvals. Set on /goals (`review`).
     */
    cash: v.optional(v.boolean()),
    /** Who answers for it: a lower-cased address in `people`, on the goal's company (anyone's for both). */
    ownerEmail: v.optional(v.string()),
    /** The bot that works on it: a bot profile's id (`bots.botId`). */
    ownerBot: v.optional(v.string()),
    /** What done looks like, in a few words ("v2 live at 3 pilot clinics"): cleaned, 120 characters. */
    target: v.optional(v.string()),
    /** The day it is due, "YYYY-MM-DD". */
    dueOn: v.optional(v.string()),
  }).index("by_quarter_and_order", ["quarter", "order"]),

  // ── Company memory (convex/decisions.ts, convex/meetingNotes.ts) ──────────

  // What the company decided, why, who owns it and when to look again. Text
  // is typed by a person (or proposed by an agent and approved by the owner):
  // cleaned, bounded (convex/lib/memory.ts), rendered as text, in no log.
  // `owner` is a teammate's lower-cased address, held to who a task of that
  // company could be given to (`assignablePeople`), as `tasks.assignee` is.
  decisions: defineTable({
    company: companyValidator,
    title: v.string(),
    decision: v.string(),
    context: v.optional(v.string()),
    owner: v.optional(v.string()),
    /** The day it was decided (or proposed), "YYYY-MM-DD". */
    decidedOn: v.string(),
    status: decisionStatusValidator,
    /** The day to look at it again, "YYYY-MM-DD". */
    revisitOn: v.optional(v.string()),
    /** When the daily sweep told its owner the revisit came due. Cleared when `revisitOn` changes. */
    revisitNotifiedAt: v.optional(v.number()),
    taskIds: v.array(v.id("tasks")),
    dealIds: v.array(v.id("deals")),
    goalIds: v.array(v.id("goals")),
    tags: v.array(v.string()),
    /** The meeting it was made in, if any. */
    meetingId: v.optional(v.id("meetingNotes")),
    createdBy: v.id("users"),
    /** Present when an agent proposed it and the owner approved it. */
    origin: v.optional(v.object({ source: v.literal("agent"), agent: agentValidator })),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_company_and_decidedOn", ["company", "decidedOn"])
    .index("by_owner_and_revisitOn", ["owner", "revisitOn"])
    .index("by_revisitNotifiedAt_and_revisitOn", ["revisitNotifiedAt", "revisitOn"])
    .index("by_meetingId", ["meetingId"]),

  // ── The LinkedIn content calendar (convex/linkedin.ts, /linkedin) ─────────

  // A post of Startup's or Globex's company page, or of a named person's
  // profile (a name only). Typed by a person or pushed by a bot through the
  // owner's agent; the OS publishes nothing and calls no LinkedIn API. Text is
  // cleaned and bounded (convex/lib/linkedin.ts), stored as plain text and
  // rendered as text. `sortAt` is where it sits on the calendar: when it went
  // out, else when it is planned, else when it was made.
  linkedinPosts: defineTable({
    company: companyValidator,
    account: v.union(...ACCOUNT_KINDS.map((kind) => v.literal(kind))),
    /** The person's name, when the post is on a profile. */
    person: v.optional(v.string()),
    status: v.union(...POST_STATUSES.map((status) => v.literal(status))),
    /** The hook: the post's first line. */
    title: v.string(),
    body: v.optional(v.string()),
    pillar: v.optional(v.string()),
    /** A teammate's lower-cased address, held to who a task of that company could be given to. */
    owner: v.optional(v.string()),
    plannedAt: v.optional(v.number()),
    publishedAt: v.optional(v.number()),
    /** An https address on linkedin.com or lnkd.in, once published. */
    link: v.optional(v.string()),
    sortAt: v.number(),
    createdBy: v.id("users"),
    /** Present when the owner's Claude (a bot or client) wrote it; `client` is that client's name. */
    origin: v.optional(v.object({ source: v.literal("agent"), client: v.optional(v.string()) })),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_company_and_sortAt", ["company", "sortAt"]),

  // A dated snapshot of a post's figures, as LinkedIn shows them that day
  // (counts to date). One a post a day: a second one that day fills in or
  // replaces its figures. A figure left out is unknown, never zero.
  linkedinStats: defineTable({
    postId: v.id("linkedinPosts"),
    company: companyValidator,
    /** The day the figures were read, "YYYY-MM-DD". */
    day: v.string(),
    impressions: v.optional(v.number()),
    reactions: v.optional(v.number()),
    comments: v.optional(v.number()),
    reposts: v.optional(v.number()),
    clicks: v.optional(v.number()),
    followersGained: v.optional(v.number()),
    createdBy: v.id("users"),
    origin: v.optional(v.object({ source: v.literal("agent"), client: v.optional(v.string()) })),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_postId_and_day", ["postId", "day"])
    .index("by_company_and_day", ["company", "day"]),

  // The posts a week a company means to put out: the line the cadence chart is read against.
  linkedinTargets: defineTable({
    company: companyValidator,
    postsPerWeek: v.number(),
    updatedBy: v.id("users"),
    updatedAt: v.number(),
  }).index("by_company", ["company"]),

  // Notes of a meeting: teammates by address, people from outside by name
  // only (never an address), what was said, what is to be done. Never a
  // transcript. An action item becomes a card through `createTask` and keeps its id.
  meetingNotes: defineTable({
    company: companyValidator,
    kind: meetingKindValidator,
    /** The day it was held, "YYYY-MM-DD". */
    heldOn: v.string(),
    title: v.string(),
    attendees: v.array(v.string()),
    outsideAttendees: v.array(v.string()),
    notes: v.string(),
    actionItems: v.array(v.object({ text: v.string(), taskId: v.optional(v.id("tasks")) })),
    /**
     * The owner's Fireflies meeting these notes were started from, by its id
     * (never its content): set only by the owner's import, sent only to the
     * owner, so Today's Recent meetings can open the notes made from it.
     */
    firefliesId: v.optional(v.string()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_company_and_heldOn", ["company", "heldOn"]),

  // A note that is not the notes of a meeting (/memory, the Notes tab).
  // One company's. `origin.by` is a bot or agent slug when one wrote it, never an address.
  memoryNotes: defineTable({
    company: companyValidator,
    title: v.string(),
    body: v.string(),
    createdBy: v.id("users"),
    origin: v.optional(v.object({ source: v.literal("agent"), by: v.string() })),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_company_and_createdAt", ["company", "createdAt"]),

  // A comment on a task, a deal or a handoff. `by` is a bot or agent slug when
  // one wrote it, never an address. `subjectId` is that row's id.
  comments: defineTable({
    subjectKind: v.union(...COMMENT_SUBJECTS.map((kind) => v.literal(kind))),
    subjectId: v.string(),
    company: v.optional(companyValidator),
    body: v.string(),
    createdBy: v.id("users"),
    by: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_subject", ["subjectKind", "subjectId"])
    .index("by_company", ["company"]),

  // Cards on the task board. An "issue" is a problem to solve rather than a
  // thing to do; open issues are listed on the scorecard. `order` is the
  // position within a column, except in "done", which sorts by `doneAt`.
  tasks: defineTable({
    title: v.string(),
    notes: v.optional(v.string()),
    kind: taskKindValidator,
    column: taskColumnValidator,
    order: v.number(),
    goalId: v.optional(v.id("goals")),
    due: v.optional(v.string()),
    doneAt: v.optional(v.number()),
    /** Taken off the board without being deleted (`tasks.archive`). Hidden from the board and from open lists. */
    archivedAt: v.optional(v.number()),
    // A task with no `company` is shared: every member with the board sees
    // it. Rows from before teammates existed have none of these three.
    /** A teammate's lower-cased address, or a bot's id (`bot:<id>` for an external profile; convex/lib/botEvents.ts). Kept when they are removed. */
    assignee: v.optional(v.string()),
    company: v.optional(companyValidator),
    createdBy: v.optional(v.id("users")),
    /**
     * The standup could not tell which company the card is (convex/standup.ts):
     * it is shared until someone picks one, and listed under "Needs owner" on
     * /board. Cleared when a company is set on the card.
     */
    needsCompany: v.optional(v.boolean()),
    // Everyone already told they were mentioned on this card, by `users` row
    // (never an address), so a later save does not tell them again
    // (convex/tasks.ts). Written only by `tasks.update`.
    mentioned: v.optional(v.array(v.id("users"))),
    // Where a card came from when nobody typed it into the board: the daily
    // standup (convex/standup.ts), or "Suggest a change" in the sidebar
    // (convex/suggestions.ts). Absent on every card made on the board.
    origin: v.optional(
      v.union(
        v.object({
          source: v.literal("standup"),
          /** The day the meeting was held, "YYYY-MM-DD". */
          meetingDate: v.string(),
          /** The meeting's id in Fireflies. */
          meetingId: v.string(),
        }),
        // Asked for in a Telegram group (convex/telegramInbound.ts); `createdBy` says by whom.
        v.object({ source: v.literal("telegram") }),
        // Who suggested it is the card's `createdBy`.
        v.object({ source: v.literal("suggestion") }),
        // Made by the owner's Claude through the agent endpoint
        // (convex/mcp.ts); `createdBy` is the owner whose token it was.
        // `agent` is which of the owner's four, where one said so.
        // `bot` is the profile id of the bot that made it (the authenticated
        // caller, or the proposing bot when a proposal is approved). Absent
        // when no bot did, and on every card from before this was recorded.
        v.object({
          source: v.literal("agent"),
          agent: v.optional(agentValidator),
          bot: v.optional(v.string()),
        }),
      ),
    ),
    /** Added with `force` past a near-duplicate check: the open items it was near, and why the caller said it differs. */
    duplicateOf: v.optional(v.array(v.string())),
    forceReason: v.optional(v.string()),
  })
    .index("by_column_and_order", ["column", "order"])
    .index("by_column_and_doneAt", ["column", "doneAt"])
    .index("by_goalId", ["goalId"]),

  // Every item of a standup the OS has taken and decided on, added to the
  // board or skipped as a duplicate: its meeting and its key within it. A
  // meeting sent again finds its items here and adds nothing, so a card the
  // team deleted is not made again. Holds no title, name or address.
  // `day` is the UTC day it was taken, for the per-day limit.
  standupItems: defineTable({
    meetingId: v.string(),
    key: v.string(),
    day: v.string(),
    acceptedAt: v.number(),
  })
    .index("by_meetingId_and_key", ["meetingId", "key"])
    .index("by_day", ["day"]),

  // What each person is told about the board: who gave them a task, who
  // mentioned them, what happened to work they are part of. One row per
  // recipient and event, written by `notifyTaskChange` (convex/lib/notify.ts)
  // inside the mutation that made the change, and read only by the recipient
  // (convex/notifications.ts). People are ids, never a name or an address:
  // names are looked up at read, for a caller who may be told them. `title`
  // is the task's title when it happened, so a rename or a delete does not
  // break the row. At most MAX_NOTIFICATIONS per recipient, none older than
  // NOTIFICATION_RETENTION_DAYS.
  notifications: defineTable({
    recipient: v.id("users"),
    kind: notificationKindValidator,
    actor: notificationActorValidator,
    /** The task it is about. Absent on a row about a decision. */
    taskId: v.optional(v.id("tasks")),
    /** "decision_revisit": the decision it is about. */
    decisionId: v.optional(v.id("decisions")),
    /** "handoff": the handoff it is about. */
    handoffId: v.optional(v.id("handoffs")),
    /** "handoff": the start of its summary, as the bot wrote it (plain text, cut). */
    summary: v.optional(v.string()),
    /** The task's (or decision's) company when it happened. Absent: a task shared by both. */
    company: v.optional(companyValidator),
    title: v.string(),
    /** "moved": the column the task went to. */
    column: v.optional(taskColumnValidator),
    /** "reassigned": who the task went to, if they have signed in. */
    to: v.optional(v.id("users")),
    /** "due": the new date, "YYYY-MM-DD", or null when it was cleared. */
    due: v.optional(v.union(v.string(), v.null())),
    createdAt: v.number(),
    readAt: v.optional(v.number()),
  })
    .index("by_recipient_and_createdAt", ["recipient", "createdAt"])
    .index("by_recipient_and_readAt_and_createdAt", ["recipient", "readAt", "createdAt"])
    .index("by_createdAt", ["createdAt"]),

  // One row per suggestion a person sent ("Suggest a change"): what the
  // per-day limit counts. Holds no text. A person's rows from earlier days
  // are deleted the next time they send one.
  suggestionsSent: defineTable({
    userId: v.id("users"),
    /** The UTC day it was sent, "YYYY-MM-DD". */
    day: v.string(),
    at: v.number(),
  }).index("by_userId_and_day", ["userId", "day"]),

  // One note per week, keyed by the week's Monday. The weekly review was
  // removed (2026-10-20): kept only for the rows already stored; nothing
  // reads or writes it.
  weeklyReviews: defineTable({
    weekStart: v.string(),
    wins: v.string(),
    problems: v.string(),
    priorities: v.array(v.string()),
    updatedAt: v.number(),
  }).index("by_weekStart", ["weekStart"]),

  // The owner's own target for a metric, which drives red/green on its tile.
  // Separate from benchmarks: a benchmark is what the market does, a target
  // is what Startup has committed to.
  metricTargets: defineTable({
    key: v.string(),
    scope: v.string(),
    target: v.number(),
  }).index("by_key_and_scope", ["key", "scope"]),

  // ── Pipelines ────────────────────────────────────────────────────────────

  // Sales. `amount` is the expected monthly fee in the market's currency
  // (USD for "us", KZT for "kz").
  deals: defineTable({
    ...pipelineFields,
    market: marketValidator,
    ...dealDetailFields,
    // Who proposed it, for a deal made by approving a `deal_create` (a bot's
    // profile id, or one of the four agents). Absent for one made by hand.
    createdBy: v.optional(v.string()),
    /** The goal it serves: one of its market's goals or both companies' (`deals.setGoal`). */
    goalId: v.optional(v.id("goals")),
  })
    .index("by_source_and_externalId", ["source", "externalId"])
    .index("by_goalId", ["goalId"])
    .index("by_market_and_stage_and_order", ["market", "stage", "order"]),

  // A US deal's sales intelligence (convex/dealIntel.ts, convex/lib/dealIntel.ts):
  // one row a native US deal at most, never a Kazakhstan or mirrored deal and
  // never an investor. Written only by `dealIntel.update` and
  // `dealIntel.importIntel`, through `cleanIntelEdit`: every text held to its
  // limit, no email address, phone number or link, people by name and role,
  // and the one link a source's claude.ai artifact. Deleted with its deal.
  dealIntel: defineTable({
    dealId: v.id("deals"),
    summary: v.optional(v.string()),
    ownership: v.optional(v.string()),
    ehr: v.optional(v.string()),
    pm: v.optional(v.string()),
    billingModel: v.optional(
      v.union(v.literal("in-house"), v.literal("outsourced"), v.literal("hybrid")),
    ),
    rcmVendor: v.optional(v.string()),
    specialties: v.optional(v.array(v.string())),
    ancillaries: v.optional(v.array(v.string())),
    workersComp: v.optional(v.string()),
    competitors: v.optional(v.array(v.object({ name: v.string(), note: v.optional(v.string()) }))),
    signals: v.optional(
      v.array(
        v.object({
          // "YYYY-MM" or "YYYY-MM-DD".
          date: v.optional(v.string()),
          kind: v.union(
            v.literal("hiring"),
            v.literal("funding"),
            v.literal("acquisition"),
            v.literal("technology"),
            v.literal("leadership"),
            v.literal("growth"),
            v.literal("news"),
            v.literal("meeting"),
          ),
          text: v.string(),
          source: v.string(),
        }),
      ),
    ),
    people: v.optional(
      v.array(v.object({ name: v.string(), role: v.string(), note: v.optional(v.string()) })),
    ),
    painPoints: v.optional(v.array(v.string())),
    talkingPoints: v.optional(v.array(v.string())),
    risks: v.optional(v.array(v.string())),
    angle: v.optional(v.string()),
    nextBestAction: v.optional(v.string()),
    fit: v.optional(v.object({ score: v.number(), reasons: v.array(v.string()) })),
    sources: v.optional(v.array(v.object({ title: v.string(), url: v.string() }))),
    researchedAt: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_dealId", ["dealId"]),

  // What came of a play a bot ran (Bot Loop v3, convex/outcomes.ts): on a
  // deal, a customer, an investor or a partner of that company, checked to
  // exist when logged. `agent` is who logged it (a bot's profile id, or one of
  // the four), never an argument the call chose. Evidence is plain text, 500
  // characters, no email address or phone number. A pending one may be
  // updated by whoever logged it; a decided one stays. Days are "YYYY-MM-DD".
  outcomes: defineTable({
    company: marketValidator,
    agent: v.string(),
    subject: v.object({
      kind: v.union(...OUTCOME_SUBJECT_KINDS.map((kind) => v.literal(kind))),
      id: v.string(),
    }),
    play: v.string(),
    channel: v.optional(v.union(...OUTCOME_CHANNELS.map((channel) => v.literal(channel)))),
    result: v.union(...OUTCOME_RESULTS.map((result) => v.literal(result))),
    signal: v.optional(v.union(...OUTCOME_SIGNALS.map((signal) => v.literal(signal)))),
    evidence: v.string(),
    actedOn: v.string(),
    observedOn: v.optional(v.string()),
    proposalId: v.optional(v.id("proposals")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_company_and_actedOn", ["company", "actedOn"])
    .index("by_subject_and_actedOn", ["subject.kind", "subject.id", "actedOn"])
    .index("by_agent_and_actedOn", ["agent", "actedOn"]),

  // Fundraising. `amount` is the cheque under discussion, in USD.
  // `createdBy` is the bot or agent that added one through `investor_create`
  // (absent for a card made on the page, or mirrored from Visible).
  // `referralSource` is where that introduction came from (the tool's
  // `source`). It is not the system of record: that stays `source`.
  //
  // Visible write-back (convex/lib/investorSync.ts, docs/ingest.md "Visible
  // write-back"): `archivedBy: "owner"` marks an investor the owner archived
  // here, which a Visible pull leaves archived (a push's own archive has no
  // `archivedBy` and is undone when Visible lists the row again).
  // `changedInVisibleAt` is when a pull last overrode a change sent from here
  // with a different value someone set in Visible; the pull clears it after
  // seven days.
  investors: defineTable({
    ...pipelineFields,
    createdBy: v.optional(v.string()),
    referralSource: v.optional(v.string()),
    archivedBy: v.optional(v.literal("owner")),
    changedInVisibleAt: v.optional(v.number()),
  })
    .index("by_source_and_externalId", ["source", "externalId"])
    .index("by_stage_and_order", ["stage", "order"]),

  // Changes made to an investor here, waiting to be written back to Visible by
  // the daily connector run (convex/lib/investorSync.ts, convex/visibleOutbox.ts).
  // At most one pending-or-failed row per investor: a later change merges into
  // it, the latest value of each field winning, and bumps `revision` so an ack
  // for what was listed before cannot mark the newer values sent. `kind` is
  // "create" for an investor made here (the whole card) and "update" for one
  // linked to Visible. `fields` holds only what changed (amount null clears
  // it); `note` the next step and notes, written to Visible as a note. `by` is
  // a member's user id or a bot's or agent's label. `errorCode` is the run's
  // own snake_case code, never Visible's words. A confirmed row is history,
  // pruned after 30 days.
  investorSync: defineTable({
    investorId: v.id("investors"),
    kind: v.union(v.literal("create"), v.literal("update")),
    fields: v.object({
      stage: v.optional(v.string()),
      amount: v.optional(v.union(v.number(), v.null())),
      name: v.optional(v.string()),
    }),
    note: v.optional(
      v.object({
        nextStep: v.optional(v.union(v.string(), v.null())),
        notes: v.optional(v.union(v.string(), v.null())),
      }),
    ),
    status: v.union(
      v.literal("pending"),
      v.literal("sent"),
      v.literal("failed"),
      v.literal("confirmed"),
    ),
    revision: v.number(),
    attempts: v.number(),
    errorCode: v.optional(v.string()),
    queuedAt: v.number(),
    sentAt: v.optional(v.number()),
    confirmedAt: v.optional(v.number()),
    by: v.string(),
  })
    .index("by_investorId_and_queuedAt", ["investorId", "queuedAt"])
    .index("by_status_and_queuedAt", ["status", "queuedAt"]),

  // Partnerships (convex/partnerships.ts): channel, integration, referral,
  // strategic and design partners, from first contact to live. Every row is
  // made and edited here (no source mirrors it), on one company. Written only
  // through `cleanPartnerEdit` (convex/lib/partnerFields.ts): names and a
  // contact's role by text, never an email address, phone number or patient;
  // links are https addresses. `nextStepOn` is "YYYY-MM-DD". `editedBy` is the
  // owner's Claude client that last changed it, absent for a change made in
  // the app.
  partners: defineTable({
    company: marketValidator,
    name: v.string(),
    type: partnerTypeValidator,
    stage: partnerStageValidator,
    order: v.number(),
    owner: v.optional(v.string()),
    contact: v.optional(v.string()),
    contactRole: v.optional(v.string()),
    value: v.optional(v.number()),
    valueKind: v.optional(partnerValueKindValidator),
    notes: v.optional(v.string()),
    nextStep: v.optional(v.string()),
    nextStepOn: v.optional(v.string()),
    lastActivityAt: v.optional(v.number()),
    links: v.optional(v.array(v.object({ label: v.string(), url: v.string() }))),
    editedBy: v.optional(v.string()),
  }).index("by_company_and_stage_and_order", ["company", "stage", "order"]),

  // Business contacts (convex/contacts.ts): people Startup or Globex works
  // with. Never a patient. US and KZ rows never mix (`company` on every row
  // and on the email index). The free-text contact fields on deals, investors
  // and partners stay as they are; `migrations:contactsFromRecords` read them
  // once into contacts linked to their record, and changed none of them.
  // `source` and `externalId` say which pushed person a row is (the pushing
  // source's own id, convex/lib/contactPush.ts), so a later push updates the
  // same row: set once, by the first push that made or matched it.
  // `emails` is the list the page shows. Convex cannot index inside an array,
  // so `contactEmails` is the lookup, written in the same transaction and
  // never logged. `normalizedName` is derived (lowercase, accents and
  // punctuation gone, courtesy titles dropped). `introducedBy` is another
  // contact of the same company.
  contacts: defineTable({
    name: v.string(),
    emails: v.array(v.string()),
    phone: v.optional(v.string()),
    linkedin: v.optional(v.string()),
    org: v.optional(v.string()),
    title: v.optional(v.string()),
    company: marketValidator,
    category: contactCategoryValidator,
    linkedRecords: v.array(v.object({ type: contactLinkTypeValidator, id: v.string() })),
    howMet: v.optional(v.string()),
    introducedBy: v.optional(v.id("contacts")),
    canIntroTo: v.array(v.string()),
    lastContactAt: v.optional(v.number()),
    interactionCount: v.number(),
    owner: v.optional(v.string()),
    notes: v.optional(v.string()),
    normalizedName: v.string(),
    source: v.optional(contactSourceValidator),
    externalId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_company", ["company"])
    .index("by_company_and_normalizedName", ["company", "normalizedName"])
    .index("by_company_and_source_and_externalId", ["company", "source", "externalId"])
    .index("by_introducedBy", ["introducedBy"]),

  // One row per address per company, pointing at the contact that holds it.
  // The address is stored lower case. Unique within a company, enforced by
  // the mutation (Convex has no unique constraint). The same address may
  // exist on the other company.
  contactEmails: defineTable({
    company: marketValidator,
    email: v.string(),
    contactId: v.id("contacts"),
  })
    .index("by_company_and_email", ["company", "email"])
    .index("by_contactId", ["contactId"]),

  // ── Metrics ──────────────────────────────────────────────────────────────

  // One row per (metric, scope, bucket). `key`, `scope` and `source` are
  // plain strings here and checked against convex/lib/metricRegistry.ts on
  // every write, so adding a metric is a code change, not a migration.
  // `periodStart` is the canonical UTC bucket start ("YYYY-MM-DD"), which
  // makes a re-run of the same sync an overwrite rather than a new row.
  metricSnapshots: defineTable({
    key: v.string(),
    scope: v.string(),
    period: periodValidator,
    periodStart: v.string(),
    value: v.number(),
    currency: v.optional(v.string()),
    source: v.string(),
    syncedAt: v.number(),
  }).index("by_key_and_scope_and_period_and_periodStart", [
    "key",
    "scope",
    "period",
    "periodStart",
  ]),

  // Current state of each source, one row each. This is what the UI reads.
  sourceStatus: defineTable({
    source: v.string(),
    state: runStatusValidator,
    message: v.optional(v.string()),
    lastRunAt: v.number(),
    lastOkAt: v.optional(v.number()),
  }).index("by_source", ["source"]),

  // When each pulled source was last started by hand ("Run now"): one row a
  // source, so a source is started at most once a minute, whoever asks.
  sourceRunRequests: defineTable({ source: v.string(), at: v.number() }).index("by_source", [
    "source",
  ]),

  // Append-only log of runs, pruned by a weekly cron.
  syncRuns: defineTable({
    source: v.string(),
    batchId: v.optional(v.string()),
    // When the source says it read the data, as an ISO timestamp (pushes only).
    observedAt: v.optional(v.string()),
    startedAt: v.number(),
    finishedAt: v.number(),
    status: runStatusValidator,
    message: v.optional(v.string()),
    inserted: v.number(),
    updated: v.number(),
    unchanged: v.number(),
    // Pipeline rows a "replace" push took off the board.
    archived: v.optional(v.number()),
  }).index("by_startedAt", ["startedAt"]),

  // The financial model's plan: one row per (scenario, year, figure). Not a
  // metric: it describes years that have not happened, so it has no snapshot
  // and no benchmark. Written only by plan.apply, from the financial_model
  // source's push, which is always the whole plan.
  planFigures: defineTable({
    scenario: planScenarioValidator,
    year: v.number(),
    key: v.string(),
    value: v.number(),
    modelVersion: v.string(),
    syncedAt: v.number(),
  }).index("by_scenario_and_year_and_key", ["scenario", "year", "key"]),

  // ── Customers and compliance ─────────────────────────────────────────────

  // One row per clinic. THE ONLY PLACE A CLIENT NAME IS STORED. Everything
  // except `nextTouch`, `note` and `dealId` belongs to the source (the CFO's
  // client register) and is overwritten by each push; those belong to the
  // owner and no push touches them. A clinic missing from a push is archived,
  // not deleted. An absent optional field means "not on record", never zero.
  // A second source, `deals`, is a clinic won on the Sales board that the
  // register does not carry yet (convex/lib/wonCustomers.ts): the register's
  // push supersedes it, and never archives or deletes it otherwise.
  customers: defineTable({
    source: v.string(),
    // The name, normalised (nameKeyOf): what makes two pushes the same clinic.
    nameKey: v.string(),
    name: v.string(),
    market: marketValidator,
    status: customerStatusValidator,
    currency: v.string(),
    monthlyFee: v.optional(v.number()),
    lastPaymentDate: v.optional(v.string()),
    amountOwed: v.optional(v.number()),
    lastUsageDate: v.optional(v.string()),
    contractDate: v.optional(v.string()),
    baaDate: v.optional(v.string()),
    nextTouch: v.optional(v.string()),
    note: v.optional(v.string()),
    syncedAt: v.number(),
    archivedAt: v.optional(v.number()),
    // The clinic's id in Globex's app (PostHog's `organization_id`): the
    // link its usage and doctors are written by. Set by the PostHog run when a
    // name matches once, or by hand on the clinic's page; never by a push.
    appOrgId: v.optional(v.string()),
    // App clinic ids someone unlinked from this clinic by hand: the PostHog run
    // never links one of them to it again by name. Linking it by hand clears it.
    appOrgUnlinked: v.optional(v.array(v.string())),
    // The deal it was won from (convex/lib/wonCustomers.ts). On a row of the
    // `deals` source it is what made the row; on the register's, a link the
    // Sales board added. No push writes it.
    dealId: v.optional(v.id("deals")),
  })
    .index("by_source_and_nameKey", ["source", "nameKey"])
    .index("by_nameKey_and_market", ["nameKey", "market"])
    .index("by_dealId", ["dealId"])
    .index("by_appOrgId", ["appOrgId"]),

  // Each clinic Globex's app knows, by its id there, with its latest
  // finished week and its link to Customers, if any. No name: a clinic not
  // linked yet is listed by its id and counts, to be linked by hand.
  kzAppClinics: defineTable({
    org: v.string(),
    customerId: v.optional(v.id("customers")),
    // Finished weeks it has been seen in, its actions and doctors last week, and its last day of work.
    weeks: v.number(),
    actions: v.number(),
    doctors: v.number(),
    lastActiveOn: v.optional(v.string()),
    syncedAt: v.number(),
  })
    .index("by_org", ["org"])
    .index("by_customerId", ["customerId"]),

  // How much a clinic used Globex's app in a finished week (Monday, UTC):
  // counts only, by the clinic's row in `customers`, never a name, a doctor or
  // what a check said. `modules` is actions by module id
  // (convex/lib/kzProductDetail.ts); a module with no row is unknown, not zero.
  customerUsage: defineTable({
    customerId: v.id("customers"),
    weekStart: v.string(),
    checks: v.number(),
    actions: v.number(),
    doctors: v.number(),
    // Its doctors in the app that week, whether they did anything or not.
    doctorsTotal: v.optional(v.number()),
    // Days of the week with at least one action.
    activeDays: v.optional(v.number()),
    // The last day with an action, as of the week's end.
    lastActiveOn: v.optional(v.string()),
    // What it was on in the app that week.
    plan: v.optional(v.union(v.literal("paid"), v.literal("trial"))),
    failures: v.number(),
    modules: v.record(v.string(), v.number()),
    syncedAt: v.number(),
  }).index("by_customerId_and_weekStart", ["customerId", "weekStart"]),

  // A clinic's doctors and their last finished week in Globex's app, for
  // the clinic's drawer. A doctor's name is personal data: it is read only by
  // `customers.doctors`, for the clinic's own market, and goes in no log,
  // error, snapshot or other table. `doctorId` is Globex's own id for the
  // person, so a renamed doctor is the same row. Counts, never what a check said.
  customerDoctors: defineTable({
    customerId: v.id("customers"),
    doctorId: v.string(),
    name: v.string(),
    weekStart: v.string(),
    week: v.union(...DOCTOR_WEEKS.map((w) => v.literal(w))),
    // The segment the week before put them in; absent for a doctor new then.
    weekBefore: v.optional(v.union(...DOCTOR_WEEKS.map((w) => v.literal(w)))),
    actions: v.number(),
    previous: v.optional(v.number()),
    usual: v.optional(v.number()),
    activeDays: v.optional(v.number()),
    lastActiveOn: v.optional(v.string()),
    // The name of their last event in the app (an event type, never its text).
    lastEvent: v.optional(v.string()),
    // The module most of their actions were in.
    mainModule: v.optional(v.string()),
    plan: v.optional(v.union(v.literal("paid"), v.literal("trial"))),
    // Their trial, once it has ended: when, what came of it, and their
    // actions in the weeks before and since.
    trialEndedOn: v.optional(v.string()),
    trialOutcome: v.optional(v.union(...TRIAL_OUTCOMES.map((t) => v.literal(t)))),
    actionsBeforeTrialEnd: v.optional(v.number()),
    actionsAfterTrialEnd: v.optional(v.number()),
    // Actions by module last week and the week before.
    modules: v.record(v.string(), v.number()),
    modulesPrevious: v.optional(v.record(v.string(), v.number())),
    // Their finished weeks, oldest first (53 at most): actions, days with an
    // action and actions by module, so a period longer than a week can be read.
    history: v.optional(
      v.array(
        v.object({
          weekStart: v.string(),
          actions: v.number(),
          days: v.number(),
          modules: v.record(v.string(), v.number()),
        }),
      ),
    ),
    syncedAt: v.number(),
  }).index("by_customerId_and_doctorId", ["customerId", "doctorId"]),

  // Globex's app in breakdowns a weekly figure cannot hold, one row a key a
  // finished week: `hour` (the week's hours on the app's users' clock,
  // KZ_APP_UTC_OFFSET_HOURS in convex/lib/features.ts, "1-11" = Monday 11:00:
  // failures and actions, for the heat map), `page` (a page's path with its ids
  // as ":id": interface response and rage clicks), `event` (an event's name:
  // how often and by how many people, for tracking health) and `field` ("event
  // · property": how often it was empty). Counts and names of events and pages
  // only: never a person, a clinic or what was typed.
  kzBreakdowns: defineTable({
    kind: v.union(v.literal("hour"), v.literal("page"), v.literal("event"), v.literal("field")),
    weekStart: v.string(),
    key: v.string(),
    values: v.record(v.string(), v.number()),
    syncedAt: v.number(),
  }).index("by_kind_and_weekStart", ["kind", "weekStart"]),

  // Compliance and corporate items. `due` is a deadline only when
  // `dueConfirmed` is true. `anchorDay` is the day of the month the date was
  // first given, so a monthly item set for the 31st returns to the 31st.
  obligations: defineTable({
    category: obligationCategoryValidator,
    title: v.string(),
    due: v.optional(v.string()),
    dueConfirmed: v.boolean(),
    anchorDay: v.optional(v.number()),
    recurrence: recurrenceValidator,
    status: obligationStatusValidator,
    evidenceUrl: v.optional(v.string()),
    note: v.optional(v.string()),
    sourceUrl: v.optional(v.string()),
    // Which starter-checklist item this came from, so adding the list twice adds nothing.
    seedKey: v.optional(v.string()),
    lastDoneAt: v.optional(v.number()),
    lastDoneFor: v.optional(v.string()),
    lastEvidenceUrl: v.optional(v.string()),
    // When it was last edited or finished; a row never changed has only its
    // `_creationTime`. Read as the Compliance page's "last change".
    updatedAt: v.optional(v.number()),
  }).index("by_seedKey", ["seedKey"]),

  // ── Questionnaires, vendor agreements and evidence ───────────────────────
  // Working records beside the obligations (convex/evidence.ts). Links only:
  // no document and no secret is stored. `changedBy` is who wrote last: a
  // person's name, or the client that wrote it over MCP. The lists mirror
  // convex/lib/evidence.ts.

  securityQuestionnaires: defineTable({
    requester: v.string(),
    company: companyValidator,
    receivedOn: v.optional(v.string()),
    dueOn: v.optional(v.string()),
    status: v.union(v.literal("todo"), v.literal("in_progress"), v.literal("sent"), v.literal("accepted")),
    owner: v.optional(v.string()),
    link: v.optional(v.string()),
    notes: v.optional(v.string()),
    changedBy: v.optional(v.string()),
    updatedAt: v.number(),
  }),

  // Approved answers a bot may draft from. Absent `company` is both.
  answerBank: defineTable({
    question: v.string(),
    answer: v.string(),
    tags: v.array(v.string()),
    company: v.optional(companyValidator),
    lastReviewedOn: v.optional(v.string()),
    changedBy: v.optional(v.string()),
    updatedAt: v.number(),
  }),

  vendorAgreements: defineTable({
    vendor: v.string(),
    type: v.union(v.literal("baa"), v.literal("dpa"), v.literal("msa"), v.literal("nda"), v.literal("subscription")),
    company: companyValidator,
    signedOn: v.optional(v.string()),
    expiresOn: v.optional(v.string()),
    status: v.union(v.literal("draft"), v.literal("out_for_signature"), v.literal("active"), v.literal("ended")),
    link: v.optional(v.string()),
    notes: v.optional(v.string()),
    changedBy: v.optional(v.string()),
    updatedAt: v.number(),
  }),

  complianceControls: defineTable({
    framework: v.union(v.literal("hipaa"), v.literal("soc2"), v.literal("iso27001")),
    controlId: v.string(),
    title: v.string(),
    changedBy: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_framework_and_controlId", ["framework", "controlId"]),

  evidenceItems: defineTable({
    controlId: v.id("complianceControls"),
    title: v.string(),
    link: v.optional(v.string()),
    owner: v.optional(v.string()),
    collectedOn: v.optional(v.string()),
    validUntil: v.optional(v.string()),
    status: v.union(v.literal("missing"), v.literal("collected"), v.literal("expired"), v.literal("accepted")),
    changedBy: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_controlId", ["controlId"]),

  // ── Investor update ──────────────────────────────────────────────────────

  // The owner's edited text of a month's investor update, keyed by the
  // month's first day. Only the words are stored: the numbers in a draft are
  // worked out at read time and are never written here by the OS. The
  // investor update was removed (2026-10-20): kept only for the rows already
  // stored; nothing reads or writes it.
  investorUpdates: defineTable({
    month: v.string(),
    text: v.string(),
    updatedAt: v.number(),
  }).index("by_month", ["month"]),

  // ── Work tools (Phase 8) ─────────────────────────────────────────────────

  // Records mirrored from Gmail, Calendar, Linear and Fireflies. The only
  // table that holds text another system chose. Written only by
  // convex/mirror.ts; read only by convex/workTools.ts.
  //
  // Records have an owner. A row with no `owner` is the deployment owner's:
  // what the OS reads itself and what the per-source ingest tokens push (the
  // shared Linear board among it). A row with an `owner` is that teammate's
  // own, pushed with their personal token, and is sent to them and nobody
  // else, the owner included. BOTH INDEXES LEAD WITH `owner`, and there is no
  // index without it: a read cannot range over a source without first saying
  // whose rows it wants (`holderKey` in convex/lib/personal.ts).
  //
  // It also holds Apollo's two shared lists (source "apollo": its sequences,
  // and contacts and accounts by stage), pushed with Apollo's token. They have
  // no `owner` and are nobody's personal records: the team's own labels and
  // counts, written by `mirror.applyShared` alone and read by
  // `workTools.outbound` alone. No work tool's write or read names that source.
  // GitHub's two lists (source "github") are held the same way: no `owner`,
  // written by `mirror.applyShared` alone. Its repositories (kind "repo": a
  // name, a company and counts) are read by `workTools.engineering` alone;
  // its pull requests (kind "pull_request": a title, an author, who is asked
  // to review, states and dates) by `workTools.pullRequests` alone. Both
  // reads are the `engineering` area's and send a caller only the rows of the
  // companies they are on.
  //
  // A teammate's row also names the person: `userId` is the `users` row that
  // sent it. An address can pass to another Google identity (a `users` row
  // deleted, an address changed at Google), and the next holder of the address
  // must be sent nothing of the last one's. A row under an address whose
  // `userId` is missing or is not the reader's is nobody's: never sent, and
  // deleted by the next write or prune.
  mirrorRecords: defineTable({
    /** A teammate's lower-cased address. Absent on the deployment owner's rows. */
    owner: v.optional(v.string()),
    /** The teammate's own `users` row. Absent on the deployment owner's rows. */
    userId: v.optional(v.id("users")),
    source: storedSourceValidator,
    externalId: v.string(),
    sortAt: v.number(),
    syncedAt: v.number(),
    record: storedRecordValidator,
  })
    .index("by_owner_and_source_and_externalId", ["owner", "source", "externalId"])
    .index("by_owner_and_source_and_sortAt", ["owner", "source", "sortAt"]),

  // How each teammate's own pushes of one tool stand: the per-person twin of
  // `sourceStatus`, which is the deployment's and which a personal push never
  // touches. `message` is one of this codebase's own sentences. The last two
  // fields count pushes for the rate limit (convex/lib/personal.ts).
  personalSourceStatus: defineTable({
    owner: v.string(),
    /** The person the row is about. A row without one is nobody's. */
    userId: v.optional(v.id("users")),
    source: mirrorSourceValidator,
    state: v.optional(v.union(v.literal("ok"), v.literal("error"))),
    message: v.optional(v.string()),
    lastRunAt: v.optional(v.number()),
    lastOkAt: v.optional(v.number()),
    windowStart: v.optional(v.number()),
    pushes: v.optional(v.number()),
  }).index("by_owner_and_source", ["owner", "source"]),

  // A teammate's token for pushing their own records to POST /ingest/v1. Only
  // the SHA-256 of the token is stored (hex): the token is shown once, when
  // it is made, and can be neither read back nor rebuilt from this row. One
  // row per person at most. Read and written only through
  // convex/lib/personal.ts. `userId` is the `users` row that made it: the
  // token is honoured only while that same row still holds the address.
  personalTokens: defineTable({
    owner: v.string(),
    /** Who made it. A token without one is never honoured. */
    userId: v.optional(v.id("users")),
    tokenHash: v.string(),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
  }).index("by_owner", ["owner"]),

  // The owner's agent tokens (convex/assistant.ts, `sosa_…`): what a client
  // the owner connected (Claude Code on the Mac, a Grok bot, …) presents at
  // POST /mcp/v1 to read the OS and act in it. Not a personal token and never
  // in that table: these are the owner's alone, read company data and write
  // no mirror row. One row a client, at most MAX_AGENT_TOKENS; only the
  // SHA-256 is stored. Honoured only while `userId` is still a verified
  // owner. The counters are the client's own fixed-window limits.
  agentTokens: defineTable({
    userId: v.id("users"),
    tokenHash: v.string(),
    scope: agentScopeValidator,
    /**
     * What the owner called the client, cleaned. A row from before clients
     * had names (one token at a time) has none: it is shown as
     * LEGACY_TOKEN_NAME and is the Mac's runner (convex/lib/agentToken.ts).
     */
    name: v.optional(v.string()),
    /** Whether this is the Mac's runner, the one client that may call the runner's tools. One at most. */
    runner: v.optional(v.boolean()),
    /** Whether only the owner's bots may use it; unset reads as `tokenBotsOnly` says (convex/lib/agentToken.ts). */
    botsOnly: v.optional(v.boolean()),
    /** The one bot it was made for (a bot profile's id): no other bot may call through it. */
    onlyBot: v.optional(v.string()),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    windowStart: v.optional(v.number()),
    calls: v.optional(v.number()),
    actWindowStart: v.optional(v.number()),
    acts: v.optional(v.number()),
    /** The window a "limit reached" row was last written for: one a window. */
    limitNotedFor: v.optional(v.number()),
    /** The chat runner's own window (convex/lib/chatRules.ts): counted apart from a model's calls. */
    runnerWindowStart: v.optional(v.number()),
    runnerCalls: v.optional(v.number()),
    runnerLimitNotedFor: v.optional(v.number()),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_userId", ["userId"]),

  // OAuth 2.1 for the agent endpoint (convex/oauth.ts, convex/lib/oauthRules.ts).
  // The owner is the only user. Every secret is kept as its SHA-256 alone: a
  // client's secret, a code, an access token, a refresh token.
  //
  // A client: one that registered itself (RFC 7591, `dynamic`) or one the
  // owner added by hand on the connection page (`owner`). `name` was typed
  // by whoever made it (a self-registered client names itself): cleaned and
  // rendered as text. A confidential client has `secretHash`.
  oauthClients: defineTable({
    clientId: v.string(),
    name: v.string(),
    redirectUris: v.array(v.string()),
    secretHash: v.optional(v.string()),
    createdBy: v.union(v.literal("dynamic"), v.literal("owner")),
    createdAt: v.number(),
  })
    .index("by_clientId", ["clientId"])
    .index("by_createdBy_and_createdAt", ["createdBy", "createdAt"]),

  // The owner's approval of one request, until the client exchanges it: a
  // code lives CODE_SECONDS and is used once (`usedAt`; a second use revokes
  // the grant it made, `grantId`).
  oauthCodes: defineTable({
    codeHash: v.string(),
    clientId: v.string(),
    userId: v.id("users"),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    scope: agentScopeValidator,
    resource: v.string(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
    grantId: v.optional(v.id("oauthGrants")),
  })
    .index("by_codeHash", ["codeHash"])
    .index("by_expiresAt", ["expiresAt"]),

  // A client the owner approved: a connected client beside the named tokens,
  // with its own scope, limits and audit name. One a client; revoking it
  // deletes it and every token it holds.
  oauthGrants: defineTable({
    userId: v.id("users"),
    clientId: v.string(),
    /** The client's name when it was approved. */
    clientName: v.string(),
    /** Where the browser was sent back to, as the owner was shown it. */
    redirectHost: v.string(),
    scope: agentScopeValidator,
    resource: v.string(),
    /** Whether only the owner's bots may use it: set on for a grant approved since the setting existed. */
    botsOnly: v.optional(v.boolean()),
    /**
     * The bot whose own address (`/mcp/v1/bot/<id>`) the grant was made for:
     * its tokens are used there alone, and every call is that bot's.
     */
    onlyBot: v.optional(v.string()),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    windowStart: v.optional(v.number()),
    calls: v.optional(v.number()),
    actWindowStart: v.optional(v.number()),
    acts: v.optional(v.number()),
    limitNotedFor: v.optional(v.number()),
    runnerWindowStart: v.optional(v.number()),
    runnerCalls: v.optional(v.number()),
    runnerLimitNotedFor: v.optional(v.number()),
  })
    .index("by_userId", ["userId"])
    .index("by_clientId", ["clientId"]),

  // A grant's tokens: an access token (an hour) and a refresh token, rotated
  // on each use (`rotatedAt`: one used again revokes the grant).
  oauthTokens: defineTable({
    grantId: v.id("oauthGrants"),
    kind: v.union(v.literal("access"), v.literal("refresh")),
    tokenHash: v.string(),
    expiresAt: v.number(),
    rotatedAt: v.optional(v.number()),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_grantId", ["grantId"])
    .index("by_expiresAt", ["expiresAt"]),

  // What the owner's agent called, for the owner to read (assistant.recentCalls).
  // A tool's registered name, its kind, when, how it ended and how long it
  // took. **No argument, title, name or text**: a call with a tool name the
  // registry does not hold is written as "unknown". Pruned daily to the
  // newest 500 and thirty days.
  agentCalls: defineTable({
    userId: v.id("users"),
    tool: v.string(),
    kind: agentScopeValidator,
    at: v.number(),
    outcome: agentOutcomeValidator,
    durationMs: v.number(),
    /** Which agent said it was calling, for a tool that takes one. Rows from before have none. */
    agent: v.optional(agentValidator),
    /** The Mac's run of one of the four agents the call was made in (convex/lib/osAgentRuns.ts): an id, never text. */
    runId: v.optional(v.string()),
    /** Which client made the call. Rows from before clients had names have none. */
    client: v.optional(agentClientValidator),
    /** That client's name when the call was made: the owner's words for it, never anything the call sent. */
    clientName: v.optional(v.string()),
    /** The owner's bot that named itself (convex/bots.ts), by its id: a profile's, never what a call sent unchecked. */
    bot: v.optional(v.string()),
    /** A refused bot call's code (and a not-permitted one's area and level), for the Bots tab. */
    refusal: v.optional(agentRefusalValidator),
    /** What a matched bot said the call cost it, in USD (0 to 100, `costUsd` on the call): a bot's alone. */
    costUsd: v.optional(v.number()),
  })
    .index("by_userId_and_at", ["userId", "at"])
    .index("by_userId_and_bot_and_at", ["userId", "bot", "at"])
    .index("by_at", ["at"])
    .index("by_runId", ["runId"]),

  // The owner's bots (convex/bots.ts, convex/lib/botRules.ts): external
  // bots that call /mcp/v1 through a connected client and name themselves.
  // Each holds a level for each area it may (never a locked one: the
  // validator does not hold them) and its own limits. The owner's alone.
  bots: defineTable({
    userId: v.id("users"),
    /** What the bot sends as `agent`: lower case, never one of the four. */
    botId: v.string(),
    name: v.string(),
    role: v.string(),
    /** "any" connected client, or only these. */
    clients: v.union(v.literal("any"), v.array(agentClientValidator)),
    permissions: v.array(botPermissionValidator),
    limits: botLimitsValidator,
    enabled: v.boolean(),
    /** Seeded as a suggestion and not yet edited by the owner. */
    suggested: v.boolean(),
    /** The company it works for, as the owner set it on the Bots tab; none until then. */
    company: v.optional(botCompanyValidator),
    /** Its monthly budget in USD, as the owner set it; none means no budget. */
    monthlyBudgetUsd: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_userId_and_botId", ["userId", "botId"])
    .index("by_botId", ["botId"]),

  // The outbound events webhook's state, one row a bot (convex/botEvents.ts):
  // this hour's counts for its limit, when a delivery last went through, and
  // the last failure in fixed words (`network`, `http N`, `unusable`). Counts
  // and closed words only: never a title, an id of a row, a URL or a secret.
  botEventStatus: defineTable({
    /** The profile id, `bots.botId`. */
    bot: v.string(),
    windowStart: v.number(),
    sent: v.number(),
    dropped: v.number(),
    lastSentAt: v.optional(v.number()),
    lastFailure: v.optional(v.object({ what: v.string(), at: v.number() })),
  }).index("by_bot", ["bot"]),

  // Each bot's calls a UTC day (convex/lib/botTelemetry.ts): the `agents`
  // read's and the Bots tab's week and month, kept apart from `agentCalls`
  // (pruned to its newest 500) so a busy day does not shorten a week. Written
  // with each call `assistant.record` writes for a matched bot. Counts, a
  // duration histogram, the cost it reported and its client's provider: no
  // argument, name or text. Kept `BOT_CALL_DAYS_KEPT` days (`assistant.prune`).
  botCallDays: defineTable({
    userId: v.id("users"),
    bot: v.string(),
    /** "YYYY-MM-DD", UTC. */
    day: v.string(),
    calls: v.number(),
    errors: v.number(),
    invalid: v.number(),
    refused: v.number(),
    /** Calls per duration bucket (`DURATION_BUCKETS_MS`, then one past the last edge). */
    buckets: v.array(v.number()),
    maxMs: v.number(),
    /** USD the bot reported that day, and on how many calls. */
    costUsd: v.number(),
    costCalls: v.number(),
    lastAt: v.number(),
    /** The provider of the client its newest call that day came through. */
    provider: botProviderValidator,
  })
    .index("by_userId_and_bot_and_day", ["userId", "bot", "day"])
    .index("by_day", ["day"]),

  // The rules the owner gives every bot, and each bot's own note: a version a
  // publish (`bots.publishRules`), the newest read by `whoami` and `bot_rules`.
  // The owner's words; never written by a bot.
  botRuleVersions: defineTable({
    userId: v.id("users"),
    version: v.number(),
    rules: v.string(),
    /** One bot's own note, by its profile's id. */
    notes: v.array(v.object({ bot: v.string(), text: v.string() })),
    publishedAt: v.number(),
  }).index("by_userId_and_version", ["userId", "version"]),

  // A bot's counters on one client (convex/assistant.ts, `admit`): its own
  // limits are counted here, so no bot uses another's. `bot` "*" is the
  // client's ceiling for its bots together. Counts and times only.
  botUsage: defineTable({
    userId: v.id("users"),
    /** `kind:id` of the client (botRules.clientKey). */
    client: v.string(),
    bot: v.string(),
    windowStart: v.optional(v.number()),
    calls: v.optional(v.number()),
    actWindowStart: v.optional(v.number()),
    acts: v.optional(v.number()),
    /** The UTC day `proposals`, `callsToday` and `refusalsToday` count. */
    day: v.optional(v.string()),
    proposals: v.optional(v.number()),
    callsToday: v.optional(v.number()),
    refusalsToday: v.optional(v.number()),
    limitNotedFor: v.optional(v.number()),
    lastCallAt: v.optional(v.number()),
    /**
     * `whoami` and `bot_rules` (CALLER_TOOLS), counted in a window of their
     * own; the window an answered call and a refused one were last written to
     * the audit in (at most one of each a window).
     */
    callerWindowStart: v.optional(v.number()),
    callerCalls: v.optional(v.number()),
    callerOkNotedFor: v.optional(v.number()),
    callerRefusalNotedFor: v.optional(v.number()),
  })
    .index("by_client_and_bot", ["client", "bot"])
    .index("by_userId_and_bot", ["userId", "bot"]),

  // Which of the owner's agents are switched off (convex/lib/agentStore.ts).
  // One row at most; an agent it does not list is on. The owner's alone.
  agentSettings: defineTable({ off: v.array(agentValidator), updatedAt: v.number() }),

  // The near-duplicate check's threshold (convex/lib/duplicates.ts), the
  // owner's: one row, absent until he sets it (0.82 meanwhile).
  duplicateSettings: defineTable({ threshold: v.number(), updatedAt: v.number() }),

  // One row a near-duplicate check, to tune the threshold: the tool, the best
  // score seen and what was decided. Numbers and closed words only: never a
  // title, a name or an id. Kept 30 days (the daily sweep).
  duplicateChecks: defineTable({
    at: v.number(),
    tool: v.union(...DUPLICATE_CHECK_TOOLS.map((t) => v.literal(t))),
    sim: v.number(),
    threshold: v.number(),
    decision: v.union(...DUPLICATE_DECISIONS.map((d) => v.literal(d))),
  }).index("by_at", ["at"]),

  // The daily brief (convex/lib/briefs.ts): what the owner's agents found,
  // one row a company a day, replaced when written again. **Written by a
  // model**: each bullet is cleaned, one line, bounded and rendered as text.
  // `page` is one of a closed list of the app's own paths, never an address.
  briefs: defineTable({
    company: companyValidator,
    /** "YYYY-MM-DD". */
    day: v.string(),
    bullets: v.array(
      v.object({ agent: agentValidator, text: v.string(), page: v.optional(v.string()) }),
    ),
    writtenAt: v.number(),
  })
    .index("by_company_and_day", ["company", "day"])
    .index("by_writtenAt", ["writtenAt"]),

  // What an agent proposes and the owner decides (convex/lib/proposals.ts).
  // Nothing in a row happens until the owner approves it on /assistant.
  // `reason` and the payload's text were written by a model: cleaned,
  // bounded, rendered as text. `dismissReason` is the owner's own words.
  proposals: defineTable({
    agent: agentValidator,
    /**
     * The owner-managed bot that proposed it (its profile's id, a slug), when a
     * bot did; `agent` is then the agent it is filed under for limits and the switch.
     */
    bot: v.optional(v.string()),
    kind: proposalKindValidator,
    company: companyValidator,
    reason: v.string(),
    payload: proposalPayloadValidator,
    dedupeKey: v.string(),
    status: proposalStatusValidator,
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
    /** Rows from before rejections carried a code: the owner's words. New rows use `rejectReason`. */
    dismissReason: v.optional(v.string()),
    /** The quick reason the owner picked when rejecting it, if one. */
    rejectCode: v.optional(rejectCodeValidator),
    /** The owner's typed reason for rejecting it, if any (cleaned, 200 characters). */
    rejectReason: v.optional(v.string()),
    /**
     * Decided by the owner through `proposal_decide`: `owner`, via the chief of
     * staff. Absent when the owner clicked in the app, or when it was
     * auto-approved, expired or withdrawn.
     */
    decidedBy: v.optional(v.literal("owner")),
    decidedVia: v.optional(v.literal("chief_of_staff")),
    /**
     * The owner's words for an approval made through `proposal_decide`
     * (cleaned, 200 characters). A dismissal's words stay `rejectReason`.
     */
    decisionReason: v.optional(v.string()),
    /** How soon it wants the owner (the proposer's; `normal` where absent, as on every row from before). */
    urgency: v.optional(urgencyValidator),
    /** The goal it serves: one of that company's (or both companies'), checked when proposed. */
    goalId: v.optional(v.id("goals")),
    /** Its evidence, checked to exist when proposed. */
    source: v.optional(proposalSourceValidator),
    /** What the owner changed before approving, field by field (empty or absent: approved as proposed). */
    edits: v.optional(v.array(proposalEditValidator)),
    /** What approving it made or changed. */
    result: v.optional(
      v.union(
        v.object({ taskId: v.id("tasks") }),
        v.object({ dealId: v.id("deals") }),
        v.object({ kept: v.literal(true) }),
        v.object({ decisionId: v.id("decisions") }),
        v.object({ goalId: v.id("goals") }),
        v.object({ botId: v.id("bots") }),
        v.object({ noteId: v.id("memoryNotes") }),
        v.object({ commentId: v.id("comments") }),
        v.object({ handoffId: v.id("handoffs") }),
      ),
    ),
    editedBeforeApprove: v.boolean(),
    /**
     * Made with `force` past a near-duplicate check (convex/lib/duplicates.ts):
     * the ids of the open items it was near, and the proposer's reason it
     * differs (cleaned, 200 characters, rendered as text).
     */
    duplicateOf: v.optional(v.array(v.string())),
    forceReason: v.optional(v.string()),
    /**
     * Withdrawn by its proposer (`proposal_withdraw`, spec §14): why (a closed
     * set), its note (cleaned, 300 characters, no contact detail), the proposal
     * that replaces it (the proposer's own, same company), when, and who:
     * `bot:<id>` for a bot, one of the four by its id, `owner` for the owner's
     * own client. `decidedAt` is set too, so it is kept and read as decided.
     */
    withdrawReason: v.optional(withdrawReasonValidator),
    withdrawNote: v.optional(v.string()),
    replacedBy: v.optional(v.id("proposals")),
    withdrawnAt: v.optional(v.number()),
    withdrawnBy: v.optional(v.string()),
  })
    .index("by_company_and_status", ["company", "status", "createdAt"])
    .index("by_dedupeKey_and_bot_and_createdAt", ["dedupeKey", "bot", "createdAt"])
    .index("by_status_and_createdAt", ["status", "createdAt"])
    .index("by_agent_and_status_and_bot", ["agent", "status", "bot"])
    .index("by_bot_and_status", ["bot", "status"])
    .index("by_bot_and_createdAt", ["bot", "createdAt"])
    .index("by_createdAt", ["createdAt"])
    .index("by_decidedAt", ["decidedAt"]),

  // One row a proposal a sweep withdrew (`proposal_sweep`): who swept it, which
  // newer proposal it kept, and why. Ids and a closed reason only: no title,
  // payload or name. `sweeper` is `bot:<id>`, or one of the four by its id.
  proposalSweeps: defineTable({
    sweeper: v.string(),
    proposalId: v.id("proposals"),
    keptId: v.id("proposals"),
    reason: v.union(v.literal("duplicate"), v.literal("superseded")),
    at: v.number(),
  }).index("by_at", ["at"]),

  // Earned autonomy (convex/lib/trust.ts): how far the owner trusts a
  // proposer (one of the four, or a bot's profile id) with one kind. Counts,
  // times and the last edit made before approving; written only by the
  // owner's approve / dismiss path and a flag.
  botTrust: defineTable({
    proposer: v.string(),
    kind: proposalKindValidator,
    /** Clean approvals (no edit) in a row. */
    streak: v.number(),
    approved: v.number(),
    edited: v.number(),
    dismissed: v.number(),
    autoApproved: v.number(),
    /** The streak at which the offer is made: 10, or 10 more after "Not yet". */
    offerAt: v.number(),
    lastResetAt: v.optional(v.number()),
    /**
     * The proposal whose edit before approving last started the streak again:
     * what was changed is that proposal's own `edits` (one place, which
     * `proposals_feedback` returns), never copied here.
     */
    lastEditedProposal: v.optional(v.id("proposals")),
    updatedAt: v.number(),
  }).index("by_proposer_and_kind", ["proposer", "kind"]),

  // The owner's yes to an offer: (proposer, kind) approved without his click
  // while `revokedAt` is unset. Eligibility is checked again at every use.
  autonomyGrants: defineTable({
    userId: v.id("users"),
    proposer: v.string(),
    kind: proposalKindValidator,
    grantedAt: v.number(),
    revokedAt: v.optional(v.number()),
    revokedBy: v.optional(v.union(v.literal("owner"), v.literal("flag"))),
    flaggedProposal: v.optional(v.id("proposals")),
  })
    .index("by_proposer_and_kind_and_revokedAt", ["proposer", "kind", "revokedAt"])
    .index("by_revokedAt", ["revokedAt"]),

  // What the owner asked on /assistant, and the answer an agent wrote at its
  // next run (convex/lib/questions.ts). The answer is a model's: cleaned,
  // bounded, rendered as text.
  questions: defineTable({
    company: companyValidator,
    text: v.string(),
    askedAt: v.number(),
    answer: v.optional(v.string()),
    answeredAt: v.optional(v.number()),
    agent: v.optional(agentValidator),
  })
    .index("by_company_and_askedAt", ["company", "askedAt"])
    .index("by_askedAt", ["askedAt"])
    .index("by_answeredAt", ["answeredAt"]),

  // The owner's live chat on /assistant (convex/lib/chat.ts): a conversation
  // and its messages. A question is the owner's typed text; an answer is
  // written by Claude Code on the owner's Mac, through the runner tools of
  // POST /mcp/v1: cleaned, bounded, rendered as text. No model runs here.
  chatThreads: defineTable({
    company: companyValidator,
    /** The first question's opening words, or what the owner renamed it. */
    title: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_updatedAt", ["updatedAt"]),

  chatMessages: defineTable({
    threadId: v.id("chatThreads"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    text: v.string(),
    /** A question is "done" from the start; an answer goes queued, working, then done or failed. */
    status: chatStatusValidator,
    /** Tool names only (`CHAT_TOOLS`, convex/lib/chatRules.ts): never an argument or a result. */
    steps: v.array(v.string()),
    /** Proposals made while answering, shown as cards under the answer. */
    proposalIds: v.array(v.id("proposals")),
    /** Why it failed: a key of `CHAT_FAILURES`, whose sentence is fixed words. */
    failure: v.optional(chatFailureValidator),
    askedAt: v.number(),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    /** The runner answering it: an id the runner made up for its own process. */
    claimedBy: v.optional(v.string()),
    claimExpiresAt: v.optional(v.number()),
    /** How many times it was claimed. */
    claims: v.optional(v.number()),
  })
    .index("by_threadId", ["threadId"])
    .index("by_threadId_and_status", ["threadId", "status"])
    .index("by_status_and_askedAt", ["status", "askedAt"])
    .index("by_role_and_askedAt", ["role", "askedAt"]),

  // When the chat's runner on the owner's Mac last checked in, and how often
  // it says it does. One row at most: a time and an interval, nothing else.
  chatRunner: defineTable({ checkedInAt: v.number(), everyMs: v.number() }),

  // One row: which work tools are switched off, and the owner's domain lists.
  workToolSettings: defineTable({
    off: v.array(mirrorSourceValidator),
    investorDomains: v.array(v.string()),
    customerDomains: v.array(v.string()),
  }),

  // A "Connect Google" attempt in progress: single use, ten minutes.
  // `userId` is who started it: the grant that comes back must be for the
  // Google account that user signs in with. (Optional only so that an attempt
  // stored before this field existed still reads; one without it is refused.)
  oauthStates: defineTable({
    state: v.string(),
    verifier: v.string(),
    expiresAt: v.number(),
    userId: v.optional(v.id("users")),
  })
    .index("by_state", ["state"])
    .index("by_expiresAt", ["expiresAt"]),

  // The Google grant. `sealedRefreshToken` is ciphertext (convex/lib/tokenCrypto.ts).
  // Read only by google.sealedToken (internal). Never returned by a public function.
  oauthConnections: defineTable({
    provider: v.literal("google"),
    sealedRefreshToken: v.string(),
    connectedAt: v.number(),
  }).index("by_provider", ["provider"]),

  // ── Payroll ──────────────────────────────────────────────────────────────

  // Salaries are sensitive personal data. These three tables are read and
  // written only by convex/payroll.ts, every function of which is the
  // owner's alone; nothing in them goes to a log, an error, a snapshot or a
  // query a teammate can call. Money is a whole number of the currency's
  // minor unit (cents, tiyn); a rate is a whole number of basis points.

  // The people a company pays. One is never deleted while a saved month
  // holds them: they are ended (`endDate`) or archived.
  payrollPeople: defineTable({
    company: companyValidator,
    name: v.string(),
    title: v.optional(v.string()),
    kind: payrollKindValidator,
    // Pay is entered as net or as gross, and only the matching figure is
    // stored. No `payBasis` means gross: everyone from before there was a choice.
    payBasis: v.optional(payBasisValidator),
    monthlyGross: v.optional(v.number()),
    monthlyNet: v.optional(v.number()),
    currency: payrollCurrencyValidator,
    startDate: v.optional(v.string()),
    endDate: v.optional(v.string()),
    notes: v.optional(v.string()),
    /**
     * The owner's estimate of their time serving customers and on sales and
     * marketing, whole percents that add to 100 at most; absent is 0. Unit
     * economics counts that share of their total cost in COGS and in CAC
     * (`timeSharesProblem` in convex/lib/payroll.ts).
     */
    cogsPercent: v.optional(v.number()),
    salesPercent: v.optional(v.number()),
    order: v.number(),
    archivedAt: v.optional(v.number()),
    /** When last edited or archived; never changed, only `_creationTime`. The page's "last change". */
    updatedAt: v.optional(v.number()),
  }).index("by_company", ["company"]),

  // A company's tax and contribution lines, each for one kind of person. The
  // rate is the owner's: a line with no `rateBp` is "rate not set" and is not
  // computed. Its base is gross, less the amounts of `lessLineIds`, less
  // `allowance`, never below zero, held to `baseCap`.
  payrollLines: defineTable({
    company: companyValidator,
    appliesTo: payrollKindValidator,
    name: v.string(),
    paidBy: payerValidator,
    rateBp: v.optional(v.number()),
    lessLineIds: v.array(v.id("payrollLines")),
    allowance: v.number(),
    baseCap: v.optional(v.number()),
    order: v.number(),
    active: v.boolean(),
    /** When last edited or reordered; never changed, only `_creationTime`. The page's "last change". */
    updatedAt: v.optional(v.number()),
  }).index("by_company", ["company"]),

  // One saved month per company, keyed by the month's first day. `rows` are
  // copies. A paid month's are the frozen record, read-only until it is
  // reopened. A draft's are not shown (the page works a month that is not
  // paid out live): a draft holds the month's adjustments, and is saved again
  // whenever one is set.
  payrollRuns: defineTable({
    company: companyValidator,
    month: v.string(),
    status: payrollRunStatusValidator,
    paidOn: v.optional(v.string()),
    preparedAt: v.number(),
    rows: v.array(payrollRowValidator),
  }).index("by_company_and_month", ["company", "month"]),

  // ── Costs (convex/costs.ts) ──────────────────────────────────────────────

  // What a company pays for besides pay: one row per cost line. Read and
  // written only by convex/costs.ts, every function of which is the `costs`
  // area's and one company's. Money is a whole number of the currency's minor
  // unit; a month is "YYYY-MM". No file, no bank detail, no card number: a
  // name, a note or "paid by" that looks like one is refused.
  costs: defineTable({
    company: companyValidator,
    /** The vendor or the thing: "AWS", "Office rent". */
    name: v.string(),
    category: costCategoryValidator,
    /** Per cadence: a yearly line's amount is the year's. */
    amount: v.number(),
    currency: payrollCurrencyValidator,
    cadence: costCadenceValidator,
    startsOn: v.string(),
    /** Inclusive. A one-off has none: its month is `startsOn`. */
    endsOn: v.optional(v.string()),
    /** An estimate that changes month to month, shown with "≈". */
    variable: v.boolean(),
    /**
     * What it counts as in unit economics, when the owner chose. Absent is
     * the category's default (`defaultBucket`: cloud → COGS, marketing →
     * sales and marketing, the rest → running the company).
     */
    bucket: v.optional(costBucketValidator),
    paidBy: v.optional(v.string()),
    note: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    archivedAt: v.optional(v.number()),
  }).index("by_company", ["company"]),

  // ── Budget and runway (convex/budget.ts, convex/scenarios.ts; finance) ─────

  // One planned amount a company, month ("YYYY-MM") and category, in the
  // company's own currency's minor units. No row is "nothing planned", never 0.
  budgets: defineTable({
    company: companyValidator,
    month: v.string(),
    category: budgetCategoryValidator,
    amount: v.number(),
    currency: payrollCurrencyValidator,
    updatedAt: v.number(),
  }).index("by_company_and_month_and_category", ["company", "month", "category"]),

  // What Globex actually spent in a month, typed in (Startup's comes from
  // Mercury's aggregates). No row is "not known yet".
  budgetActuals: defineTable({
    company: companyValidator,
    month: v.string(),
    amount: v.number(),
    currency: payrollCurrencyValidator,
    updatedAt: v.number(),
  }).index("by_company_and_month", ["company", "month"]),

  // A "what if": a name and dated changes. At most ten a company.
  scenarios: defineTable({
    company: companyValidator,
    name: v.string(),
    changes: v.array(scenarioChangeValidator),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_company", ["company"]),

  // ── Telegram notifications (convex/telegram.ts) ─────────────────────────────

  // One row: where the bot posts and how its last tries went. The bot's token
  // is not here or in any table: it is the TELEGRAM_BOT_TOKEN variable. A
  // group's id is an identifier, not a secret. Every `…Error` is one of the
  // fixed sentences in convex/lib/telegramMessage.ts, never anything a request
  // threw or Telegram said.
  telegramSettings: defineTable({
    enabled: v.boolean(),
    /** Startup's group, and where a shared task's message goes when it is set. */
    chatUs: v.optional(telegramChatValidator),
    /** Globex's group. */
    chatKz: v.optional(telegramChatValidator),
    /**
     * An owner's own Telegram username, by their user row: an owner has no
     * `members` row to hold it, and no address is stored here.
     */
    owners: v.optional(
      v.array(
        v.object({
          userId: v.id("users"),
          telegram: v.string(),
          /** As `members.telegramUserId`: whoever first used the username in a picked group. */
          telegramUserId: v.optional(v.string()),
          telegramBoundAt: v.optional(v.number()),
        }),
      ),
    ),
    /**
     * The last twenty times a username was linked to a Telegram account, or a
     * link was reset: which, whose record (by id) and when. For the owner, so
     * that a wrong link is seen. Never a username, a name or a Telegram id.
     */
    log: v.optional(
      v.array(
        v.object({
          event: v.union(v.literal("linked"), v.literal("reset")),
          at: v.number(),
          member: v.optional(v.id("members")),
          owner: v.optional(v.id("users")),
        }),
      ),
    ),
    /**
     * The groups the bot was seen in by someone with a username on record,
     * newest first, twenty at most. A stranger's group is never listed.
     */
    found: v.optional(
      v.array(
        v.object({
          id: v.string(),
          title: v.string(),
          type: v.union(v.literal("group"), v.literal("supergroup")),
          members: v.optional(v.number()),
        }),
      ),
    ),
    /** When "Find my groups" was last started, while it has not finished. */
    findingSince: v.optional(v.number()),
    foundAt: v.optional(v.number()),
    findError: v.optional(v.string()),
    /** How the last test message went, and for which company's group. */
    test: v.optional(
      v.object({
        company: companyValidator,
        at: v.number(),
        outcome: v.union(v.literal("sending"), v.literal("sent"), v.literal("failed")),
        error: v.optional(v.string()),
      }),
    ),
    /** The bot's own username, from `getMe`: what people type to address it. */
    botUsername: v.optional(v.string()),
    /**
     * Whether the bot's updates come to this deployment's webhook, as Telegram
     * last said (`getWebhookInfo`). The webhook's address and secret are not here.
     */
    commands: v.optional(
      v.object({
        state: v.union(v.literal("on"), v.literal("off"), v.literal("elsewhere")),
        pending: v.number(),
        deliveryErrorAt: v.optional(v.number()),
        checkedAt: v.number(),
      }),
    ),
    /**
     * The owner's own word on whether tasks may be added from the group:
     * true once they turn commands on, false once they turn them off. The
     * webhook acts on nothing unless this is true, whatever Telegram goes on
     * sending: removing the webhook can fail, and one can be set again from
     * elsewhere by anyone who holds the token.
     */
    commandsWanted: v.optional(v.boolean()),
    /**
     * The last thing that went wrong while acting on an update from the
     * group: one of the fixed sentences in `COMMAND_FAILURES` and when. Never
     * what was thrown. Cleared by the next reply that is posted.
     */
    commandFailure: v.optional(v.object({ what: v.string(), at: v.number() })),
    /** When turning commands on or off, or checking, was last started, while it runs. */
    commandsWorkingSince: v.optional(v.number()),
    commandsError: v.optional(v.string()),
    /**
     * Where a task with no board hashtag goes when one group serves both
     * companies. Absent means Globex's ("kz").
     */
    untaggedBoard: v.optional(v.union(companyValidator, v.literal("both"))),
    /** When a task's message last reached a group. */
    lastSentAt: v.optional(v.number()),
    /** Why the latest try did not; cleared by the next that does. */
    lastError: v.optional(v.string()),
    lastErrorAt: v.optional(v.number()),
  }),

  // One row per message handed to Telegram in the last hour, by group: what
  // the hourly limit counts. Rows older than an hour are deleted as it counts.
  telegramSends: defineTable({ chat: v.string(), at: v.number() }).index("by_chat_and_at", [
    "chat",
    "at",
  ]),

  // What the webhook remembers, and for 48 hours only: the ids of updates it
  // acted on (so one delivered twice adds one task), and one row per task
  // added and per reply sent, for the limits. A group's id, a number as text
  // and a time: never a name, a username, a title or a message.
  telegramInbox: defineTable({
    kind: v.union(
      v.literal("update"),
      v.literal("task"),
      v.literal("reply"),
      v.literal("refusal"),
      v.literal("limit"),
    ),
    chat: v.string(),
    /** An update's id for `update`; empty otherwise. */
    ref: v.string(),
    at: v.number(),
  })
    .index("by_kind_and_ref", ["kind", "ref"])
    .index("by_kind_and_chat_and_at", ["kind", "chat", "at"])
    .index("by_kind_and_at", ["kind", "at"]),

  // ── The projects' agents (convex/agentControl.ts, convex/agentProjects.ts;
  // the `agents` area) ──────────────────────────────────────────────────────
  // Each project's AI agents, watched and steered. The agents run inside the
  // project; no patient data reaches the OS: usage is daily totals of ids and
  // numbers, a provider row is a state and a time, and what goes back is
  // configuration. Not split by company.
  //
  // `project` is a project's slug. Rows from before projects (the
  // `vertical_agents` source alone) have none and are Vertical Startup's
  // (`LEGACY_PROJECT`): `agentProjects.adoptLegacy` stamps them, and each
  // legacy push stamps a batch more.

  // A project connected to the OS: its token's SHA-256 (never the token),
  // whether it holds patient data (which fixes its fail mode and the
  // providers it may use), and its call window (like the owner's agent's).
  agentProjects: defineTable({
    slug: v.string(),
    name: v.string(),
    region: v.union(...REGIONS.map((region) => v.literal(region))),
    holdsPatientData: v.boolean(),
    allowedProviders: v.array(v.string()),
    status: v.union(...PROJECT_STATUSES.map((status) => v.literal(status))),
    tokenHash: v.optional(v.string()),
    tokenCreatedAt: v.optional(v.number()),
    /** The last call it made with its token, either route. */
    lastSeenAt: v.optional(v.number()),
    /** The last usage report it sent (or legacy push). */
    lastUsageAt: v.optional(v.number()),
    createdAt: v.number(),
    /** Absent for the legacy project, made by Vertical Startup's first push. */
    createdBy: v.optional(v.id("users")),
    windowStart: v.optional(v.number()),
    calls: v.optional(v.number()),
    /** v1.3: the key of the tool catalogue last stored (`agentTools`): an unchanged one is not rewritten. */
    toolsKey: v.optional(v.string()),
  })
    .index("by_slug", ["slug"])
    .index("by_tokenHash", ["tokenHash"]),

  // The agents a project says it can run (`agentsKnown` in its usage report):
  // one row per project and agent, its name, whether it handles patient data
  // and whether it is code or declarative. What "Launch agent" picks from.
  agentCatalog: defineTable({
    project: v.string(),
    agentId: v.string(),
    name: v.string(),
    phi: v.boolean(),
    kind: v.union(...AGENT_KINDS.map((kind) => v.literal(kind))),
    firstReportedAt: v.number(),
    lastReportedAt: v.number(),
    /** The key of the harness defaults last stored for it (`agentHarnessDefaults`): an unchanged one is not rewritten. */
    harnessKey: v.optional(v.string()),
  }).index("by_project_and_agentId", ["project", "agentId"]),

  // One row per (project, agent, prompt version, provider, model, UTC day),
  // overwritten by each push that carries it. Absent cost or timings are
  // "not known", never zero. `product` is the legacy source's ("vertical_startup").
  agentUsage: defineTable({
    project: v.optional(v.string()),
    product: v.optional(v.string()),
    agentId: v.string(),
    promptVersion: v.string(),
    provider: v.string(),
    model: v.string(),
    day: v.string(),
    calls: v.number(),
    errors: v.number(),
    schemaFailures: v.number(),
    fallbacks: v.number(),
    refusals: v.number(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    costUsd: v.optional(v.number()),
    p50Ms: v.optional(v.number()),
    p95Ms: v.optional(v.number()),
    syncedAt: v.number(),
  })
    .index("by_project_agentId_promptVersion_provider_model_day", [
      "project",
      "agentId",
      "promptVersion",
      "provider",
      "model",
      "day",
    ])
    .index("by_day", ["day"])
    .index("by_project_and_day", ["project", "day"])
    .index("by_project_agentId_and_day", ["project", "agentId", "day"]),

  // Each project's providers and models, their latest health as the project
  // checked it: one row per (project, provider, model), replaced only by a
  // newer check.
  agentProviders: defineTable({
    project: v.optional(v.string()),
    provider: v.string(),
    model: v.string(),
    state: v.union(...PROVIDER_STATES.map((state) => v.literal(state))),
    checkedAt: v.number(),
    lastErrorClass: v.optional(v.union(...ERROR_CLASSES.map((kind) => v.literal(kind)))),
    syncedAt: v.number(),
  }).index("by_project_provider_and_model", ["project", "provider", "model"]),

  // An agent's desired state, one row per (project, agent) launched or
  // changed here. An agent with none runs as its project set it and is not in
  // what is sent.
  agentControls: defineTable({
    project: v.optional(v.string()),
    agentId: v.string(),
    /** What it is called here, set when it was launched. */
    name: v.optional(v.string()),
    enabled: v.boolean(),
    provider: v.string(),
    model: v.string(),
    fallbackProvider: v.optional(v.string()),
    fallbackModel: v.optional(v.string()),
    monthlyBudgetUsd: v.optional(v.number()),
    promptVersionPin: v.optional(v.string()),
    /** The published harness version it runs ("h7"); none: the code's own harness. */
    harnessVersion: v.optional(v.string()),
    /** One of Startup OS's own four (convex/lib/osAgents.ts): where it runs. None: the Mac, for those four. */
    runsOn: v.optional(runsOnValidator),
    /** The config version this state was last changed in. */
    version: v.number(),
    updatedAt: v.number(),
    updatedBy: v.id("users"),
  }).index("by_project_and_agentId", ["project", "agentId"]),

  // Every change made here: who, when, before and after, how it reached the
  // project (`pull`: the project fetches it; otherwise the legacy push's
  // outcome) and the version it is in. Whether it is applied is worked out
  // at read from the project's `agentConfig.appliedVersion`. Nothing changes
  // a row but its push.
  agentControlChanges: defineTable({
    project: v.optional(v.string()),
    version: v.number(),
    agentId: v.string(),
    by: v.id("users"),
    at: v.number(),
    /** null: the agent was not steered before (it ran as its project set it, or was launched here). */
    before: v.union(agentDesiredValidator, v.null()),
    after: agentDesiredValidator,
    /** Present on the change that launched the agent from the OS. */
    launched: v.optional(v.boolean()),
    push: pushOutcomeValidator,
    pushedAt: v.optional(v.number()),
    failure: v.optional(pushFailureValidator),
  })
    .index("by_at", ["at"])
    .index("by_project_and_at", ["project", "at"])
    .index("by_project_agentId_and_at", ["project", "agentId", "at"])
    .index("by_project_and_version", ["project", "version"])
    .index("by_project_push_and_version", ["project", "push", "version"]),

  // One row per project: the latest config version made here, the latest the
  // project applied (from its report, or from the answer to the legacy
  // push), and the newest it said it held when it called ours stale.
  agentConfig: defineTable({
    project: v.optional(v.string()),
    latestVersion: v.number(),
    appliedVersion: v.optional(v.number()),
    appliedAt: v.optional(v.number()),
    remoteVersion: v.optional(v.number()),
  }).index("by_project", ["project"]),

  // ── Harnesses (convex/agentHarness.ts, convex/lib/agentHarness.ts,
  // convex/lib/agentJobs.ts; Protocol v1.1) ─────────────────────────────────
  // An agent's prompt templates, model parameters, tools and output schema:
  // the code's defaults, versions that replace parts of them (draft → test →
  // publish, every one kept), made-up test cases, and test runs the project
  // leases and answers. A prompt is a template and a case is made-up data:
  // no patient's.

  // The code's defaults, as its project last reported them: one row per
  // (project, agent), replaced only when they change.
  agentHarnessDefaults: defineTable({
    project: v.string(),
    agentId: v.string(),
    harness: harnessDefaultsValidator,
    reportedAt: v.number(),
  }).index("by_project_and_agentId", ["project", "agentId"]),

  // Every version of an agent's harness: h1, h2… It holds only the parts it
  // changes. One draft and one published at a time; a draft's `revision`
  // goes up with each save, so a test run is of one revision.
  agentHarnessVersions: defineTable({
    project: v.string(),
    agentId: v.string(),
    number: v.number(),
    status: v.union(v.literal("draft"), v.literal("published"), v.literal("archived")),
    revision: v.number(),
    ...harnessPartsFields,
    /** The version it was started from; none: the code's defaults. */
    basedOn: v.optional(v.number()),
    /** v1.3: a declarative agent's definition (an agent built here); none for a code agent's version. */
    definition: v.optional(definitionValidator),
    note: v.string(),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedBy: v.id("users"),
    updatedAt: v.number(),
    /** The last time it was published (a rollback publishes it again). */
    publishedBy: v.optional(v.id("users")),
    publishedAt: v.optional(v.number()),
  })
    .index("by_project_agentId_and_number", ["project", "agentId", "number"])
    .index("by_project_agentId_and_status", ["project", "agentId", "status"]),

  // A version's prompt (v1.2): every variant, kept apart from the version so
  // a list of versions reads none of them. A v1.1 version keeps its prompt
  // inline instead.
  agentHarnessPrompts: defineTable({
    versionId: v.id("agentHarnessVersions"),
    variants: variantsValidator,
  }).index("by_versionId", ["versionId"]),

  // Each publish and rollback: who, when, the config version it went out in,
  // and the owner's override of the test gate with its reason.
  agentHarnessEvents: defineTable({
    project: v.string(),
    agentId: v.string(),
    number: v.number(),
    action: v.union(v.literal("publish"), v.literal("rollback")),
    by: v.id("users"),
    at: v.number(),
    configVersion: v.number(),
    override: v.optional(v.object({ reason: v.string() })),
  }).index("by_project_agentId_and_at", ["project", "agentId", "at"]),

  // An agent's test cases. Made-up data only: each save is ticked as such.
  agentHarnessCases: defineTable({
    project: v.string(),
    agentId: v.string(),
    name: v.string(),
    variables: v.record(v.string(), v.string()),
    /** JSON text: tool id to what the tool returns in the test. */
    toolFixtures: v.optional(v.string()),
    expect: v.array(assertionValidator),
    /** v1.2: the prompt variant it runs; none, `default`. */
    variant: v.optional(v.string()),
    /** v1.2: its conversation, for an agent that sends its own. */
    messages: v.optional(caseMessagesValidator),
    /** v1.3: JSON text, answers for each sub-agent's own tools, by its tool id (an agent built here). */
    subAgentFixtures: v.optional(v.string()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedBy: v.id("users"),
    updatedAt: v.number(),
    /** When it was last ticked as made-up data. */
    madeUpAt: v.number(),
  }).index("by_project_and_agentId", ["project", "agentId"]),

  // A test run: one draft revision on chosen models against chosen cases, a
  // job its project polls for (GET /agents/v1/jobs), leases and answers
  // (POST /agents/v1/jobs/{id}/results). The harness is kept as sent.
  agentHarnessRuns: defineTable({
    project: v.string(),
    agentId: v.string(),
    versionId: v.id("agentHarnessVersions"),
    number: v.number(),
    revision: v.number(),
    /**
     * JSON text: the harness as the job carries it. v1.1 runs only; newer
     * runs keep it in `agentHarnessRunPayloads`, so a list of runs reads none.
     */
    harness: v.optional(v.string()),
    /** The tools the job switches on (v1.2): what a result may say it skipped. */
    tools: v.optional(v.array(v.string())),
    models: v.array(v.object({ provider: v.string(), model: v.string() })),
    status: v.union(...RUN_STATUSES.map((status) => v.literal(status))),
    leaseUntil: v.optional(v.number()),
    leases: v.number(),
    /** Counted as results arrive: cases × models, results received, results passed. */
    expected: v.number(),
    received: v.number(),
    passed: v.number(),
    createdBy: v.id("users"),
    createdAt: v.number(),
    finishedAt: v.optional(v.number()),
  })
    .index("by_project_and_status", ["project", "status"])
    .index("by_project_agentId_and_createdAt", ["project", "agentId", "createdAt"])
    .index("by_versionId_and_createdAt", ["versionId", "createdAt"]),

  // A run's harness as its job carries it (JSON text, up to 512 KB), read
  // only when the job is handed out.
  agentHarnessRunPayloads: defineTable({
    run: v.id("agentHarnessRuns"),
    harness: v.string(),
    /** v1.3: JSON text, a declarative agent's draft definition and its published sub-agents, as the job carries them. */
    definition: v.optional(v.string()),
  }).index("by_run", ["run"]),

  // Each case of a run, as it was when the run was made.
  agentHarnessRunCases: defineTable({
    run: v.id("agentHarnessRuns"),
    caseId: v.string(),
    name: v.string(),
    variables: v.record(v.string(), v.string()),
    toolFixtures: v.optional(v.string()),
    expect: v.array(assertionValidator),
    variant: v.optional(v.string()),
    messages: v.optional(caseMessagesValidator),
    subAgentFixtures: v.optional(v.string()),
    position: v.number(),
  }).index("by_run_and_caseId", ["run", "caseId"]),

  // One case on one model, as the project sent it back. `output` is the
  // model's answer to made-up data, as JSON text; none where it gave none.
  agentHarnessResults: defineTable({
    run: v.id("agentHarnessRuns"),
    caseId: v.string(),
    provider: v.string(),
    model: v.string(),
    output: v.optional(v.string()),
    schemaValid: v.boolean(),
    assertions: v.array(v.object({ index: v.number(), passed: v.boolean() })),
    passed: v.boolean(),
    latencyMs: v.number(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    costUsd: v.optional(v.number()),
    error: v.optional(v.union(...RESULT_ERRORS.map((error) => v.literal(error)))),
    /** v1.2: the tools built into the provider that the test run skipped. */
    skippedTools: v.optional(v.array(v.string())),
    /** v1.3, an agent built here: its model turns, and its tool calls in order. */
    steps: v.optional(v.number()),
    toolCalls: v.optional(
      v.array(v.object({ toolId: v.string(), status: v.union(v.literal("ok"), v.literal("error"), v.literal("skipped")) })),
    ),
  }).index("by_run_caseId_provider_and_model", ["run", "caseId", "provider", "model"]),

  // ── Agents built here (convex/agentBuilder.ts, convex/lib/agentBuilder.ts;
  // Protocol v1.3) ────────────────────────────────────────────────────────────
  // A declarative agent is defined here and run by its project's package (or,
  // in a follow-up, by Startup OS itself: the project `startup-os`). Its
  // definition rides on its harness versions; these tables hold what else
  // there is: that it was built here, the tools its project can execute, and
  // its runs as summaries (ids, states and numbers: no text).

  // One row per agent built here: it marks the agent "Built here".
  agentDeclared: defineTable({
    project: v.string(),
    agentId: v.string(),
    createdBy: v.id("users"),
    createdAt: v.number(),
  }).index("by_project_and_agentId", ["project", "agentId"]),

  // The tools a project can execute (`toolsCatalog` in its usage report): one
  // row per project and tool, replaced as a whole when the catalogue changes.
  agentTools: defineTable({
    project: v.string(),
    toolId: v.string(),
    name: v.string(),
    description: v.string(),
    phi: v.boolean(),
    kind: v.union(v.literal("function"), v.literal("provider")),
    effect: v.union(...TOOL_EFFECTS.map((effect) => v.literal(effect))),
    approvable: v.boolean(),
    /** JSON text: a schema's `$` keys cannot be field names here. */
    inputSchema: v.string(),
    firstReportedAt: v.number(),
    lastReportedAt: v.number(),
  }).index("by_project_and_toolId", ["project", "toolId"]),

  // Each run of a project's agents, as its summary (`runs` in its usage
  // report): upserted by its id, kept ninety days from when it started.
  agentRuns: defineTable({
    project: v.string(),
    runId: v.string(),
    agentId: v.string(),
    version: v.string(),
    trigger: v.union(...RUN_TRIGGERS.map((trigger) => v.literal(trigger))),
    parentRunId: v.optional(v.string()),
    status: v.union(...AGENT_RUN_STATUSES.map((status) => v.literal(status))),
    startedAt: v.number(),
    durationMs: v.number(),
    steps: v.number(),
    /** Absent: not priced, never $0. */
    costUsd: v.optional(v.number()),
    errorClass: v.optional(v.string()),
    toolCalls: v.array(runToolCallValidator),
    /** Its tool calls waiting on a human. */
    pendingApprovals: v.number(),
    /** Run by the runner on the owner's Mac (one of Startup OS's own four, through Claude). None: where its project or Startup OS ran it. */
    runner: v.optional(v.literal("mac")),
    receivedAt: v.number(),
  })
    .index("by_project_and_runId", ["project", "runId"])
    .index("by_project_agentId_and_startedAt", ["project", "agentId", "startedAt"])
    .index("by_project_agentId_and_status", ["project", "agentId", "status"])
    .index("by_project_and_parentRunId", ["project", "parentRunId"])
    .index("by_startedAt", ["startedAt"]),

  // ── Agents Startup OS runs itself (convex/agentRuntime.ts, convex/lib/agentRuntime.ts) ──
  // The agents built for the project `startup-os` run here, on Gemini (or the
  // Astana GPU), by the owner's decision of 2026-10-17. Each run's summary
  // goes into `agentRuns` and its day into `agentUsage`, as a project's push
  // would put them; these tables hold what else a run here has.

  // One row per run Startup OS started (a sub-agent's runs are in its caller's):
  // what started it, as whom its tools run, its input, and while it waits for
  // the owner, its whole state to resume from. Never sent to a browser.
  agentRuntimeRuns: defineTable({
    project: v.string(),
    runId: v.string(),
    agentId: v.string(),
    versionNumber: v.number(),
    trigger: v.union(v.literal("api"), v.literal("schedule")),
    state: v.union(v.literal("queued"), v.literal("running"), v.literal("awaiting_approval"), v.literal("done")),
    /** The owner whose `Member` its tools run as. */
    actAs: v.id("users"),
    /** Who pressed Run now; none for a schedule. */
    startedBy: v.optional(v.id("users")),
    /**
     * Run by the runner on the owner's Mac (one of the four, through Claude:
     * convex/lib/osAgentRuns.ts), not here: no action runs it, and the state
     * is "running" from when the Mac took it until it finishes or is ended.
     */
    runner: v.optional(v.literal("mac")),
    /** A scheduled run: the minute it was due (ms, UTC), so a minute runs once. */
    scheduledFor: v.optional(v.number()),
    /** JSON text: the variables, or a conversation agent's message. */
    input: v.string(),
    /** JSON text: the run's state while it waits for the owner (at most 512 KB). */
    resume: v.optional(v.string()),
    createdAt: v.number(),
    /** When it last started running (a start, or a resume): a run stuck past its limit is ended. */
    claimedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
  })
    .index("by_runId", ["runId"])
    .index("by_project_agentId_and_scheduledFor", ["project", "agentId", "scheduledFor"])
    .index("by_project_agentId_and_state", ["project", "agentId", "state"])
    .index("by_state_and_createdAt", ["state", "createdAt"])
    .index("by_createdAt", ["createdAt"]),

  // A tool call waiting for the owner's click: the tool and its arguments
  // (JSON text, at most 16 KB). The owner's alone to read and to decide.
  agentApprovals: defineTable({
    project: v.string(),
    /** The agent whose run started it all, and the run that waits on the owner. */
    rootAgentId: v.string(),
    rootRunId: v.string(),
    agentId: v.string(),
    runId: v.string(),
    toolId: v.string(),
    arguments: v.string(),
    state: v.union(v.literal("pending"), v.literal("approved"), v.literal("denied")),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
    decidedBy: v.optional(v.id("users")),
    /** The owner's reason for a denial, typed on /approvals: cleaned, at most 200 characters, shown as text. */
    denyReason: v.optional(v.string()),
    /** When the approved call ran: an approval lets one call run, once. */
    usedAt: v.optional(v.number()),
  })
    .index("by_project_rootAgentId_and_state", ["project", "rootAgentId", "state"])
    .index("by_project_agentId_and_state", ["project", "agentId", "state"])
    .index("by_rootRunId", ["rootRunId"])
    .index("by_state_and_createdAt", ["state", "createdAt"]),

  // A run's answer (text or JSON, at most 64 KB, `truncated` where cut), with
  // who may read it decided when it was kept: from the tools of the versions
  // that run and its sub-agents' runs actually used, never from what is
  // published later. Owner-only, or whoever holds every one of `areas`.
  agentRunOutputs: defineTable({
    project: v.string(),
    runId: v.string(),
    agentId: v.string(),
    format: v.union(v.literal("text"), v.literal("json")),
    text: v.string(),
    truncated: v.boolean(),
    /** A tool of an owner-only page was used: the owner's alone. */
    ownerOnly: v.boolean(),
    /** The pages its tools read, however deep: a reader holds every one. */
    areas: v.array(v.string()),
    createdAt: v.number(),
  })
    .index("by_project_and_runId", ["project", "runId"])
    .index("by_project_agentId_and_ownerOnly", ["project", "agentId", "ownerOnly"])
    .index("by_createdAt", ["createdAt"]),

  // ── Support (Globex's Intercom inbox, convex/support.ts) ───────────────

  // One row a conversation, written only by `support.apply` from the sync's
  // read: what `supportRowValidator` holds and when it was written. Closed
  // chats not updated in 180 days are deleted by the same write.
  supportConversations: defineTable({ ...supportRowValidator.fields, syncedAt: v.number() })
    .index("by_intercomId", ["intercomId"])
    .index("by_open_and_updatedAt", ["open", "updatedAt"])
    .index("by_open_and_createdAt", ["open", "createdAt"]),

  // The Intercom workspace's id code, for links into its inbox, and when it
  // was last read well. One row.
  supportWorkspace: defineTable({ appId: v.string(), readAt: v.number() }),

  // ── Handoffs (convex/handoffs.ts) ─────────────────────────────────────────

  // One bot asking another to take over ("Research done, Growth takes over").
  // Names are the bots' own words for themselves, cleaned and bounded
  // (convex/lib/handoffs.ts); `fromKey` / `toKey` are their normalised forms,
  // which the receiving-bot check compares. Written by the bots through the
  // MCP tools and by the owner's page, never by anyone else. `history` is
  // every status change with who made it, newest last, cut to the newest 30.
  handoffs: defineTable({
    company: companyValidator,
    from: v.string(),
    fromKey: v.string(),
    /** "person": `from` is a person's lower-cased address (`fromKey` "@" and it). Absent: a bot. */
    fromKind: v.optional(v.literal("person")),
    to: v.string(),
    toKey: v.string(),
    /**
     * "person": `to` is a teammate's lower-cased address, one of that
     * company's people with the board (`toKey` "@" and it), who answers on
     * /handoffs. Absent: a bot, as on every row from before.
     */
    toKind: v.optional(v.literal("person")),
    title: v.string(),
    summary: v.string(),
    links: v.array(v.object({ kind: v.union(...HANDOFF_LINK_KINDS.map((k) => v.literal(k))), id: v.string() })),
    status: v.union(...HANDOFF_STATUSES.map((s) => v.literal(s))),
    /** Why it was declined or closed, when it was. */
    reason: v.optional(v.string()),
    /** When it last became open: made, or handed to someone else. A day of this unanswered needs the owner. */
    openSince: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    history: v.array(
      v.object({
        at: v.number(),
        by: v.string(),
        action: v.union(...HANDOFF_ACTIONS.map((a) => v.literal(a))),
        note: v.optional(v.string()),
      }),
    ),
  })
    .index("by_company_and_status", ["company", "status"])
    // A bot's handoffs to people today (the daily limit), and its finished ones since a cursor (`my_inbox`).
    .index("by_fromKey_and_toKind_and_createdAt", ["fromKey", "toKind", "createdAt"])
    .index("by_fromKey_and_status_and_updatedAt", ["fromKey", "status", "updatedAt"]),

  // A bot asks for a fix (`dev_request`, convex/devRequests.ts, convex/lib/devRequests.ts):
  // stored here, filed as a GitHub issue in your-org/your-os and read back into the
  // bot's `my_inbox`. Of the issue's comments only `decisionText` is kept, never a body.
  devRequests: defineTable({
    /** The bot's profile id (`ToolClock.bot`), never a name it sent. */
    bot: v.string(),
    /** The client it called through (`botRules.clientKey`). */
    client: v.string(),
    title: v.string(),
    problem: v.string(),
    expected: v.string(),
    /** A tool of the registry it was using, if it named one. */
    tool: v.optional(v.string()),
    /** The refusal it met, if it named one. */
    refusalCode: v.optional(v.union(...BOT_REFUSAL_CODES.map((code) => v.literal(code)))),
    status: v.union(...DEV_REQUEST_STATUSES.map((status) => v.literal(status))),
    issueNumber: v.optional(v.number()),
    prUrl: v.optional(v.string()),
    /** The bot-facing paragraph of the newest decision, cleaned (at most 1,000 characters). */
    decisionText: v.optional(v.string()),
    createdAt: v.number(),
    /** When the bot was last given something new: made, filed, or a change read back. `my_inbox` reads by it. */
    updatedAt: v.number(),
    /** When GitHub was last asked about it (or its filing began); 0 before. */
    lastCheckedAt: v.number(),
  })
    .index("by_bot_and_createdAt", ["bot", "createdAt"])
    .index("by_bot_and_updatedAt", ["bot", "updatedAt"])
    .index("by_status_and_lastCheckedAt", ["status", "lastCheckedAt"]),
});
