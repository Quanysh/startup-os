import { Suspense } from "react";
import { CostsView } from "@/components/costs/costs-view";
import { Skeleton } from "@/components/ui/skeleton";

export default function CostsPage() {
  return (
    // The table's view is in the address, which is read under a boundary.
    <Suspense fallback={<Skeleton className="h-48 rounded-card" />}>
      <CostsView />
    </Suspense>
  );
}
