"use client";

import { useParams } from "next/navigation";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { ClinicPage } from "@/components/product/kz-clinic-card";

/** The id as the address carries it, read once more if it was encoded; never a throw. */
function idOf(raw: string | undefined): string {
  if (raw === undefined) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// One Kazakhstan clinic's use of Globex's app. Under /product, so it opens
// to whoever has Product (src/lib/nav.ts), and names the clinic only for a
// viewer who also has Customers; the clinic's id is in the address, never its name.
export default function KzClinicPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full rounded-card" />}>
      <ClinicPage id={idOf(id)} />
    </Suspense>
  );
}
