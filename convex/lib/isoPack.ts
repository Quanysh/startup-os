// An ISO/IEC 27001:2022 starter pack for /compliance: recurring duties an
// information security management system (ISMS) usually commits a company
// to, a few things to set up once, and the Annex A controls with the evidence
// that would show each works. Added only when the owner asks for it
// (convex/isoPack.ts). A starting point, not anyone's ISMS: replace it with
// what your own ISMS documents say.
//
// RULES FOR THIS FILE
// - Every item should name its source: your ISMS document and section. The
//   documents themselves stay in your drive; their links are added on the
//   page, as evidence.
// - Roles only, never a person's name: the documents name who holds each role.
// - A date only where your documents or an audit fix one. Every date arrives
//   unconfirmed: the owner confirms it before it counts as due.
// - Nothing here says the company has done, holds or meets anything.

import type { ObligationCategory, Recurrence } from "./obligationShape";

export type IsoItem = {
  seedKey: string;
  category: ObligationCategory;
  title: string;
  note: string;
  due?: string;
  recurrence?: Recurrence;
};

const item = (seedKey: string, title: string, note: string, extra: Partial<IsoItem> = {}): IsoItem => ({
  seedKey: `iso-${seedKey}`,
  category: "iso27001",
  title,
  note,
  ...extra,
});

/** What an ISMS usually says must be done again and again. */
export const ISO_DUTIES: IsoItem[] = [
  item(
    "backup-integrity",
    "Backup integrity check",
    "Check that backups are whole, at least once a month. Owner: the IS officer. Proof: an entry in the backup log.",
    { recurrence: "monthly" },
  ),
  item(
    "monitoring",
    "Quarterly check that every ISMS policy is followed (access, confidential data, updates, backups)",
    "Owner: the IS officer. Proof: the monitoring log: date, what was checked, what was found, who fixes it.",
    { recurrence: "quarterly" },
  ),
  item(
    "vulnerability-check",
    "Quarterly security and patch check of systems, clouds and devices",
    "Owner: the IS officer. Proof: a dated check report with each vulnerability classed low, medium or high and its fix.",
    { recurrence: "quarterly" },
  ),
  item(
    "restore-test",
    "Restore test: bring a backup back and time it",
    "At least once a year. Owner: the IS officer. Proof: an entry in the backup log and a short protocol.",
    { recurrence: "annual" },
  ),
  item(
    "continuity-test",
    "Business continuity test: switch to the fallback plan and record how it went",
    "At least once a year. Owner: the IS officer. Proof: a test protocol.",
    { recurrence: "annual" },
  ),
  item(
    "risk-assessment",
    "Risk assessment: review every risk and date the risk register",
    "At least once a year, and again on any significant change to systems, processes, the team or the law. Owner: the IS officer. Proof: the risk register, dated, with likelihood × impact and a treatment for each risk.",
    { recurrence: "annual" },
  ),
  item(
    "policy-review",
    "Review and re-approve each ISMS policy and procedure",
    "At least once a year, or on a change of structure, technology or law. The director approves; staff acknowledge the new version.",
    { recurrence: "annual" },
  ),
  item(
    "internal-audit",
    "Internal audit of the ISMS, with a report and a corrective action plan",
    "Once a year, and after a significant change. The auditor must be independent of what is audited.",
    { recurrence: "annual" },
  ),
  item(
    "management-review",
    "Management review of the ISMS",
    "ISO 27001 clause 9.3. The director chairs. Inputs: the previous actions, the audit results, incidents, risks, changes. Every decision gets an owner and a date.",
    { recurrence: "annual" },
  ),
  item(
    "surveillance-audit",
    "Surveillance audit by the certification body",
    "Once a year for three years after certification, then a recertification audit. Confirm each date with the certification body.",
    { recurrence: "annual" },
  ),
];

/** Things to set up once. */
export const ISO_ONE_OFFS: IsoItem[] = [
  item(
    "certificate",
    "Certificate and audit reports: number, issue date, expiry, and any findings",
    "Ask the certification body for them: they fix the surveillance dates.",
  ),
  item(
    "soa",
    "Statement of Applicability: approve it, with the evidence named for each control",
    "Have staff acknowledge each new version.",
  ),
  item(
    "logs",
    "Keep the ISMS logs from today: incidents, access, changes, training, backups",
    "Start each with today's entries; never backdate. The change log can point at each release's pull request and ticket.",
  ),
  item(
    "onboarding",
    "Joiners: security induction and the policy acknowledgement before any access",
    "A.6.3. Record each in the training log.",
  ),
];

/** Findings from your audits and management reviews, each with its deadline. None in the template. */
export const ISO_FINDINGS: IsoItem[] = [];

export const ISO_ITEMS: IsoItem[] = [...ISO_DUTIES, ...ISO_ONE_OFFS, ...ISO_FINDINGS];

export type IsoControl = {
  controlId: string;
  title: string;
  /** What would show it works, as missing evidence to find. */
  evidence?: string[];
};

const c = (controlId: string, title: string, ...evidence: string[]): IsoControl =>
  evidence.length === 0 ? { controlId, title } : { controlId, title, evidence };

/**
 * The Annex A controls a small software company in a rented office often
 * marks applicable: 84 of 93, leaving out A.7.1–A.7.6, A.7.11 and A.7.12 (the
 * building's physical security is the landlord's) and A.8.30 (no outsourced
 * development). Match it to your own Statement of Applicability. Titles are
 * the standard's.
 */
