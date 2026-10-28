"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { CONTACT_CATEGORY_LABELS, type ContactLinkType } from "@convex/lib/contacts";
import type { CompanyId } from "@convex/lib/company";
import { fieldClass, quietButtonClass } from "@/components/panel";
import { useViewer } from "@/hooks/use-viewer";
import { messageOf } from "@/lib/errors";

type Linked = {
  id: Id<"contacts">;
  name: string;
  org: string | null;
  emails: string[];
  category: keyof typeof CONTACT_CATEGORY_LABELS;
};

/**
 * Contacts linked to one investor, partner or deal, with link and unlink.
 * Not mounted for a viewer without the contacts area, so the query is not sent.
 */
export function LinkedContacts(props: { company: CompanyId; type: ContactLinkType; recordId: string }) {
  const { can } = useViewer();
  if (!can("contacts")) return null;
  return <LinkedContactsBody {...props} />;
}

function LinkedContactsBody({
  company,
  type,
  recordId,
}: {
  company: CompanyId;
  type: ContactLinkType;
  recordId: string;
}) {
  const linked = useQuery(api.contacts.forRecord, { type, id: recordId });
  const link = useMutation(api.contacts.link);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const found = useQuery(
    api.contacts.list,
    query.trim() === "" ? "skip" : { company, query: query.trim(), limit: 8 },
  );
  const linkedIds = new Set((linked ?? []).map((contact) => contact.id));

  const change = async (contactId: Id<"contacts">, linkedTo: boolean) => {
    setError(null);
    try {
      await link({ contactId, type, id: recordId, linked: linkedTo });
      if (!linkedTo) setQuery("");
    } catch (failure) {
      setError(messageOf(failure, "That link could not be saved."));
    }
  };

  return (
    <section aria-label="Linked contacts" className="space-y-3">
      <div>
        <h2 className="text-sm font-medium text-ink">Linked contacts</h2>
        <p className="text-xs text-ink-3">Business contacts only. Never a patient.</p>
      </div>
      {linked === undefined ? (
        <p className="text-sm text-ink-3">Loading contacts…</p>
      ) : linked.length === 0 ? (
        <p className="text-sm text-ink-2">No contacts linked yet.</p>
      ) : (
        <ul className="space-y-2">
          {linked.map((contact) => (
            <ContactLine key={contact.id} contact={contact} onUnlink={() => change(contact.id, false)} />
          ))}
        </ul>
      )}
      <label className="block space-y-1 text-sm">
        <span className="text-ink-2">Find a contact to link</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Name, email or organisation"
          className={`${fieldClass} h-10`}
        />
      </label>
      {query.trim() !== "" && found !== undefined && (
        <ul className="space-y-2">
          {found.contacts
            .filter((contact) => !linkedIds.has(contact.id))
            .map((contact) => (
              <li key={contact.id} className="flex items-center justify-between gap-3 text-sm">
                <span>
                  {contact.name}
                  {contact.org ? <span className="text-ink-3"> · {contact.org}</span> : null}
                </span>
                <button type="button" className={quietButtonClass} onClick={() => change(contact.id, true)}>
                  Link
                </button>
              </li>
            ))}
          {found.contacts.filter((contact) => !linkedIds.has(contact.id)).length === 0 && (
            <li className="text-sm text-ink-3">No other contact matches.</li>
          )}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

function ContactLine({ contact, onUnlink }: { contact: Linked; onUnlink: () => void }) {
  return (
    <li className="flex items-center justify-between gap-3 text-sm">
      <span>
        <span className="font-medium">{contact.name}</span>
        {contact.org ? <span className="text-ink-3"> · {contact.org}</span> : null}
        <span className="text-ink-3"> · {CONTACT_CATEGORY_LABELS[contact.category]}</span>
      </span>
      <button type="button" className={quietButtonClass} onClick={onUnlink}>
        Unlink
      </button>
    </li>
  );
}
