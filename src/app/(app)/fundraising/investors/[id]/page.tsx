"use client";

import { useParams } from "next/navigation";
import { idFromParam } from "@/lib/route-id";
import { InvestorPage } from "@/components/fundraising/investor-page";

// One investor: its fields, its sync with Visible, its Outcomes. Under
// /fundraising, so it opens to whoever has Fundraising on Startup
// (src/lib/nav.ts, the app shell); the id is in the address, never the name.
export default function FundraisingInvestorPage() {
  const { id } = useParams<{ id: string }>();
  return <InvestorPage investorId={idFromParam(id)} />;
}
