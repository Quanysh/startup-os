// Security questionnaires, the answer bank, vendor agreements and HIPAA / SOC 2
// / ISO 27001 evidence: the working records beside /compliance's dates. Shapes, labels and
// the pure rules (what is expiring, which evidence still counts, the per-
// framework tally). Nothing here says the company meets a standard: it counts
// what has evidence on file. Links only: no document and no secret is stored.
//
// Pure: `today` is an argument, never a clock (a query cannot read one).

import type { Id } from "../_generated/dataModel";
import type { CompanyId } from "./company";
import { daysBetween } from "./attention/dates";
import { dayLabel } from "./attention/format";
import type { AttentionItem } from "./attention/scorecard";

export const QUESTIONNAIRE_STATUSES = ["todo", "in_progress", "sent", "accepted"] as const;
export type QuestionnaireStatus = (typeof QUESTIONNAIRE_STATUSES)[number];
export const QUESTIONNAIRE_STATUS_LABELS: Record<QuestionnaireStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  sent: "Sent",
  accepted: "Accepted",
};

export const AGREEMENT_TYPES = ["baa", "dpa", "msa", "nda", "subscription"] as const;
export type AgreementType = (typeof AGREEMENT_TYPES)[number];
export const AGREEMENT_TYPE_LABELS: Record<AgreementType, string> = {
  baa: "BAA",
  dpa: "DPA",
  msa: "MSA",
  nda: "NDA",
  subscription: "Subscription terms",
};

export const AGREEMENT_STATUSES = ["draft", "out_for_signature", "active", "ended"] as const;
export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number];
export const AGREEMENT_STATUS_LABELS: Record<AgreementStatus, string> = {
  draft: "Draft",
  out_for_signature: "Out for signature",
  active: "Active",
  ended: "Ended",
};

export const EVIDENCE_FRAMEWORKS = ["hipaa", "soc2", "iso27001"] as const;
export type EvidenceFramework = (typeof EVIDENCE_FRAMEWORKS)[number];
export const FRAMEWORK_LABELS: Record<EvidenceFramework, string> = {
  hipaa: "HIPAA",
  soc2: "SOC 2",
  iso27001: "ISO 27001",
};

export const EVIDENCE_STATUSES = ["missing", "collected", "expired", "accepted"] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];
export const EVIDENCE_STATUS_LABELS: Record<EvidenceStatus, string> = {
  missing: "Missing",
  collected: "Collected",
  expired: "Expired",
  accepted: "Accepted",
};

/** How far ahead an agreement's end feeds Today's "Needs you". */
export const AGREEMENT_WINDOW_DAYS = 60;

export const MAX_CONTROL_ID_LENGTH = 40;
export const MAX_ANSWER_LENGTH = 5_000;
export const MAX_ANSWER_TAGS = 10;
export const MAX_ANSWER_TAG_LENGTH = 30;

/** Who made a change: a person's name or address, or the client/bot that wrote it. */
type Changed = { changedBy: string | null; changedAt: number };

export type QuestionnaireRow = Changed & {
  id: Id<"securityQuestionnaires">;
  requester: string;
  company: CompanyId;
  receivedOn: string | null;
  dueOn: string | null;
  status: QuestionnaireStatus;
  owner: string | null;
  link: string | null;
  notes: string | null;
};

export type AnswerRow = Changed & {
  id: Id<"answerBank">;
  question: string;
  answer: string;
  tags: string[];
  /** The company it is for; null for both. */
  company: CompanyId | null;
  lastReviewedOn: string | null;
};

export type AgreementRow = Changed & {
  id: Id<"vendorAgreements">;
  vendor: string;
  type: AgreementType;
  company: CompanyId;
  signedOn: string | null;
  expiresOn: string | null;
  status: AgreementStatus;
  link: string | null;
  notes: string | null;
};

export type EvidenceItemRow = Changed & {
  id: Id<"evidenceItems">;
  title: string;
  link: string | null;
  owner: string | null;
  collectedOn: string | null;
  validUntil: string | null;
  /** As stored. What counts is `evidenceStatus`, which also reads the date. */
  status: EvidenceStatus;
};

export type ControlRow = Changed & {
  id: Id<"complianceControls">;
  framework: EvidenceFramework;
  controlId: string;
  title: string;
  items: EvidenceItemRow[];
};

// ── Evidence ────────────────────────────────────────────────────────────────

/**
 * What an evidence item is today. Collected or accepted evidence whose
 * `validUntil` has passed is expired whatever was stored: a query cannot
 * notice the date go by, so the reader does.
 */
export function evidenceStatus(item: Pick<EvidenceItemRow, "status" | "validUntil">, today: string): EvidenceStatus {
  if (item.status === "collected" || item.status === "accepted") {
    return item.validUntil !== null && item.validUntil < today ? "expired" : item.status;
  }
  return item.status;
}

