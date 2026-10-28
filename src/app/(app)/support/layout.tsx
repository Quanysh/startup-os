import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { featureOn } from "@convex/lib/featureGates";

// Globex's Intercom inbox is behind a switch (convex/lib/features.ts):
// off, there is no such page.
export default function SupportLayout({ children }: { children: ReactNode }) {
  if (!featureOn("supportInbox")) notFound();
  return children;
}
