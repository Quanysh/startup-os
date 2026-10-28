"use client";

import { nearCardsSentence, type NearCard } from "@/lib/tasks/duplicates";

/**
 * The step between a person's add and a card near one already open: the
 * open cards' titles, "Add anyway" (sent again as confirmed) and "Don't add".
 * A person is never refused for a near duplicate; only a bot is.
 */
export function DuplicateWarning({
  cards,
  busy = false,
  onAdd,
  onCancel,
  className,
}: {
  cards: readonly NearCard[];
  busy?: boolean;
  onAdd: () => void;
  onCancel: () => void;
  className?: string;
}) {
  return (
    <div role="alert" className={className ?? "space-y-1.5 text-xs text-ink-2"}>
      <p className="[overflow-wrap:anywhere]">{nearCardsSentence(cards)}</p>
      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          disabled={busy}
          onClick={onAdd}
          className="rounded-full bg-brand-fill px-3 py-1 text-xs font-medium text-on-brand outline-none hover:bg-brand-deep focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
        >
          Add anyway
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="rounded-full px-2.5 py-1 text-xs text-ink-2 outline-none hover:bg-surface focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
        >
          Don&apos;t add
        </button>
      </div>
    </div>
  );
}
