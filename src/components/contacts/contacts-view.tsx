"use client";

import { useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { COMPANIES, type CompanyId } from "@convex/lib/company";
import {
  CONTACT_CATEGORIES,
  CONTACT_CATEGORY_LABELS,
  categoriesFor,
  categoryFits,
  type ContactCategory,
} from "@convex/lib/contacts";
import { useCompany } from "@/components/company-provider";
import { fieldClass, primaryButtonClass } from "@/components/panel";
import {
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
} from "@/components/ui/data-table";
import { useNarrow } from "@/hooks/use-narrow";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { marketsOf } from "@/lib/company";
import { AddContactDialog } from "./add-contact-dialog";
import { ContactDrawer } from "./contact-drawer";
import { lastContactDay } from "./contact-shared";

/**
 * The contacts list: search, company, category and owner. A click on a
 * contact opens it in a drawer; Add a contact asks for a few fields only.
 * Business contacts only.
 */
export function ContactsView() {
  const { companies } = useViewer();
  const shown = marketsOf(useCompany()).filter((company) => companies.includes(company));
  const [company, setCompany] = useState<CompanyId | "">("");
  const [category, setCategory] = useState<ContactCategory | "">("");
  const [owner, setOwner] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Id<"contacts"> | null>(null);
  const [creating, setCreating] = useState(false);
  const now = useNow();
  const scope = shown.length === 1 ? shown[0] : company === "" ? undefined : company;
  const result = useQuery(api.contacts.list, {
    ...(scope ? { company: scope } : {}),
    ...(category ? { category } : {}),
    ...(owner ? { owner } : {}),
    ...(search.trim() ? { query: search.trim() } : {}),
    limit: 50,
  });
  const inPage = result?.contacts.find((contact) => contact.id === selected) ?? null;
  const fetched = useQuery(
    api.contacts.get,
    selected !== null && !creating && result !== undefined && inPage === null ? { id: selected } : "skip",
  );
  const open = creating ? null : (inPage ?? fetched ?? null);
  const choose = (id: Id<"contacts">) => {
    setSelected(id);
    setCreating(false);
  };
  const narrow = useNarrow();
  const nameButton = (contact: { id: Id<"contacts">; name: string }) => (
    <button
      type="button"
      className="text-left font-medium text-brand outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
      onClick={() => choose(contact.id)}
    >
      {contact.name}
    </button>
  );

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-48 flex-1 space-y-1 text-sm">
            <span className="text-ink-2">Search</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Name, email or organisation"
              className={`${fieldClass} h-10`}
            />
          </label>
          {shown.length > 1 && (
            <label className="space-y-1 text-sm">
              <span className="text-ink-2">Company</span>
              <select
                value={company}
                onChange={(event) => {
                  const next = event.target.value as CompanyId | "";
                  setCompany(next);
                  if (next !== "" && category !== "" && !categoryFits(category, next)) setCategory("");
                }}
                className={`${fieldClass} h-10`}
                aria-label="Company"
              >
                <option value="">Both</option>
                {shown.map((id) => (
                  <option key={id} value={id}>
                    {COMPANIES[id].name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="space-y-1 text-sm">
            <span className="text-ink-2">Category</span>
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value as ContactCategory | "")}
              className={`${fieldClass} h-10`}
              aria-label="Category"
            >
              <option value="">All</option>
              {(scope ? categoriesFor(scope) : CONTACT_CATEGORIES).map((value) => (
                <option key={value} value={value}>
                  {CONTACT_CATEGORY_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-ink-2">Owner</span>
            <select
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
              className={`${fieldClass} h-10`}
              aria-label="Owner"
            >
              <option value="">All</option>
              {(result?.owners ?? []).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={primaryButtonClass}
            onClick={() => {
              setCreating(true);
              setSelected(null);
            }}
          >
            Add a contact
          </button>
        </div>
        {result === undefined ? (
          <p className="text-sm text-ink-3">Loading contacts…</p>
        ) : result.contacts.length === 0 ? (
          <p className="text-sm text-ink-2">No contacts match.</p>
        ) : narrow ? (
          // Below `sm` each contact is a card: the page is used from a phone.
          <ul aria-label="Contacts" className="space-y-3">
            {result.contacts.map((contact) => (
              <li
                key={contact.id}
                data-layout="card"
                onClick={() => choose(contact.id)}
                className="min-w-0 cursor-pointer space-y-1 rounded-inner border border-line bg-panel p-3 text-sm transition hover:bg-surface"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{nameButton(contact)}</span>
                  <span className="shrink-0 text-xs text-ink-2">{CONTACT_CATEGORY_LABELS[contact.category]}</span>
                </div>
                {contact.org && <p className="text-ink-2 [overflow-wrap:anywhere]">{contact.org}</p>}
                {contact.emails[0] && <p className="text-xs text-ink-2 [overflow-wrap:anywhere]">{contact.emails[0]}</p>}
                <p className="text-xs text-ink-3">
                  {COMPANIES[contact.company].name}
                  {contact.owner ? ` · ${contact.owner}` : ""} · Last contact {lastContactDay(contact.lastContactAt, now)}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          // No download: email addresses and numbers do not leave the page as a file.
          <DataTable label="Contacts" download={false} className="table-fixed">
            <DataHead>
              <DataHeader pinned narrow className="w-[14%]">
                Name
              </DataHeader>
              <DataHeader narrow className="w-[15%]">
                Organisation
              </DataHeader>
              <DataHeader narrow className="w-[10%]">
                Category
              </DataHeader>
              <DataHeader narrow className="w-[8%]">
                Company
              </DataHeader>
              <DataHeader narrow className="w-[12%]">
                Owner
              </DataHeader>
              <DataHeader narrow className="w-[30%]">
                Email
              </DataHeader>
              <DataHeader narrow className="w-[11%]">
                Last contact
              </DataHeader>
            </DataHead>
            <DataBody>
              {result.contacts.map((contact) => (
                <DataRow key={contact.id} onClick={() => choose(contact.id)} className="cursor-pointer">
                  <DataRowHeader pinned exportValue={contact.name} className="min-w-0">
                    {nameButton(contact)}
                  </DataRowHeader>
                  <DataCell narrow>{contact.org ?? "—"}</DataCell>
                  <DataCell narrow>{CONTACT_CATEGORY_LABELS[contact.category]}</DataCell>
                  <DataCell narrow>{COMPANIES[contact.company].name}</DataCell>
                  <DataCell narrow>{contact.owner ?? "—"}</DataCell>
                  <DataCell narrow className="whitespace-nowrap">
                    {contact.emails[0] ?? "—"}
                  </DataCell>
                  <DataCell narrow className="whitespace-nowrap">
                    {lastContactDay(contact.lastContactAt, now)}
                  </DataCell>
                </DataRow>
              ))}
            </DataBody>
          </DataTable>
        )}
        {result?.nextCursor && <p className="text-xs text-ink-3">More contacts match than this page shows. Narrow the search.</p>}
      </div>
      {creating && (
        <AddContactDialog
          companies={shown}
          onCreated={(id) => choose(id)}
          onClose={() => setCreating(false)}
        />
      )}
      {!creating && open && (
        <ContactDrawer key={open.id} contact={open} onOpen={choose} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
