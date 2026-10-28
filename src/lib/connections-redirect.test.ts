import { describe, expect, test } from "vitest";
import { connectionsAddress } from "./connections-redirect";

describe("connectionsAddress: where an old set-up page lands", () => {
  test("Settings › Connections, with a Google result word kept", () => {
    expect(connectionsAddress({})).toBe("/settings/connections");
    expect(connectionsAddress({ google: "connected" })).toBe("/settings/connections?google=connected");
    expect(connectionsAddress({ google: "no_refresh_token" })).toBe(
      "/settings/connections?google=no_refresh_token",
    );
  });

  test("anything else is dropped, never passed on", () => {
    expect(connectionsAddress({ google: "x&next=//evil.test" })).toBe("/settings/connections");
    expect(connectionsAddress({ google: ["connected", "failed"] })).toBe("/settings/connections");
    expect(connectionsAddress({ other: "1" })).toBe("/settings/connections");
  });
});
