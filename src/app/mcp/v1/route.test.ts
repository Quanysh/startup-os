import { describe, expect, test } from "vitest";
import { GET } from "./route";

// A client that probes the endpoint with GET (to open a stream, or to learn
// how to sign in) is told how to sign in, as a POST without a token is.
describe("GET /mcp/v1", () => {
  test("with no token: 401 and where to sign in", async () => {
    const res = await GET(new Request("https://os.example.com/mcp/v1"));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(
      'Bearer resource_metadata="https://os.example.com/.well-known/oauth-protected-resource/mcp/v1"',
    );
    expect(await res.json()).toMatchObject({ error: "invalid_token" });
  });

  test("with a token: 405, there is no stream to open, POST is", async () => {
    const res = await GET(new Request("https://os.example.com/mcp/v1", { headers: { Authorization: "Bearer x" } }));
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });
});
