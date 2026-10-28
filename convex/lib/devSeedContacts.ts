// The Contacts book's made-up rows for the local backend (convex/devSeed.ts).
// Every name, organisation and address is invented and reads as invented:
// addresses are at example.test, numbers are 555 numbers. Days are counted
// from the seed's "now".

import type { CompanyId } from "./company";
import type { ContactCategory } from "./contacts";

export type SeedContact = {
  key: string;
  company: CompanyId;
  name: string;
  category: ContactCategory;
  emails?: string[];
  phone?: string;
  linkedin?: string;
  org?: string;
  title?: string;
  howMet?: string;
  /** The key of the seeded contact who made the introduction, of the same company. */
  introducedBy?: string;
  canIntroTo?: string[];
  /** Days before now. Absent: never recorded. */
  lastContactDaysAgo?: number;
  interactionCount?: number;
  owner?: string;
  notes?: string;
  /** Linked to the first seeded investor (Startup only) or the first open deal of its company. */
  link?: "investor" | "deal";
};

export const SEED_CONTACTS: readonly SeedContact[] = [
  {
    key: "advisor",
    company: "us",
    name: "Ada Example",
    category: "advisor",
    emails: ["ada.example@example.test"],
    phone: "+1 555 0101",
    linkedin: "ada-example",
    org: "Example Advisory",
    title: "Partner",
    howMet: "A made-up conference panel",
    canIntroTo: ["Example Ventures", "seed funds"],
    lastContactDaysAgo: 6,
    interactionCount: 4,
    owner: "Owner",
  },
  {
    key: "investor",
    company: "us",
    name: "Ben Placeholder",
    category: "investor",
    emails: ["ben.placeholder@ventures.example.test"],
    org: "Example Ventures",
    title: "Principal",
    introducedBy: "advisor",
    lastContactDaysAgo: 20,
    interactionCount: 2,
    owner: "Owner",
    link: "investor",
  },
  {
    key: "clinic",
    company: "us",
    name: "Cora Sample",
    category: "customer",
    emails: ["cora.sample@maple.example.test"],
    org: "Maple Street Clinic",
    title: "Practice manager",
    lastContactDaysAgo: 3,
    interactionCount: 7,
    link: "deal",
  },
  {
    key: "vendor",
    company: "us",
    name: "Dev Invented",
    category: "vendor",
    org: "Example Hosting",
    notes: "Made-up vendor contact with no address on record.",
  },
  {
    key: "kz-clinic",
    company: "kz",
    name: "Erlan Example",
    category: "kz_clinic",
    emails: ["erlan.example@clinic.example.test"],
    phone: "+7 555 0102",
    org: "Demo Clinic Almaty",
    title: "Chief physician",
    lastContactDaysAgo: 9,
    interactionCount: 3,
    link: "deal",
  },
  {
    key: "kz-partner",
    company: "kz",
    name: "Gulnar Sample",
    category: "partner",
    emails: ["gulnar.sample@partner.example.test"],
    org: "Example Distribution",
    title: "Head of partnerships",
    canIntroTo: ["Demo Clinic Almaty"],
    introducedBy: "kz-clinic",
    lastContactDaysAgo: 30,
    interactionCount: 1,
  },
];
