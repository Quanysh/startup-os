"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useViewer } from "@/hooks/use-viewer";
import { canOpen } from "@/lib/nav";

/**
 * A link to a page of the OS, for whoever can open that page. A viewer whose
 * areas lack it reads the same words with no link, or `otherwise` where the
 * link's own words would tell them to do what only the owner can ("Enter the
 * balance"). The owner's sentence is never changed by this.
 */
export function GatedLink({
  href,
  className,
  otherwise,
  children,
}: {
  href: string;
  className?: string;
  /** What a viewer who cannot open the page reads instead of the link's words. */
  otherwise?: ReactNode;
  children: ReactNode;
}) {
  const { areas } = useViewer();
  if (!canOpen(areas, href)) return <>{otherwise === undefined ? children : otherwise}</>;
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
