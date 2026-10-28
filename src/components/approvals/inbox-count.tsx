"use client";

import { SidebarMenuBadge } from "@/components/ui/sidebar";
import { OPEN_COUNT_CAP } from "@/lib/assistant/agents";
import { useWaitingCount } from "./inbox";

/**
 * How many items wait in the approvals inbox, beside the "Approvals" item of
 * the navigation: the one count (`useWaitingCount`, both companies), which
 * the page, Today's "Needs you", the Bots tab and the Assistant read too, so
 * they agree. Mounted for the owner alone (src/components/app-shell.tsx
 * shows the item only with `personal`): the inbox is an `ownerQuery`, never
 * asked for anyone else.
 */
export function InboxCount() {
  const count = useWaitingCount();
  if (count === undefined || count === 0) return null;
  const shown = count >= OPEN_COUNT_CAP ? `${OPEN_COUNT_CAP}+` : String(count);
  return (
    <SidebarMenuBadge
      data-testid="inbox-count"
      aria-label={`${shown} ${count === 1 ? "item waits" : "items wait"} for your approval`}
      className="right-2 rounded-full bg-brand/10 text-[11px] text-brand"
    >
      {shown}
    </SidebarMenuBadge>
  );
}
