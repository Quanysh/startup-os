"use client";

import { useMutation } from "convex/react";
import { useState } from "react";
import { api } from "@convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { MAX_TITLE_LENGTH } from "@convex/lib/limits";
import { MAX_NOTE_BODY } from "@convex/lib/memory";
import type { CompanyId } from "@convex/lib/company";
import { fieldClass, primaryButtonClass } from "@/components/panel";
import { messageOf } from "@/lib/errors";
import { cn } from "@/lib/utils";

export type NoteRow = FunctionReturnType<typeof api.notes.list>[number];

/**
 * Notes that are not the notes of a meeting. Text is rendered as text.
 * The company is the one the page is showing.
 */
export function NotesPanel({ rows, company, q }: { rows: readonly NoteRow[]; company: CompanyId; q: string }) {
  const create = useMutation(api.notes.create);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const needle = q.trim().toLowerCase();
  const shown = rows.filter(
    (row) => needle === "" || row.title.toLowerCase().includes(needle) || row.body.toLowerCase().includes(needle),
  );

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await create({ company, title, body });
      setTitle("");
      setBody("");
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <section className="rounded-card bg-panel p-5 shadow-soft sm:p-6">
        <h2 className="text-lg">New note</h2>
        <p className="mt-1 text-sm text-ink-2">A note the company keeps, not the notes of a meeting.</p>
        <div className="mt-4 space-y-3">
          <input
            value={title}
            maxLength={MAX_TITLE_LENGTH}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Title"
            aria-label="Title"
            className={cn(fieldClass, "h-9")}
          />
          <textarea
            value={body}
            maxLength={MAX_NOTE_BODY}
            rows={5}
            onChange={(event) => setBody(event.target.value)}
            placeholder="The note"
            aria-label="Note"
            className={cn(fieldClass, "py-2")}
          />
          {error !== null && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <button type="button" disabled={saving || title.trim() === "" || body.trim() === ""} onClick={save} className={primaryButtonClass}>
            Save note
          </button>
        </div>
      </section>
      {shown.length === 0 ? (
        <p className="text-sm text-ink-2">No notes yet.</p>
      ) : (
        <ol className="space-y-3">
          {shown.map((row) => (
            <li key={row.id} className="rounded-card bg-panel p-5 shadow-soft">
              <h3 className="text-base font-medium">{row.title}</h3>
              <p className="mt-2 whitespace-pre-wrap text-sm text-ink">{row.body}</p>
              {row.by !== null && <p className="mt-2 text-xs text-ink-2">By {row.by}</p>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
