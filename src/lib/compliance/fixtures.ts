// A made-up obligation for tests: open, undated, unconfirmed.

import type { Id } from "@convex/_generated/dataModel";
import type {
  AgreementRow,
  AnswerRow,
  ControlRow,
  EvidenceItemRow,
  QuestionnaireRow,
} from "@convex/lib/evidence";
import type { ObligationRow } from "@convex/lib/obligationShape";

let seq = 0;

export const obligation = (patch: Partial<ObligationRow> = {}): ObligationRow => ({
  id: `o${++seq}` as Id<"obligations">,
  category: "corporate_tax",
  title: `Item ${seq}`,
  due: null,
  dueConfirmed: false,
  anchorDay: null,
  recurrence: "none",
  status: "open",
  evidenceUrl: null,
  note: null,
  sourceUrl: null,
  lastDoneAt: null,
  lastDoneFor: null,
  lastEvidenceUrl: null,
  changedAt: 1,
  ...patch,
});

export const agreement = (patch: Partial<AgreementRow> = {}): AgreementRow => ({
  id: `a${++seq}` as Id<"vendorAgreements">,
  vendor: `Vendor ${seq}`,
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

export const questionnaire = (patch: Partial<QuestionnaireRow> = {}): QuestionnaireRow => ({
  id: `q${++seq}` as Id<"securityQuestionnaires">,
  requester: `Requester ${seq}`,
  company: "us",
  receivedOn: null,
  dueOn: null,
  status: "todo",
  owner: null,
  link: null,
  notes: null,
  changedBy: null,
  changedAt: 1,
  ...patch,
});

export const answer = (patch: Partial<AnswerRow> = {}): AnswerRow => ({
  id: `an${++seq}` as Id<"answerBank">,
  question: `Question ${seq}?`,
  answer: `Answer ${seq}.`,
  tags: [],
  company: null,
  lastReviewedOn: null,
  changedBy: null,
  changedAt: 1,
  ...patch,
});

export const evidenceItem = (patch: Partial<EvidenceItemRow> = {}): EvidenceItemRow => ({
  id: `e${++seq}` as Id<"evidenceItems">,
  title: `Evidence ${seq}`,
  link: null,
  owner: null,
  collectedOn: null,
  validUntil: null,
  status: "collected",
  changedBy: null,
  changedAt: 1,
  ...patch,
});

export const control = (patch: Partial<ControlRow> = {}): ControlRow => ({
  id: `c${++seq}` as Id<"complianceControls">,
  framework: "soc2",
  controlId: `CC${seq}.1`,
  title: `Control ${seq}`,
  items: [],
  changedBy: null,
  changedAt: 1,
  ...patch,
});
