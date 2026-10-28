import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Connect a client" };

/** OAuth's consent page stands alone: no sidebar, like the sign-in page. */
export default function OAuthLayout({ children }: { children: ReactNode }) {
  return children;
}
