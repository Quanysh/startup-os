"use client";

import { ExternalLinkIcon, Loader2Icon, PlusIcon, Trash2Icon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { COMPANIES, type CompanyId } from "@/lib/company";
import { messageOf } from "@/lib/errors";
import { cn } from "@/lib/utils";

// The pieces the four record tabs on /compliance share: a link, a company
// mark, the small buttons, and one editor dialog with its fields. The same
// shapes as the obligation editor, so the tabs read as one page.

export const smallButton = cn(quietButtonClass, "h-8 bg-surface px-3 text-xs text-ink");
/** In a table row: on white with a hairline, so it stands clear of the stripe. */
export const rowButton = cn(smallButton, "border border-line bg-panel hover:bg-panel");

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded-inner text-ink underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {children}
      <ExternalLinkIcon aria-hidden className="size-3.5 text-ink-2" />
    </a>
  );
}

export const companyName = (company: CompanyId) => COMPANIES[company].name;

export function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={smallButton}>
      <PlusIcon aria-hidden className="size-3.5" />
      {label}
    </button>
  );
}

/** The same rule the server applies to a document link, said before the round trip. */
export function isHttps(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** The error a link field would be refused with, or null. */
export const linkProblem = (value: string): string | null =>
  value.trim() !== "" && !isHttps(value.trim()) ? "A document link must be a full https:// address." : null;

type FieldProps = { label: string; value: string; onChange: (value: string) => void; hint?: string };

export function TextField({
  label,
  value,
  onChange,
  hint,
  type = "text",
  placeholder,
}: FieldProps & { type?: "text" | "url"; placeholder?: string }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <input
        id={id}
        type={type}
        inputMode={type === "url" ? "url" : undefined}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${fieldClass} h-10`}
      />
      {hint && <p className="text-xs text-ink-3">{hint}</p>}
    </div>
  );
}

export const DateField = ({ label, value, onChange, hint }: FieldProps) => {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <input id={id} type="date" value={value} onChange={(e) => onChange(e.target.value)} className={`${fieldClass} h-10`} />
      {hint && <p className="text-xs text-ink-3">{hint}</p>}
    </div>
  );
};

export function TextAreaField({ label, value, onChange, rows = 3 }: FieldProps & { rows?: number }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} rows={rows} className={`${fieldClass} py-2`} />
    </div>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: string }[];
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as T)} className={`${fieldClass} h-10`}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The dialog every record is added or edited in. `save` throws a ConvexError
 * to be shown; `problem` is checked first. Its fields are the caller's: read
 * once from the record when the editor opens, so a live update never replaces
 * what has been typed.
 */
export function RecordEditor({
  title,
  description,
  problem,
  save,
  remove,
  onClose,
  children,
}: {
  title: string;
  description: string;
  problem?: () => string | null;
  save: () => Promise<unknown>;
  remove?: () => Promise<unknown>;
  onClose: () => void;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const found = problem?.() ?? null;
    if (found !== null) return setError(found);
    setBusy(true);
    setError(null);
    try {
      await save();
      onClose();
    } catch (failure) {
      setError(messageOf(failure));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto rounded-card p-6 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg">{title}</DialogTitle>
          <DialogDescription className="sr-only">{description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          {children}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            {remove === undefined ? (
              <span />
            ) : confirmDelete ? (
              <span className="flex items-center gap-1 text-sm text-ink-2">
                Delete this record?
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await remove();
                      onClose();
                    } catch (failure) {
                      setError(messageOf(failure, "That record could not be deleted. Try again."));
                      setConfirmDelete(false);
                    }
                  }}
                  className="rounded-full px-3 py-1.5 font-medium text-destructive outline-none hover:bg-destructive/10 focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-full px-3 py-1.5 outline-none hover:bg-surface focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  Keep
                </button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirmDelete(true)} className={`${quietButtonClass} -ml-3 hover:text-destructive`}>
                <Trash2Icon aria-hidden className="size-4" />
                Delete
              </button>
            )}
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className={quietButtonClass}>
                Cancel
              </button>
              {/* aria-disabled, not disabled: a natively disabled button drops focus mid-request. */}
              <button type="submit" aria-disabled={busy} className={cn(primaryButtonClass, "aria-disabled:opacity-60")}>
                {busy && <Loader2Icon aria-hidden className="size-4 animate-spin" />}
                Save
              </button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Changed by Claude Code, 12 Oct": who wrote last, when it is on record. */
export function ChangedBy({ by }: { by: string | null }) {
  return by === null ? null : <p className="text-xs text-ink-3">Changed by {by}</p>;
}
