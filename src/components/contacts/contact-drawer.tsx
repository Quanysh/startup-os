"use client";

import { useMutation } from "convex/react";
import { useId, useState } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { COMPANIES } from "@convex/lib/company";
import {
  CONTACT_CATEGORY_LABELS,
  categoriesFor,
  type ContactCategory,
  type ContactLinkType,
} from "@convex/lib/contacts";
import { fieldClass, outlineButtonClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { messageOf } from "@/lib/errors";
import {
  type ContactRow,
  Field,
  LINK_AREA,
  LINK_LABEL,
  lastContactDay,
  linkedinHref,
  splitList,
} from "./contact-shared";

/**
 * One contact, read first: who they are and how to reach them, their notes
 * with a box to add one, and the rest of what is known. Edit details turns
 * the same drawer into the form.
 */
export function ContactDrawer({
  contact,
  onOpen,
  onClose,
}: {
  contact: ContactRow;
  onOpen: (id: Id<"contacts">) => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const subtitle = [contact.title, contact.org].filter(Boolean).join(" · ");

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 overflow-y-auto bg-panel p-6 data-[side=right]:w-full sm:max-w-lg data-[side=right]:sm:max-w-lg">
        <SheetHeader className="p-0 pr-8">
          <SheetTitle className="text-lg text-ink">{contact.name}</SheetTitle>
          {subtitle && <p className="text-sm text-ink-2 [overflow-wrap:anywhere]">{subtitle}</p>}
          <p className="text-xs text-ink-3">
            {CONTACT_CATEGORY_LABELS[contact.category]} · {COMPANIES[contact.company].name}
          </p>
          <SheetDescription className="sr-only">
            This contact&apos;s details and notes. Business contacts only, never a patient.
          </SheetDescription>
        </SheetHeader>
        {editing ? (
          <ContactForm key={contact.id} contact={contact} onDone={() => setEditing(false)} />
        ) : (
          <ContactRead contact={contact} onOpen={onOpen} onEdit={() => setEditing(true)} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function ContactRead({
  contact,
  onOpen,
  onEdit,
}: {
  contact: ContactRow;
  onOpen: (id: Id<"contacts">) => void;
  onEdit: () => void;
}) {
  const now = useNow();
  const link = useMutation(api.contacts.link);
  const { can } = useViewer();
  const [error, setError] = useState<string | null>(null);
  const unlink = async (type: ContactLinkType, id: string) => {
    setError(null);
    try {
      await link({ contactId: contact.id, type, id, linked: false });
    } catch (failure) {
      setError(messageOf(failure, "That link could not be removed."));
    }
  };

  const reach: { label: string; value: string; href: string }[] = [
    ...contact.emails.map((email) => ({ label: "Email", value: email, href: `mailto:${email}` })),
    ...(contact.phone ? [{ label: "Phone", value: contact.phone, href: `tel:${contact.phone.replace(/[^\d+]/g, "")}` }] : []),
    ...(contact.linkedin ? [{ label: "LinkedIn", value: contact.linkedin, href: linkedinHref(contact.linkedin) }] : []),
  ];
  const facts: [string, string][] = [
    ["Owner", contact.owner ?? "—"],
    ["How you met", contact.howMet ?? "—"],
    ["Last contact", lastContactDay(contact.lastContactAt, now)],
    ["Interactions", String(contact.interactionCount)],
    ["Can introduce to", contact.canIntroTo.length > 0 ? contact.canIntroTo.join(", ") : "—"],
  ];

  return (
    <div className="mt-5 space-y-6">
      <div>
        <button type="button" className={outlineButtonClass} onClick={onEdit}>
          Edit details
        </button>
      </div>

      {reach.length > 0 && (
        <section aria-label="How to reach them">
          <dl className="divide-y divide-line">
            {reach.map((item) => (
              <div key={`${item.label}:${item.value}`} className="flex items-baseline justify-between gap-4 py-2 text-sm">
                <dt className="text-ink-2">{item.label}</dt>
                <dd className="min-w-0 text-right [overflow-wrap:anywhere]">
                  <a
                    href={item.href}
                    {...(item.label === "LinkedIn" ? { target: "_blank", rel: "noreferrer" } : {})}
                    className="text-brand hover:underline"
                  >
                    {item.value}
                  </a>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <NotesSection contact={contact} />

      <section aria-label="About">
        <h3 className="text-sm font-medium text-ink">About</h3>
        <dl className="mt-2 divide-y divide-line">
          {facts.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-4 py-2 text-sm">
              <dt className="shrink-0 text-ink-2">{label}</dt>
              <dd className="min-w-0 text-right text-ink [overflow-wrap:anywhere]">{value}</dd>
            </div>
          ))}
          <div className="flex items-baseline justify-between gap-4 py-2 text-sm">
            <dt className="text-ink-2">Introduced by</dt>
            <dd className="text-right">
              {contact.introducedBy && contact.introducedByName ? (
                <button
                  type="button"
                  className="font-medium text-brand outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                  onClick={() => onOpen(contact.introducedBy as Id<"contacts">)}
                >
                  {contact.introducedByName}
                </button>
              ) : (
                "—"
              )}
            </dd>
          </div>
        </dl>
      </section>

      {contact.linkedRecords.length > 0 && (
        <section aria-label="Linked records" className="space-y-2">
          <h3 className="text-sm font-medium text-ink">Linked records</h3>
          <ul className="space-y-1 text-sm">
            {contact.linkedRecords.map((record) => (
              <li key={`${record.type}:${record.id}`} className="flex items-center justify-between gap-2">
                <span>
                  {LINK_LABEL[record.type]}
                  {record.name ? ` · ${record.name}` : ""}
                </span>
                {can(LINK_AREA[record.type]) && (
                  <button type="button" className={quietButtonClass} onClick={() => void unlink(record.type, record.id)}>
                    Unlink
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** The notes, newest on top, and a box that adds a dated note above them. */
function NotesSection({ contact }: { contact: ContactRow }) {
  const addNote = useMutation(api.contacts.addNote);
  const id = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || text.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      await addNote({ id: contact.id, text });
      setText("");
    } catch (failure) {
      setError(messageOf(failure, "That note could not be added."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Notes" className="space-y-3">
      <h3 className="text-sm font-medium text-ink">Notes</h3>
      <form onSubmit={submit} className="space-y-2" aria-label="Add a note">
        <label htmlFor={id} className="sr-only">
          New note
        </label>
        <textarea
          id={id}
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={3}
          placeholder="What happened, what was agreed, what comes next"
          className={`${fieldClass} py-2`}
        />
        <button type="submit" className={primaryButtonClass} disabled={busy || text.trim() === ""}>
          Add note
        </button>
      </form>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {contact.notes ? (
        <p className="whitespace-pre-wrap rounded-inner border border-line bg-surface p-3 text-sm text-ink [overflow-wrap:anywhere]">
          {contact.notes}
        </p>
      ) : (
        <p className="text-sm text-ink-3">No notes yet.</p>
      )}
    </section>
  );
}

/** Every field of a contact, saved together. The company is not changed here: a contact stays with its company. */
function ContactForm({ contact, onDone }: { contact: ContactRow; onDone: () => void }) {
  const upsert = useMutation(api.contacts.upsert);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(() => draftOf(contact));
  const set = (key: keyof typeof draft) => (value: string) => setDraft((before) => ({ ...before, [key]: value }));

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await upsert({
        id: contact.id,
        name: draft.name,
        emails: splitList(draft.emails),
        phone: draft.phone.trim() === "" ? null : draft.phone,
        linkedin: draft.linkedin.trim() === "" ? null : draft.linkedin,
        org: draft.org.trim() === "" ? null : draft.org,
        title: draft.title.trim() === "" ? null : draft.title,
        category: draft.category,
        howMet: draft.howMet.trim() === "" ? null : draft.howMet,
        owner: draft.owner.trim() === "" ? null : draft.owner,
        notes: draft.notes.trim() === "" ? null : draft.notes,
        canIntroTo: splitList(draft.canIntroTo),
        lastContactAt: draft.lastContactAt === "" ? null : Date.parse(`${draft.lastContactAt}T00:00:00.000Z`),
        ...(draft.interactionCount === "" ? {} : { interactionCount: Number(draft.interactionCount) }),
      });
      onDone();
    } catch (failure) {
      setError(messageOf(failure, "That contact could not be saved."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} aria-label="Edit contact" className="mt-5 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <input value={draft.name} onChange={(event) => set("name")(event.target.value)} className={`${fieldClass} h-10`} />
        </Field>
        <Field label="Category">
          <select
            value={draft.category}
            onChange={(event) => set("category")(event.target.value)}
            className={`${fieldClass} h-10`}
            aria-label="Contact category"
          >
            {categoriesFor(contact.company).map((value) => (
              <option key={value} value={value}>
                {CONTACT_CATEGORY_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Organisation">
          <input value={draft.org} onChange={(event) => set("org")(event.target.value)} className={`${fieldClass} h-10`} />
        </Field>
        <Field label="Title">
          <input value={draft.title} onChange={(event) => set("title")(event.target.value)} className={`${fieldClass} h-10`} />
        </Field>
        <Field label="Email addresses" className="sm:col-span-2">
          <textarea
            value={draft.emails}
            onChange={(event) => set("emails")(event.target.value)}
            rows={2}
            className={`${fieldClass} py-2`}
            placeholder="One address a line"
          />
        </Field>
        <Field label="Phone">
          <input value={draft.phone} onChange={(event) => set("phone")(event.target.value)} className={`${fieldClass} h-10`} />
        </Field>
        <Field label="LinkedIn">
          <input value={draft.linkedin} onChange={(event) => set("linkedin")(event.target.value)} className={`${fieldClass} h-10`} />
        </Field>
        <Field label="Owner">
          <input value={draft.owner} onChange={(event) => set("owner")(event.target.value)} className={`${fieldClass} h-10`} />
        </Field>
        <Field label="How you met">
          <input value={draft.howMet} onChange={(event) => set("howMet")(event.target.value)} className={`${fieldClass} h-10`} />
        </Field>
        <Field label="Last contact">
          <input
            type="date"
            value={draft.lastContactAt}
            onChange={(event) => set("lastContactAt")(event.target.value)}
            className={`${fieldClass} h-10`}
          />
        </Field>
        <Field label="Interactions">
          <input
            inputMode="numeric"
            value={draft.interactionCount}
            onChange={(event) => set("interactionCount")(event.target.value)}
            className={`${fieldClass} h-10`}
          />
        </Field>
        <Field label="Can introduce to" className="sm:col-span-2">
          <textarea
            value={draft.canIntroTo}
            onChange={(event) => set("canIntroTo")(event.target.value)}
            rows={2}
            className={`${fieldClass} py-2`}
            placeholder="Tags, contact ids or organisations, one a line"
          />
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <textarea
            value={draft.notes}
            onChange={(event) => set("notes")(event.target.value)}
            rows={6}
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
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          Save
        </button>
        <button type="button" className={quietButtonClass} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function draftOf(contact: ContactRow) {
  const day = (value: number | null) => (value == null ? "" : new Date(value).toISOString().slice(0, 10));
  return {
    name: contact.name,
    emails: contact.emails.join("\n"),
    phone: contact.phone ?? "",
    linkedin: contact.linkedin ?? "",
    org: contact.org ?? "",
    title: contact.title ?? "",
    category: contact.category as ContactCategory,
    owner: contact.owner ?? "",
    howMet: contact.howMet ?? "",
    canIntroTo: contact.canIntroTo.join("\n"),
    lastContactAt: day(contact.lastContactAt),
    interactionCount: String(contact.interactionCount),
    notes: contact.notes ?? "",
  };
}
