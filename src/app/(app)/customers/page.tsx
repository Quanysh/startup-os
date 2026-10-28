"use client";

import { Suspense } from "react";
import { CustomersView } from "@/components/customers/customers-view";
import { Skeleton } from "@/components/ui/skeleton";

// The view reads its filters from the URL, which needs a Suspense boundary.
export default function CustomersPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full rounded-card" />}>
      <CustomersView />
    </Suspense>
  );
}
