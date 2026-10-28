// The starter checklist for /compliance: things to find out and keep proof
// of. It is added only when the owner asks for it.
//
// RULES FOR THIS FILE
// - No invented dates. An item has `due` only when the law fixes the date and
//   the page that says so was read; `sourceUrl` is that page. Today that is
//   one item.
// - No invented rhythm: an item without a source has no recurrence. The owner
//   sets how often.
// - A note states a rule only where its source was read. Otherwise it says
//   who to ask.
// - Nothing here says the company has done, holds or complies with anything.
//   These are questions, not answers.

import type { ObligationCategory, Recurrence } from "./obligationShape";

export type StarterItem = {
  seedKey: string;
  category: ObligationCategory;
  title: string;
  note?: string;
  due?: string;
  recurrence?: Recurrence;
  sourceUrl?: string;
};

/** The next March 1 on or after `today`. */
function nextMarchFirst(today: string): string {
  const year = Number(today.slice(0, 4));
  const thisYear = `${year}-03-01`;
  return today <= thisYear ? thisYear : `${year + 1}-03-01`;
}

/** `today` is the owner's calendar date, "YYYY-MM-DD". */
export function starterItems(today: string): StarterItem[] {
  return [
    // ── HIPAA and BAAs ─────────────────────────────────────────────────────
    {
      seedKey: "hipaa-baa-clinics",
      category: "hipaa",
      title: "BAA with every US clinic that sends patient data: signed copies in one place",
      note: "The clinic list shows which US clinics have no BAA date on record.",
    },
    {
      seedKey: "hipaa-baa-vendors",
      category: "hipaa",
      title: "BAA with every vendor that can reach patient data (hosting, database, AI models, email, analytics)",
      note: "List each vendor and link its signed agreement.",
    },
    {
      seedKey: "hipaa-risk-analysis",
      category: "hipaa",
      title: "Security risk analysis: the latest written, dated copy",
    },
    {
      seedKey: "hipaa-policies",
      category: "hipaa",
      title: "Privacy and security policies: written, dated, and where staff can read them",
    },
    {
      seedKey: "hipaa-training",
      category: "hipaa",
      title: "HIPAA training: who completed it and when",
    },
    {
      seedKey: "hipaa-breach-procedure",
      category: "hipaa",
      title: "Breach procedure: written down, with who notifies each clinic",
      note: "A business associate must notify the covered entity without unreasonable delay and in no case later than 60 calendar days after discovering a breach (45 CFR 164.410(b)). Each BAA may set a shorter time: check them.",
      sourceUrl: "https://www.law.cornell.edu/cfr/text/45/164.410",
    },
    {
      seedKey: "hipaa-public-statement",
      category: "hipaa",
      title: "The website's HIPAA statement: the evidence behind it, gathered in one place",
      note: "example.com makes a public statement about HIPAA. Link what supports it, or note what is missing.",
    },

    // ── SOC 2 ──────────────────────────────────────────────────────────────
    {
      seedKey: "soc2-report",
      category: "soc2",
      title: "SOC 2 report: the latest one, its type (I or II) and the period it covers",
    },
    {
      seedKey: "soc2-auditor",
      category: "soc2",
      title: "SOC 2 auditor and compliance platform: engagement letters and renewal dates",
    },
    {
      seedKey: "soc2-access-review",
      category: "soc2",
      title: "Access review: who can reach production and customer data, and when it was last checked",
    },
    {
      seedKey: "soc2-pen-test",
      category: "soc2",
      title: "Penetration test: the latest report and what was fixed",
    },
    {
      seedKey: "soc2-vendor-review",
      category: "soc2",
      title: "Vendor review: a current SOC 2 report or equivalent from each critical vendor",
    },
    {
      seedKey: "soc2-public-statement",
      category: "soc2",
      title: "The website's SOC 2 statement: the report behind it, or what is missing",
      note: "example.com makes a public statement about SOC 2. Link the report it rests on.",
    },

    // ── Kazakhstan data localisation ───────────────────────────────────────
    {
      seedKey: "kz-data-location",
      category: "kz_data",
      title: "Where Kazakhstan clinics' personal data is stored: provider, country, and proof",
      note: "Kazakhstan's law on personal data has a rule on where it is stored. Confirm what it requires of this product with local counsel before relying on any summary.",
    },
    {
      seedKey: "kz-data-counsel",
      category: "kz_data",
      title: "Local counsel's written view on data localisation for the Kazakhstan product",
    },
    {
      seedKey: "kz-data-consent",
      category: "kz_data",
      title: "Patient consent wording used by Kazakhstan clinics: a copy on file",
    },

    // ── Corporate and tax ──────────────────────────────────────────────────
    {
      seedKey: "corp-de-franchise",
      category: "corporate_tax",
      title: "Delaware annual report and franchise tax",
      note: "For a Delaware corporation: due on or before March 1 each year, for the prior year. Late: a $200 penalty plus 1.5% interest a month. Delete this item if the US company is not a Delaware corporation.",
      due: nextMarchFirst(today),
      recurrence: "annual",
      sourceUrl: "https://corp.delaware.gov/paytaxes/",
    },
    {
      seedKey: "corp-us-federal-return",
      category: "corporate_tax",
      title: "US federal income tax return (Form 1120)",
      note: "Due the 15th day of the 4th month after the tax year ends (April 15 for a calendar year), or the next business day. Set the date once the tax year and any extension are confirmed with the accountant.",
      sourceUrl: "https://www.irs.gov/instructions/i1120",
    },
    {
      seedKey: "corp-de-registered-agent",
      category: "corporate_tax",
      title: "Delaware registered agent: annual fee and renewal date",
    },
    {
      seedKey: "corp-us-state",
      category: "corporate_tax",
      title: "State registrations and taxes wherever the US company has people or an office",
    },
    {
      seedKey: "corp-kz-annual-return",
      category: "corporate_tax",
      title: "Kazakhstan company: annual corporate income tax declaration",
      note: "Confirm the deadline with the Kazakhstan accountant.",
    },
    {
      seedKey: "corp-kz-periodic",
      category: "corporate_tax",
      title: "Kazakhstan company: periodic tax and payroll reports",
      note: "Confirm which reports apply, and their dates, with the Kazakhstan accountant.",
    },
    {
      seedKey: "corp-board-consents",
      category: "corporate_tax",
      title: "Board and stockholder consents: the annual ones, signed and filed",
    },
    {
      seedKey: "corp-409a",
      category: "corporate_tax",
      title: "409A valuation: the date of the latest, if options are granted",
    },

    // ── Contract renewals ──────────────────────────────────────────────────
    {
      seedKey: "contract-clinics",
      category: "contracts",
      // One item, never one per clinic: an obligation's title is free text
      // and must not come to name a clinic. The dates live with the clinics.
      title: "Clinic contract renewals: reviewed against the contract dates on the Customers page",
      note: "Each clinic's contract date arrives with the client register and shows in its details on /customers. Keep this as one item: do not add an item per clinic, so that no obligation is titled with a clinic's name.",
    },
    {
      seedKey: "contract-vendors",
      category: "contracts",
      title: "Key vendor contracts: renewal and notice dates (hosting, AI models, EHR access)",
    },
    {
      seedKey: "contract-insurance",
      category: "contracts",
      title: "Cyber and professional liability insurance: policy and renewal date",
    },
    {
      seedKey: "contract-domains",
      category: "contracts",
      title: "Domains and trademarks: renewal dates",
    },
  ];
}
