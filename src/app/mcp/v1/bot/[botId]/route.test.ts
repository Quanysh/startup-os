import { describe, expect, test } from "vitest";
import { GET } from "./route";

// A bot's own connector address answers a GET as /mcp/v1 does, naming its own
// protected resource's metadata, so a client signs in for that bot alone.
describe("GET /mcp/v1/bot/<bot id>", () => {
  test("with no token: 401 and where this address's sign-in is described", async () => {
    const res = GET(new Request("https://os.example.com/mcp/v1/bot/growth"));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(
      'Bearer resource_metadata="https://os.example.com/.well-known/oauth-protected-resource/mcp/v1/bot/growth"',
    );
  });

  test("with a token: 405, POST is the one method", () => {
    const res = GET(new Request("https://os.example.com/mcp/v1/bot/growth", { headers: { Authorization: "Bearer x" } }));
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  test("a last segment that is no bot id is not there", () => {
    for (const path of ["/mcp/v1/bot/Growth", "/mcp/v1/bot/g", "/mcp/v1/bot/a%2Fb", "/mcp/v1/bot/growth.json"]) {
      expect(GET(new Request(`https://os.example.com${path}`)).status).toBe(404);
    }
  });
});
