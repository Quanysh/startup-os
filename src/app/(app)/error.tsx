"use client";

import { RotateCwIcon } from "lucide-react";
import { useEffect } from "react";

// Shown when a page under the app shell throws while rendering. Keeps the
// failure inside the content area and offers a retry instead of a blank page.
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-xl">This page could not be shown</h1>
      <p className="mt-2 text-sm text-ink-2">
        Something went wrong while loading it. Your data is not affected.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-6 inline-flex h-10 items-center gap-2 rounded-full bg-brand-fill px-5 text-sm font-medium text-on-brand outline-none transition hover:bg-brand-deep focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <RotateCwIcon aria-hidden className="size-4" />
        Try again
      </button>
    </div>
  );
}
