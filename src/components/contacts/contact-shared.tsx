import type { ReactNode } from "react";
import type { Id } from "@convex/_generated/dataModel";
import type { CompanyId } from "@convex/lib/company";
import type { ContactCategory, ContactLinkType } from "@convex/lib/contacts";
import type { Area } from "@convex/lib/roles";
import { dayLabel } from "@/lib/format";

export type ContactRow = {
  id: Id<"contacts">;
  name: string;
  emails: string[];
  phone: string | null;
  linkedin: string | null;
  org: string | null;
  title: string | null;
  company: CompanyId;
  category: ContactCategory;
  linkedRecords: { type: ContactLinkType; id: string; name: string | null }[];
  howMet: string | null;
  introducedBy: string | null;
  introducedByName: string | null;
  canIntroTo: string[];
  lastContactAt: number | null;
  interactionCount: number;
  owner: string | null;
  notes: string | null;
};

export const LINK_LABEL: Record<ContactLinkType, string> = {
  investor: "Investor",
  partner: "Partner",
  deal: "Deal",
};

// The page a linked record lives on: linking and unlinking it is that page's (convex/contacts.ts refuses the rest).
export const LINK_AREA = { investor: "fundraising", partner: "partnerships", deal: "sales" } as const satisfies Record<
  ContactLinkType,
  Area
>;

/** The day a last-contact timestamp falls on, in UTC, as the rest of the app writes a day. */
export function lastContactDay(value: number | null, now: number | null): string {
  if (value == null || now === null) return "—";
  return dayLabel(new Date(value).toISOString().slice(0, 10), now);
}

export const splitList = (value: string) =>
  value
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter((part) => part !== "");

/** Where a stored LinkedIn value goes: a full address as it is, a handle under /in/. */
export function linkedinHref(value: string): string {
  return value.includes("://") ? value : `https://www.linkedin.com/in/${encodeURIComponent(value)}`;
}

export function Field({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <label className={`block space-y-1 text-sm ${className ?? ""}`}>
      <span className="text-ink-2">{label}</span>
      {children}
    </label>
  );
}
