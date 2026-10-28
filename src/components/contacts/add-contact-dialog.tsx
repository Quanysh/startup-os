"use client";

import { useMutation } from "convex/react";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { COMPANIES, type CompanyId } from "@convex/lib/company";
import {
  CONTACT_CATEGORY_LABELS,
  categoriesFor,
  categoryFits,
  type ContactCategory,
} from "@convex/lib/contacts";
import { fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { messageOf } from "@/lib/errors";
import { Field } from "./contact-shared";

/**
 * A new contact in a few fields: who, where and how to reach them. The rest is
 * added from the contact's own drawer, which opens once it is saved. A name
 * or an address already in the book updates that contact instead.
 */
export function AddContactDialog({
  companies,
  onCreated,
  onClose,
}: {
  companies: CompanyId[];
  onCreated: (id: Id<"contacts">) => void;
  onClose: () => void;
}) {
  const upsert = useMutation(api.contacts.upsert);
  const [company, setCompany] = useState<CompanyId>(companies[0] ?? "us");
  const [category, setCategory] = useState<ContactCategory>("other");
  const [name, setName] = useState("");
  const [org, setOrg] = useState("");
  const [title, setTitle] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await upsert({
        company,
        name,
        category,
        ...(org.trim() ? { org } : {}),
        ...(title.trim() ? { title } : {}),
        ...(email.trim() ? { emails: [email] } : {}),
        ...(phone.trim() ? { phone } : {}),
        // Dated like a note added from the drawer (`withNote`).
        ...(note.trim() ? { notes: `${new Date().toISOString().slice(0, 10)} — ${note.trim()}` } : {}),
      });
      onCreated(saved.id);
    } catch (failure) {
      setError(messageOf(failure, "That contact could not be added."));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-card p-6 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg">Add a contact</DialogTitle>
          <DialogDescription className="text-sm text-ink-2">
            A business contact, never a patient. Add more details from the contact once it is saved.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save} aria-label="Add a contact" className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" className="sm:col-span-2">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                autoFocus
                className={`${fieldClass} h-10`}
              />
            </Field>
            {companies.length > 1 && (
              <Field label="Company">
                <select
                  value={company}
                  onChange={(event) => {
                    const next = event.target.value as CompanyId;
                    setCompany(next);
                    if (!categoryFits(category, next)) setCategory("other");
                  }}
                  className={`${fieldClass} h-10`}
                  aria-label="Contact company"
                >
                  {companies.map((id) => (
                    <option key={id} value={id}>
                      {COMPANIES[id].name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Category">
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value as ContactCategory)}
                className={`${fieldClass} h-10`}
                aria-label="Contact category"
              >
                {categoriesFor(company).map((value) => (
                  <option key={value} value={value}>
                    {CONTACT_CATEGORY_LABELS[value]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Organisation">
              <input value={org} onChange={(event) => setOrg(event.target.value)} className={`${fieldClass} h-10`} />
            </Field>
            <Field label="Title">
              <input value={title} onChange={(event) => setTitle(event.target.value)} className={`${fieldClass} h-10`} />
            </Field>
            <Field label="Email">
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className={`${fieldClass} h-10`}
              />
            </Field>
            <Field label="Phone">
              <input value={phone} onChange={(event) => setPhone(event.target.value)} className={`${fieldClass} h-10`} />
            </Field>
            <Field label="Note" className="sm:col-span-2">
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={3}
                placeholder="How you met, what you talked about"
                className={`${fieldClass} py-2`}
              />
            </Field>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex items-center gap-2">
            <button type="submit" className={primaryButtonClass} disabled={busy || name.trim() === ""}>
              Add contact
            </button>
            <button type="button" className={quietButtonClass} onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