export const ISO_CONTROLS: IsoControl[] = [
  c("A.5.1", "Policies for information security", "Approved IS policy, current version"),
  c("A.5.2", "Information security roles and responsibilities", "One written list of ISMS roles, used in every document"),
  c("A.5.3", "Segregation of duties"),
  c("A.5.4", "Management responsibilities", "Management review protocol"),
  c("A.5.5", "Contact with authorities"),
  c("A.5.6", "Contact with special interest groups"),
  c("A.5.7", "Threat intelligence"),
  c("A.5.8", "Information security in project management"),
  c("A.5.9", "Inventory of information and other associated assets", "Asset register, dated"),
  c("A.5.10", "Acceptable use of information and other associated assets", "Acceptable use policy and staff acknowledgements"),
  c("A.5.11", "Return of assets"),
  c("A.5.12", "Classification of information", "Classification policy"),
  c("A.5.13", "Labelling of information"),
  c("A.5.14", "Information transfer"),
  c("A.5.15", "Access control", "Access control policy"),
  c("A.5.16", "Identity management"),
  c("A.5.17", "Authentication information"),
  c("A.5.18", "Access rights", "Access rights register, with removals", "Yearly access review note"),
  c("A.5.19", "Information security in supplier relationships", "Supplier register with an assessment per supplier"),
  c("A.5.20", "Addressing information security within supplier agreements"),
  c("A.5.21", "Managing information security in the ICT supply chain"),
  c("A.5.22", "Monitoring, review and change management of supplier services", "Yearly supplier review"),
  c("A.5.23", "Information security for use of cloud services"),
  c("A.5.24", "Information security incident management planning and preparation", "Incident policy and critical events procedure"),
  c("A.5.25", "Assessment and decision on information security events"),
  c("A.5.26", "Response to information security incidents", "Incident log", "Incident response drill record"),
  c("A.5.27", "Learning from information security incidents"),
  c("A.5.28", "Collection of evidence"),
  c("A.5.29", "Information security during disruption"),
  c("A.5.30", "ICT readiness for business continuity", "Business continuity test protocol"),
  c("A.5.31", "Legal, statutory, regulatory and contractual requirements"),
  c("A.5.32", "Intellectual property rights"),
  c("A.5.33", "Protection of records"),
  c("A.5.34", "Privacy and protection of PII"),
  c("A.5.35", "Independent review of information security", "Internal audit report by an independent auditor"),
  c("A.5.36", "Compliance with policies, rules and standards for information security", "Monitoring log (quarterly checks)"),
  c("A.5.37", "Documented operating procedures"),
  c("A.6.1", "Screening"),
  c("A.6.2", "Terms and conditions of employment"),
  c("A.6.3", "Information security awareness, education and training", "Training log", "Signed policy acknowledgements, joiners included"),
  c("A.6.4", "Disciplinary process"),
  c("A.6.5", "Responsibilities after termination or change of employment", "Access removal dates for leavers"),
  c("A.6.6", "Confidentiality or non-disclosure agreements"),
  c("A.6.7", "Remote working", "Personal devices policy and acknowledgements"),
  c("A.6.8", "Information security event reporting"),
  c("A.7.7", "Clear desk and clear screen"),
  c("A.7.8", "Equipment siting and protection"),
  c("A.7.9", "Security of assets off-premises"),
  c("A.7.10", "Storage media"),
  c("A.7.13", "Equipment maintenance"),
  c("A.7.14", "Secure disposal or re-use of equipment"),
  c("A.8.1", "User endpoint devices"),
  c("A.8.2", "Privileged access rights"),
  c("A.8.3", "Information access restriction"),
  c("A.8.4", "Access to source code"),
  c("A.8.5", "Secure authentication", "MFA switched on for every cloud, mail and code account"),
  c("A.8.6", "Capacity management"),
  c("A.8.7", "Protection against malware"),
  c("A.8.8", "Management of technical vulnerabilities", "Quarterly vulnerability and patch check report"),
  c("A.8.9", "Configuration management"),
  c("A.8.10", "Information deletion"),
  c("A.8.11", "Data masking"),
  c("A.8.12", "Data leakage prevention"),
  c("A.8.13", "Information backup", "Backup log with the monthly integrity checks", "Yearly restore test protocol"),
  c("A.8.14", "Redundancy of information processing facilities"),
  c("A.8.15", "Logging"),
  c("A.8.16", "Monitoring activities"),
  c("A.8.17", "Clock synchronization"),
  c("A.8.18", "Use of privileged utility programs"),
  c("A.8.19", "Installation of software on operational systems"),
  c("A.8.20", "Networks security"),
  c("A.8.21", "Security of network services"),
  c("A.8.22", "Segregation of networks"),
  c("A.8.23", "Web filtering"),
  c("A.8.24", "Use of cryptography"),
  c("A.8.25", "Secure development life cycle", "Secure development policy"),
  c("A.8.26", "Application security requirements"),
  c("A.8.27", "Secure system architecture and engineering principles"),
  c("A.8.28", "Secure coding", "Branch protection: every change reviewed by a second developer"),
  c("A.8.29", "Security testing in development and acceptance"),
  c("A.8.31", "Separation of development, test and production environments"),
  c("A.8.32", "Change management", "Change log with a security impact line per change"),
  c("A.8.33", "Test information"),
  c("A.8.34", "Protection of information systems during audit testing"),
];
