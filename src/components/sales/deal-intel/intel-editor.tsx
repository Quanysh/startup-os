"use client";

import { Loader2Icon, PlusIcon, XIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import {
  BILLING_MODELS,
  INTEL_LIMITS,
  SIGNAL_KINDS,
  cleanIntelEdit,
  type DealIntel,
  type IntelEdit,
} from "@convex/lib/dealIntel";
import { fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { messageOf } from "@/lib/errors";
import { SIGNAL_KIND_LABELS, draftOf, editOf, type IntelDraft } from "@/lib/pipeline/intel-view";
import { BILLING_LABELS } from "@/lib/pipeline/table-view";

type RowsKey = "competitors" | "signals" | "people" | "sources";
type Column = {
  key: string;
  label: string;
  placeholder?: string;
  /** A select, with these options, instead of a text field. */
  options?: readonly { value: string; label: string }[];
  className?: string;
};

const ROWS: Record<RowsKey, { legend: string; noun: string; max: number; columns: Column[]; blank: Record<string, string> }> = {
  competitors: {
    legend: "Competitors",
    noun: "competitor",
    max: INTEL_LIMITS.competitors,
    columns: [
      { key: "name", label: "Name", className: "sm:w-44" },
      { key: "note", label: "Note", className: "sm:flex-1" },
    ],
    blank: { name: "", note: "" },
  },
  signals: {
    legend: "Signals",
    noun: "signal",
    max: INTEL_LIMITS.signals,
    columns: [
      { key: "date", label: "Date", placeholder: "YYYY-MM or YYYY-MM-DD", className: "sm:w-32" },
      {
        key: "kind",
        label: "Kind",
        options: SIGNAL_KINDS.map((kind) => ({ value: kind, label: SIGNAL_KIND_LABELS[kind] })),
        className: "sm:w-32",
      },
      { key: "text", label: "What happened", className: "sm:flex-1" },
      { key: "source", label: "Source", className: "sm:w-36" },
    ],
    blank: { date: "", kind: "news", text: "", source: "" },
  },
  people: {
    legend: "People",
    noun: "person",
    max: INTEL_LIMITS.people,
    columns: [
      { key: "name", label: "Name", className: "sm:w-40" },
      { key: "role", label: "Role", className: "sm:w-40" },
      { key: "note", label: "Note", className: "sm:flex-1" },
    ],
    blank: { name: "", role: "", note: "" },
  },
  sources: {
    legend: "Sources",
    noun: "source",
    max: INTEL_LIMITS.sources,
    columns: [
      { key: "title", label: "Title", className: "sm:w-56" },
      { key: "url", label: "Artifact link", placeholder: "https://claude.ai/artifact/…", className: "sm:flex-1" },
    ],
    blank: { title: "", url: "" },
  },
};

/**
 * Edit a deal's sales intelligence, every field. The form starts from the
 * intelligence as it was when opened and keeps what is typed: a live update
 * never replaces it. A save sends only the fields changed (null for one
 * emptied), after the same checks the server makes (`cleanIntelEdit`), so a
 * refusal is said before anything is sent, in the server's words.
 */
export function IntelEditor({
  intel,
  onSave,
  onClose,
}: {
  intel: DealIntel | null;
  onSave: (edit: IntelEdit) => Promise<unknown>;
  onClose: () => void;
}) {
  const [base] = useState(() => draftOf(intel));
  const [draft, setDraft] = useState<IntelDraft>(base);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<IntelDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const edit = editOf(draft, base);
    if (Object.keys(edit).length === 0) return onClose();
    const checked = cleanIntelEdit(edit);
    if (!checked.ok) return setError(checked.problem);
    setBusy(true);
    setError(null);
    try {
      await onSave(edit);
      onClose();
    } catch (failure) {
      setError(messageOf(failure, "The intelligence could not be saved. Try again."));
      setBusy(false);
    }
  };

  const text = (key: keyof IntelDraft & string, label: string, options: { max?: number; rows?: number; hint?: string; type?: string } = {}) => (
    <Field label={label} hint={options.hint}>
      {(id, hintId) =>
        options.rows ? (
          <textarea
            id={id}
            rows={options.rows}
            aria-describedby={hintId}
            value={draft[key] as string}
            onChange={(e) => set({ [key]: e.target.value })}
            className={`${fieldClass} py-2`}
          />
        ) : (
          <input
            id={id}
            type={options.type ?? "text"}
            aria-describedby={hintId}
            value={draft[key] as string}
            onChange={(e) => set({ [key]: e.target.value })}
            className={`${fieldClass} h-10`}
          />
        )
      }
    </Field>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto rounded-card p-6 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-lg">Sales intelligence</DialogTitle>
          <DialogDescription className="text-sm text-ink-2">
            What research found about this practice. No email addresses, phone numbers or links,
            except a source&apos;s claude.ai artifact.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={save} className="space-y-6">
          <Group title="The read">
            {text("summary", "Summary", { rows: 4, hint: `Up to ${INTEL_LIMITS.summary} characters.` })}
            {text("angle", "Angle", { rows: 2, hint: "The way in: what to lead with." })}
            {text("nextBestAction", "Next best action")}
            <div className="grid gap-4 sm:grid-cols-2">
              {text("fitScore", "Fit score", { hint: "A whole number from 0 to 100." })}
              {text("researchedAt", "Researched on", { type: "date" })}
            </div>
            {text("fitReasons", "Why this fit", { rows: 3, hint: `One reason a line, ${INTEL_LIMITS.fitReasons} at most.` })}
          </Group>

          <Group title="The practice">
            <div className="grid gap-4 sm:grid-cols-2">
              {text("ownership", "Ownership")}
              {text("ehr", "EHR")}
              {text("pm", "Practice management")}
              <Field label="Billing">
                {(id) => (
                  <select
                    id={id}
                    value={draft.billingModel}
                    onChange={(e) => set({ billingModel: e.target.value })}
                    className={`${fieldClass} h-10`}
                  >
                    <option value="">Not known</option>
                    {BILLING_MODELS.map((model) => (
                      <option key={model} value={model}>
                        {BILLING_LABELS[model]}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              {text("rcmVendor", "RCM vendor")}
              {text("workersComp", "Workers' comp")}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {text("specialties", "Specialties", { rows: 3, hint: `One a line, ${INTEL_LIMITS.specialties} at most.` })}
              {text("ancillaries", "Ancillaries", { rows: 3, hint: `One a line, ${INTEL_LIMITS.ancillaries} at most.` })}
            </div>
          </Group>

          <Group title="What to say">
            {text("painPoints", "Pain points", { rows: 3, hint: `One a line, ${INTEL_LIMITS.painPoints} at most.` })}
            {text("talkingPoints", "Talking points", { rows: 3, hint: `One a line, ${INTEL_LIMITS.talkingPoints} at most.` })}
            {text("risks", "Risks", { rows: 2, hint: `One a line, ${INTEL_LIMITS.risks} at most.` })}
          </Group>

          {(Object.keys(ROWS) as RowsKey[]).map((key) => (
            <RowsField
              key={key}
              spec={ROWS[key]}
              rows={draft[key] as Record<string, string>[]}
              onChange={(rows) => set({ [key]: rows } as Partial<IntelDraft>)}
            />
          ))}

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className={quietButtonClass}>
              Cancel
            </button>
            <button type="submit" disabled={busy} className={primaryButtonClass}>
              {busy && <Loader2Icon aria-hidden className="size-4 animate-spin" />}
              Save
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-4">
      <legend className="mb-3 text-sm font-medium text-ink">{title}</legend>
      {children}
    </fieldset>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (id: string, hintId: string | undefined) => ReactNode;
}) {
  const id = useId();
  const hintId = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children(id, hint === undefined ? undefined : hintId)}
      {hint !== undefined && (
        <p id={hintId} className="text-xs text-ink-2">
          {hint}
        </p>
      )}
    </div>
  );
}

/** A list of things with fields of their own: a row each, added and removed one at a time. */
function RowsField({
  spec,
  rows,
  onChange,
}: {
  spec: (typeof ROWS)[RowsKey];
  rows: Record<string, string>[];
  onChange: (rows: Record<string, string>[]) => void;
}) {
  const change = (index: number, key: string, value: string) =>
    onChange(rows.map((row, at) => (at === index ? { ...row, [key]: value } : row)));
  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 text-sm font-medium text-ink">{spec.legend}</legend>
      {rows.length === 0 && <p className="text-xs text-ink-2">None yet.</p>}
      {rows.map((row, index) => (
        <div key={index} className="flex flex-col gap-2 rounded-inner bg-surface p-2 sm:flex-row sm:items-center">
          {spec.columns.map((column) => {
            const label = `${capitalised(spec.noun)} ${index + 1}: ${column.label.toLowerCase()}`;
            return column.options ? (
              <select
                key={column.key}
                aria-label={label}
                value={row[column.key] ?? ""}
                onChange={(e) => change(index, column.key, e.target.value)}
                className={`${fieldClass} h-9 ${column.className ?? ""}`}
              >
                {column.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                key={column.key}
                aria-label={label}
                placeholder={column.placeholder ?? column.label}
                value={row[column.key] ?? ""}
                onChange={(e) => change(index, column.key, e.target.value)}
                className={`${fieldClass} h-9 ${column.className ?? ""}`}
              />
            );
          })}
          <button
            type="button"
            aria-label={`Remove ${spec.noun} ${index + 1}`}
            onClick={() => onChange(rows.filter((_, at) => at !== index))}
            className="inline-flex size-9 shrink-0 items-center justify-center self-end rounded-full text-ink-2 outline-none hover:bg-panel hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50 sm:self-auto"
          >
            <XIcon aria-hidden className="size-4" />
          </button>
        </div>
      ))}
      {rows.length < spec.max && (
        <button
          type="button"
          onClick={() => onChange([...rows, { ...spec.blank }])}
          className={`${quietButtonClass} -ml-3 h-9`}
        >
          <PlusIcon aria-hidden className="size-4" />
          {`Add a ${spec.noun}`}
        </button>
      )}
    </fieldset>
  );
}

const capitalised = (word: string) => `${word[0]!.toUpperCase()}${word.slice(1)}`;
