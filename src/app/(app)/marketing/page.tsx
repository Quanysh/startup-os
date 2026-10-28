import { redirect } from "next/navigation";

// Marketing is the inbound half of the go-to-market page now. An old link
// still lands somewhere useful.
export default function MarketingPage() {
  redirect("/gtm");
}
