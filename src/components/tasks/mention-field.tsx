"use client";

import { useId, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { cn } from "@/lib/utils";
import type { Person } from "./assignee";
import {
  insertMention,
  matchPeople,
  mentionParts,
  mentionQuery,
  type Offer,
  type Picked,
} from "./mentions";

/**
 * Stored text with the `@names` a card mentions set apart. Every part is
 * rendered as text: nothing stored is ever markup.
 */
export function MentionText({ text, labels }: { text: string; labels: readonly string[] }) {
  return (
    <>
      {mentionParts(text, labels).map((part, index) =>
        part.mention ? (
          <span key={index} data-mention className="rounded bg-brand/10 px-0.5 font-medium text-ink">
            {part.text}
          </span>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

/**
 * A text field that offers people after an `@`. The list sits under the
 * field: arrow keys move through it, Enter or Tab (or a press) puts the
 * person in as `@Name`, Escape puts the list away. What is typed stays plain
 * text; `onMention` says who was picked, which is what a save sends.
 *
 * `singleLine` is for a title: it stays one line, and Enter saves the form
 * when no list is open.
 */
export function MentionField({
  value,
  onChange,
  people,
  onMention,
  singleLine = false,
  className,
  ...props
}: Omit<ComponentProps<"textarea">, "value" | "onChange"> & {
  value: string;
  onChange: (value: string) => void;
  /** Who can be mentioned: the people the task could be given to. */
  people: readonly Person[] | undefined;
  onMention: (person: Picked) => void;
  singleLine?: boolean;
}) {
  const listId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  // Where the caret goes once a picked name is in the text.
  const pending = useRef<number | null>(null);
  const [caret, setCaret] = useState<number | null>(null);
  /** The `@` whose list was put away with Escape. */
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [marked, setMarked] = useState({ key: "", index: 0 });

  const found = caret === null ? null : mentionQuery(value, caret);
  const offers: Offer[] =
    found === null || found.at === dismissed ? [] : matchPeople(people, found.query);
  const open = found !== null && offers.length > 0;
  const key = found === null ? "" : `${found.at}:${found.query}`;
  const index = marked.key === key ? Math.min(marked.index, offers.length - 1) : 0;

  useLayoutEffect(() => {
    if (pending.current === null) return;
    field.current?.setSelectionRange(pending.current, pending.current);
    pending.current = null;
  });

  const pick = (person: Offer) => {
    if (found === null || caret === null) return;
    const next = insertMention(value, found.at, caret, person.label);
    pending.current = next.caret;
    onChange(next.value);
    onMention({ email: person.email, label: person.label });
    setCaret(next.caret);
  };

  const sync = (element: HTMLTextAreaElement) => setCaret(element.selectionStart);

  return (
    <>
      <textarea
        {...props}
        ref={field}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${index}` : undefined}
        value={value}
        className={className}
        onChange={(event) => {
          const element = event.target;
          const text = singleLine ? element.value.replace(/[\r\n]+/g, " ") : element.value;
          // A list put away stays away for that `@` only.
          if (mentionQuery(text, element.selectionStart)?.at !== dismissed) setDismissed(null);
          onChange(text);
          sync(element);
        }}
        onClick={(event) => sync(event.currentTarget)}
        onKeyUp={(event) => sync(event.currentTarget)}
        onBlur={() => setCaret(null)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (open && found !== null) {
            const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
            if (step !== 0) {
              event.preventDefault();
              setMarked({ key, index: (index + step + offers.length) % offers.length });
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              pick(offers[index]!);
              return;
            }
            if (event.key === "Escape") {
              // The editor's dialog leaves this Escape alone (it looks at aria-expanded).
              event.preventDefault();
              setDismissed(found.at);
              return;
            }
          }
          if (singleLine && event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="People to mention"
          className="max-h-48 overflow-y-auto rounded-inner border border-line bg-panel p-1 shadow-soft-sm"
        >
          {offers.map((person, at) => (
            <li
              key={person.email}
              id={`${listId}-${at}`}
              role="option"
              aria-selected={at === index}
              // Keeps the caret in the field while a name is pressed.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(person)}
              className={cn(
                "cursor-pointer truncate rounded px-2.5 py-1.5 text-sm text-ink-2",
                at === index && "bg-surface text-ink",
              )}
            >
              {person.label}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Whether a mention list is open in the field that has focus: Escape is then the list's. */
export function mentionListOpen(): boolean {
  return document.activeElement?.getAttribute("aria-expanded") === "true";
}
