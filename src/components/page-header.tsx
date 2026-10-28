import type { ReactNode } from "react";
import { AnimatedGrid } from "@/components/ui/animated-grid";

/**
 * The head of a page, the same on the Dashboard, Today and the Assistant: the
 * title, one line saying what the page is for, and what it is about on the
 * right (the company and week, the date, whether Claude's Mac is there). A
 * `note` is a quieter second line under the purpose. A slow grid drifts
 * behind it (`AnimatedGrid`), as behind Today's opening.
 */
export function PageHeader({
  title,
  purpose,
  aside,
  note,
}: {
  title: string;
  purpose: ReactNode;
  aside?: ReactNode;
  note?: ReactNode;
}) {
  return (
    <header className="relative isolate flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <AnimatedGrid className="-inset-x-4 sm:-inset-x-8 -inset-y-10 -z-10" />
      <div className="min-w-0">
        <h1 className="text-2xl sm:text-3xl">{title}</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-2">{purpose}</p>
        {note !== undefined && <p className="mt-1 text-xs text-ink-3">{note}</p>}
      </div>
      {aside !== undefined && (
        <div className="flex min-h-5 flex-wrap items-center gap-x-3 gap-y-2 text-sm text-ink-2 sm:justify-end">
          {aside}
        </div>
      )}
    </header>
  );
}
