"use client";

import { PlusIcon } from "lucide-react";
import { useRef, useState } from "react";
import { fieldClass } from "@/components/panel";
import { messageOf } from "@/lib/errors";

/** The "add a card" control at the foot of a pipeline column. */
export function AddCard({
  label,
  fieldLabel,
  placeholder,
  onAdd,
}: {
  /** The button's words: "Add a deal". */
  label: string;
  /** The field's accessible name: "New deal in Lead". */
  fieldLabel: string;
  placeholder: string;
  onAdd: (name: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Set when the form closes, so focus goes back to the button that opened it
  // rather than falling off to the top of the page.
  const returnFocus = useRef(false);

  if (!open) {
    return (
      <button
        type="button"
        ref={(button) => {
          if (button && returnFocus.current) {
            returnFocus.current = false;
            button.focus();
          }
        }}
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-1.5 rounded-inner px-2 py-1.5 text-xs text-ink-2 outline-none hover:bg-panel hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <PlusIcon aria-hidden className="size-3.5" />
        {label}
      </button>
    );
  }

  const close = () => {
    returnFocus.current = true;
    setOpen(false);
    setName("");
    setError(null);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const submitted = name;
    if (submitted.trim() === "") return close();
    // Clear the field before the save, not after it: clearing when the save
    // lands would erase whatever was typed for the next card in the meantime.
    setName("");
    setError(null);
    try {
      await onAdd(submitted);
    } catch (failure) {
      setError(messageOf(failure, "That could not be added. Try again."));
      // Give the name back, unless something newer has been typed since.
      setName((current) => (current === "" ? submitted : current));
    }
  };

  return (
    <form
      onSubmit={submit}
      onKeyDown={(e) => e.key === "Escape" && close()}
      className="space-y-2 rounded-inner bg-panel p-2 shadow-soft-sm"
    >
      <input
        autoFocus
        aria-label={fieldLabel}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={placeholder}
        className={`${fieldClass} h-9`}
      />
      <div className="flex justify-end gap-1">
        <button
          type="button"
          onClick={close}
          className="rounded-full px-2.5 py-1 text-xs text-ink-2 outline-none hover:bg-surface focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Done
        </button>
        <button
          type="submit"
          className="rounded-full bg-brand-fill px-3 py-1 text-xs font-medium text-on-brand outline-none hover:bg-brand-deep focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Add
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
