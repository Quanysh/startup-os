import { redirect } from "next/navigation";
import { CONNECTIONS } from "@/lib/connections-redirect";

// The agent token and the record of calls are on Settings › Connections now
// ("Let Claude read Startup OS"). An old link lands there.
export default function AssistantConnectionPage() {
  redirect(CONNECTIONS);
}
