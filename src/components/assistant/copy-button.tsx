"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { quietButtonClass } from "@/components/panel";
import { cn } from "@/lib/utils";

/** A button that copies text and says so, or says that it could not. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" onClick={copy} className={cn(quietButtonClass, "h-9 bg-surface px-3 text-ink")}>
        {state === "copied" ? (
          <CheckIcon aria-hidden className="size-4" />
        ) : (
          <CopyIcon aria-hidden className="size-4" />
        )}
        {label}
      </button>
      <span role="status" className="text-xs text-ink-2">
        {state === "copied" && "Copied."}
        {state === "failed" && "Could not copy. Select the text and copy it by hand."}
      </span>
    </span>
  );
}

/** Text to copy, laid out as code: a file, a command, an address. */
export const codeClass =
  "block overflow-x-auto rounded-inner bg-surface px-3 py-2 font-mono text-xs text-ink outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
