"use client";

import { ContactsView } from "@/components/contacts/contacts-view";
import { PageHeader } from "@/components/page-header";
import { COMPANIES, companyIds } from "@/lib/company";

export default function ContactsPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Contacts"
        purpose={`Business contacts of ${companyIds()
          .map((id) => COMPANIES[id].name)
          .join(" and ")}. Search by name, email or organisation. Never a patient.`}
      />
      <ContactsView />
    </div>
  );
}
