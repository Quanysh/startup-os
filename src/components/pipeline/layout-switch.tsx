"use client";

import { KanbanSquareIcon, TableIcon, type LucideIcon } from "lucide-react";
import type { PipelineLayout } from "@/lib/pipeline/table-sort";
import { cn } from "@/lib/utils";

/** Table or board: a pipeline's two layouts. The page keeps the choice in the address. */
export function LayoutSwitch({
  layout,
  onLayout,
}: {
  layout: PipelineLayout;
  onLayout: (layout: PipelineLayout) => void;
}) {
  const choices: [PipelineLayout, string, LucideIcon][] = [
    ["table", "Table", TableIcon],
    ["board", "Board", KanbanSquareIcon],
  ];
  return (
    <div
      role="group"
      aria-label="Layout"
      className="inline-flex h-9 shrink-0 gap-0.5 rounded-full bg-surface p-1"
    >
      {choices.map(([id, label, Icon]) => (
        <button
          key={id}
          type="button"
          aria-pressed={layout === id}
          onClick={() => onLayout(id)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-3 text-xs font-medium text-ink-2 outline-none transition hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50",
            layout === id && "bg-panel text-ink shadow-soft-sm",
          )}
        >
          <Icon aria-hidden className="size-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}
