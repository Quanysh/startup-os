"use client";

import { Children, useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { columnsFor, masonryLayout } from "@/lib/layout/masonry";
import { cn } from "@/lib/utils";

/**
 * Panels of different heights in columns with no holes: each goes under the
 * column that ends highest, and the last of each column is stretched so all
 * end at one line (src/lib/layout/masonry.ts). The panels stay in their own
 * order in the page (and so for a keyboard and a screen reader); only where
 * they are drawn changes, and a panel is never moved to another parent, so
 * nothing it holds is mounted again.
 *
 * A panel's own height is measured from its content (its last child's
 * bottom), so a panel that was stretched still reports what it needs. Until
 * it is measured, and on a width that holds one column, it is a plain stack.
 */
export function Masonry({
  children,
  minColumnWidth,
  maxColumns,
  gap = 24,
  className,
}: {
  children: ReactNode;
  minColumnWidth: number;
  maxColumns: number;
  /** Between panels, in px, both ways. */
  gap?: number;
  className?: string;
}) {
  const items = Children.toArray(children);
  const box = useRef<HTMLDivElement>(null);
  const cells = useRef<(HTMLDivElement | null)[]>([]);
  const [width, setWidth] = useState(0);
  const [heights, setHeights] = useState<number[] | null>(null);
  const columns = columnsFor(width, { minColumnWidth, maxColumns, gap });
  const columnWidth = (width - gap * (columns - 1)) / columns;
  const placed = columns > 1 && width > 0;

  const measure = useCallback(() => {
    const next = cells.current.slice(0, items.length).map((cell) => (cell === null ? 0 : ownHeight(cell)));
    setHeights((before) =>
      before !== null && before.length === next.length && before.every((h, i) => Math.abs(h - next[i]!) < 1)
        ? before
        : next,
    );
  }, [items.length]);

  // Width first, then each panel at the column's width, before the first paint.
  useLayoutEffect(() => {
    const node = box.current;
    if (node === null) return;
    setWidth(node.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!placed) return;
    measure();
    const node = box.current;
    if (node === null) return;
    // A panel's content changes (its data arrives, a row is added, a block
    // that drew nothing while it loaded appears): place again, once per
    // batch of changes. Not on an animation frame: a tab in the background
    // has none, and would wake up to panels on top of each other.
    let queued = false;
    const again = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        measure();
      });
    };
    const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(again);
    for (const cell of cells.current) if (cell) resized?.observe(cell);
    const changed = typeof MutationObserver === "undefined" ? null : new MutationObserver(again);
    changed?.observe(node, { childList: true, subtree: true, characterData: true });
    return () => {
      resized?.disconnect();
      changed?.disconnect();
    };
  }, [placed, columnWidth, measure, items.length]);

  const layout = placed && heights !== null ? masonryLayout(heights, columns, gap) : null;

  return (
    <div
      ref={box}
      data-slot="masonry"
      className={cn("relative", !placed && "flex flex-col", className)}
      style={placed ? { height: layout?.height } : { gap }}
    >
      {items.map((item, index) => {
        const at = layout?.placements[index] ?? null;
        return (
          <div
            key={(item as { key?: string }).key ?? index}
            ref={(node) => {
              cells.current[index] = node;
            }}
            className="empty:hidden [&>*]:min-h-[var(--fill,0px)]"
            style={
              placed
                ? {
                    position: "absolute",
                    width: columnWidth,
                    left: at === null ? 0 : at.column * (columnWidth + gap),
                    top: at === null ? 0 : at.top,
                    // Placed once measured; until then it is laid out, unseen.
                    visibility: at === null ? "hidden" : undefined,
                    ...(at?.fill != null ? { "--fill": `${at.fill}px` } : {}),
                  }
                : undefined
            }
          >
            {item}
          </div>
        );
      })}
    </div>
  );
}

/** What a panel needs, whatever it was stretched to: from its top to its last child's bottom, and its bottom padding. */
function ownHeight(cell: HTMLDivElement): number {
  const root = cell.firstElementChild as HTMLElement | null;
  if (root === null) return 0;
  const last = root.lastElementChild;
  if (last === null) return root.offsetHeight;
  const style = getComputedStyle(root);
  const bottom = last.getBoundingClientRect().bottom - root.getBoundingClientRect().top;
  return Math.ceil(bottom + parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth));
}
