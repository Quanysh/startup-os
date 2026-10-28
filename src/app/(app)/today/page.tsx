import { redirect } from "next/navigation";

// Today is the start page at "/" now: the old Dashboard and Today were one
// morning split across two pages. An old link or bookmark lands there.
export default function TodayRedirect() {
  redirect("/");
}
