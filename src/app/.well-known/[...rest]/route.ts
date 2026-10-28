// Any other address under /.well-known/: a JSON 404, so a client probing for
// metadata reads "not here", never the app's HTML page. The ones that exist
// have route handlers of their own beside this one.
export const dynamic = "force-static";

export function GET(): Response {
  return Response.json({ error: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
}
