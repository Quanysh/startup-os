import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { featureOn } from "@convex/lib/featureGates";

// Globex's app on /product (each clinic's page under /product/kz) is
// behind a switch (convex/lib/features.ts): off, there is no such page.
export default function KzProductLayout({ children }: { children: ReactNode }) {
  if (!featureOn("kzProduct")) notFound();
  return children;
}
