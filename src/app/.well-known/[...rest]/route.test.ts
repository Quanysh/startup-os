import { expect, test } from "vitest";
import { GET } from "./route";

test("an unknown well-known address is a JSON 404, never the app's page", async () => {
  const res = GET();
  expect(res.status).toBe(404);
  expect(res.headers.get("Content-Type")).toContain("application/json");
  expect(await res.json()).toEqual({ error: "not_found" });
});
