"use client";

import Link from "next/link";
import { useViewer } from "@/hooks/use-viewer";

// The Today panels are the same for the owner and for a teammate, and differ
// in two places: where a tool that has never arrived is set up, and how its
// freshness is said. The owner's tools are read by the OS (Settings → Work
// tools); a teammate's arrive from their own Claude, once a day.

const linkClass = "font-medium text-ink underline underline-offset-2";

/** Where to go when a tool has never been read: the owner's settings, or a teammate's Connect page. */
export function SetupLink() {
  const { isOwner } = useViewer();
  return isOwner ? (
    <Link href="/settings/connections" className={linkClass}>
      Set it up
    </Link>
  ) : (
    <Link href="/settings/connections" className={linkClass}>
      Connect your Claude
    </Link>
  );
}

/**
 * How a panel's footer begins: "Read 5m ago." for the owner, and for a
 * teammate "Last received 5m ago, updated once a day by your Claude task."
 * `age` is already worded ("5m ago"), or null before the clock is known.
 */
export function useFreshness(): (age: string | null) => string {
  const { isOwner } = useViewer();
  return (age) => {
    const when = age === null ? "" : ` ${age}`;
    return isOwner
      ? `Read${when}.`
      : `Last received${when}, updated once a day by your Claude task.`;
  };
}
