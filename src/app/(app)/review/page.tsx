import { redirect } from "next/navigation";

// The weekly review page is put away for now. An old link lands on the
// dashboard, where the goals it used to sit beside still are.
export default function ReviewPage() {
  redirect("/");
}