export const hasValidEvidence = (control: Pick<ControlRow, "items">, today: string): boolean =>
  control.items.some((item) => {
    const status = evidenceStatus(item, today);
    return status === "collected" || status === "accepted";
  });

export type FrameworkCoverage = { framework: EvidenceFramework; total: number; withEvidence: number };

/** Per framework: controls with valid evidence out of all controls. Both frameworks, in order, even when empty. */
export function coverageByFramework(
  controls: readonly Pick<ControlRow, "framework" | "items">[],
  today: string,
  frameworks: readonly EvidenceFramework[] = EVIDENCE_FRAMEWORKS,
): FrameworkCoverage[] {
  return frameworks.map((framework) => {
    const own = controls.filter((c) => c.framework === framework);
    return { framework, total: own.length, withEvidence: own.filter((c) => hasValidEvidence(c, today)).length };
  });
}

/** An evidence item's validity as the page reads it: days left, when a date is set and it counts. */
export function evidenceDaysLeft(item: Pick<EvidenceItemRow, "validUntil">, today: string): number | null {
  return item.validUntil === null ? null : daysBetween(today, item.validUntil);
}

// ── Agreements ──────────────────────────────────────────────────────────────

export type AgreementState = "expired" | "expiring" | "current" | "no_date" | "inactive";

/** Only an active agreement is watched: a draft has not started and an ended one needs nothing. */
export function agreementState(
  a: Pick<AgreementRow, "status" | "expiresOn">,
  today: string,
): { state: AgreementState; days: number | null } {
  if (a.status !== "active") return { state: "inactive", days: null };
  if (a.expiresOn === null) return { state: "no_date", days: null };
  const days = daysBetween(today, a.expiresOn);
  if (days < 0) return { state: "expired", days };
  return { state: days <= AGREEMENT_WINDOW_DAYS ? "expiring" : "current", days };
}

export function agreementText(a: Pick<AgreementRow, "status" | "expiresOn">, today: string, now: number): string {
  const { state, days } = agreementState(a, today);
  const date = a.expiresOn === null ? "" : dayLabel(a.expiresOn, now);
  switch (state) {
    case "inactive":
      return AGREEMENT_STATUS_LABELS[a.status];
    case "no_date":
      return "No expiry date";
    case "expired":
      return `Expired ${-days!} ${days === -1 ? "day" : "days"} ago · ${date}`;
    case "expiring":
      return days === 0 ? "Expires today" : days === 1 ? "Expires tomorrow" : `Expires in ${days} days · ${date}`;
    case "current":
      return `Expires ${date}`;
  }
}

const agreements = (n: number) => (n === 1 ? "1 vendor agreement" : `${n} vendor agreements`);

/**
 * What Today's "Needs you" says about vendor agreements: counts and dates
 * only (a vendor's name is not shown on a list others read). Active
 * agreements past their expiry, then those ending within
 * `AGREEMENT_WINDOW_DAYS`. `soonDays` can narrow the window, never widen it.
 */
export function agreementAttention(
  rows: readonly AgreementRow[],
  today: string,
  now: number,
  soonDays: number = AGREEMENT_WINDOW_DAYS,
): AttentionItem[] {
  const href = "/compliance?tab=agreements";
  const dated = rows
    .map((a) => ({ a, ...agreementState(a, today) }))
    .filter((x) => x.state === "expired" || x.state === "expiring")
    .sort((x, y) => (x.a.expiresOn! < y.a.expiresOn! ? -1 : 1));
  const expired = dated.filter((x) => x.state === "expired");
  const soon = dated.filter((x) => x.state === "expiring" && x.days! <= soonDays);
  const items: AttentionItem[] = [];
  if (expired[0]) {
    items.push({
      id: "agreements:expired",
      severity: "overdue",
      title: `${agreements(expired.length)} past the expiry date`,
      detail:
        expired.length === 1
          ? `It ended ${dayLabel(expired[0].a.expiresOn!, now)}.`
          : `The oldest ended ${dayLabel(expired[0].a.expiresOn!, now)}.`,
      href,
    });
  }
  if (soon[0]) {
    items.push({
      id: "agreements:expiring",
      severity: "due",
      title: `${agreements(soon.length)} ending in the next ${soonDays} days`,
      detail:
        soon.length === 1
          ? `It ends ${dayLabel(soon[0].a.expiresOn!, now)}.`
          : `The next ends ${dayLabel(soon[0].a.expiresOn!, now)}.`,
      href,
    });
  }
  return items;
}

// ── Questionnaires ──────────────────────────────────────────────────────────

/** Whether a questionnaire is still the company's to answer (not yet sent). */
export const questionnaireOpen = (q: Pick<QuestionnaireRow, "status">): boolean =>
  q.status === "todo" || q.status === "in_progress";
