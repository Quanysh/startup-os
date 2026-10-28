import { Suspense } from "react";
import { MemoryView } from "@/components/memory/memory-view";
import { Skeleton } from "@/components/ui/skeleton";

export default function MemoryPage() {
  return (
    // The tab and the filters are in the address, which is read under a boundary.
    <Suspense fallback={<Skeleton className="h-48 rounded-card" />}>
      <MemoryView />
    </Suspense>
  );
}
