import { redirect } from "next/navigation";
import { connectionsAddress } from "@/lib/connections-redirect";

// Work tools are part of Settings › Connections now. An old link, or a Google
// connect that began before the move, lands there with its `?google=` result.
export default async function WorkToolsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  redirect(connectionsAddress(await searchParams));
}
