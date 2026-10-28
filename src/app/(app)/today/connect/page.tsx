import { redirect } from "next/navigation";
import { CONNECTIONS } from "@/lib/connections-redirect";

// A teammate's token is made on Settings › Connections now. An old link lands there.
export default function ConnectPage() {
  redirect(CONNECTIONS);
}
