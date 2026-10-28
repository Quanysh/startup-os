// Company memory's made-up rows for the local backend (convex/devSeed.ts).
// Every title, name and line here is invented and reads as invented. Days are
// counted from the seed's "now", so a revisit is due on the seeded Today.

import { COMPANIES, type CompanyId } from "./company";
import type { DecisionStatus, MeetingKind } from "./memory";

export type SeedMeeting = {
  key: string;
  company: CompanyId;
  kind: MeetingKind;
  /** Days before now. */
  daysAgo: number;
  title: string;
  notes: string;
  outsideAttendees: string[];
  actionItems: string[];
};

export type SeedDecision = {
  company: CompanyId;
  title: string;
  decision: string;
  context?: string;
  status: DecisionStatus;
  daysAgo: number;
  /** Days from now; negative is already due. */
  revisitIn?: number;
  tags: string[];
  /** The `key` of a seeded meeting it was made in. */
  meeting?: string;
  /** The owner of the OS owns it, so the seeded Today shows a revisit. */
  ownedByOwner?: boolean;
};

export const SEED_MEETINGS: readonly SeedMeeting[] = [
  {
    key: "us-board",
    company: "us",
    kind: "board",
    daysAgo: 9,
    title: "Example board meeting",
    notes:
      "Made-up notes. Reviewed the sample pipeline and the placeholder runway.\n\nAgreed to price per seat from next quarter. Discussed a second engineer; no decision yet.",
    outsideAttendees: ["Example Board Member"],
    actionItems: ["Send the sample board deck to everyone", "Draft the per-seat price sheet"],
  },
  {
    key: "us-investor",
    company: "us",
    kind: "investor",
    daysAgo: 3,
    title: "Example Ventures catch-up",
    notes: "Made-up notes. Example Ventures asked for monthly updates and a placeholder data room.",
    outsideAttendees: ["Sample Partner"],
    actionItems: ["Share the placeholder data room link"],
  },
  {
    key: "kz-leadership",
    company: "kz",
    kind: "leadership",
    daysAgo: 5,
    title: `Example ${COMPANIES.kz.name} leadership sync`,
    notes: "Made-up notes. Renewals first this quarter; the sample clinic pilot moves to paid.",
    outsideAttendees: [],
    actionItems: ["Call the demo clinic about renewal terms"],
  },
];

export const SEED_DECISIONS: readonly SeedDecision[] = [
  {
    company: "us",
    title: "Example: price per seat",
    decision: "We charge per seat from next quarter, with the sample discount for pilots.",
    context: "Made-up context: per-clinic pricing undercharged the larger example groups.",
    status: "decided",
    daysAgo: 9,
    revisitIn: -2,
    tags: ["pricing"],
    meeting: "us-board",
    ownedByOwner: true,
  },
  {
    company: "us",
    title: "Example: monthly investor updates",
    decision: "Send a short update on the first working day of each month.",
    status: "decided",
    daysAgo: 3,
    revisitIn: 60,
    tags: ["fundraising"],
    meeting: "us-investor",
  },
  {
    company: "us",
    title: "Example: a second engineer",
    decision: "Hire a second engineer once the made-up seed round closes.",
    status: "proposed",
    daysAgo: 9,
    tags: ["hiring"],
  },
  {
    company: "us",
    title: "Example: drop the sample free tier",
    decision: "The free tier ends; existing users keep it until their renewal.",
    status: "reversed",
    daysAgo: 40,
    revisitIn: -20,
    tags: ["pricing"],
  },
  {
    company: "kz",
    title: "Example: renewals before new clinics",
    decision: `This quarter the ${COMPANIES.kz.name} team works renewals before new clinics.`,
    context: "Made-up context: three sample renewals fall in the same month.",
    status: "decided",
    daysAgo: 5,
    revisitIn: 10,
    tags: ["sales"],
    meeting: "kz-leadership",
  },
  {
    company: "kz",
    title: "Example: move the pilot to paid",
    decision: "The sample clinic pilot moves to the paid plan next month.",
    status: "revisit",
    daysAgo: 30,
    revisitIn: 0,
    tags: [],
  },
];
