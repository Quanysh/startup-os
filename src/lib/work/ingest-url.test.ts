import { describe, expect, test } from "vitest";
import { ingestUrlProblem } from "../../../scripts/ingestUrl";
import {
  convexSiteOrigin,
  ingestAddressAllowed,
  ingestUrlOf,
  mcpUrlOf,
  publicOrigin,
} from "./ingest-url";

describe("ingestUrlOf", () => {
  test("a deployment's client address gives its HTTP-actions address", () => {
    expect(ingestUrlOf({ convexUrl: "https://made-up-animal-123.convex.cloud" })).toBe(
      "https://made-up-animal-123.convex.site/ingest/v1",
    );
    expect(ingestUrlOf({ convexUrl: "https://made-up-animal-123.eu-west-1.convex.cloud/" })).toBe(
      "https://made-up-animal-123.eu-west-1.convex.site/ingest/v1",
    );
  });

  test("the site address is used when it is this deployment, or the only address", () => {
    expect(
      ingestUrlOf({
        siteUrl: "https://made-up-animal-123.convex.site/anything/",
        convexUrl: "https://made-up-animal-123.convex.cloud",
      }),
    ).toBe("https://made-up-animal-123.convex.site/ingest/v1");
    // No client URL: the site address is all there is.
    expect(ingestUrlOf({ siteUrl: "https://other-animal-456.convex.site/anything/" })).toBe(
      "https://other-animal-456.convex.site/ingest/v1",
    );
  });

  test("a site address for a different deployment is ignored", () => {
    // A dev deployment left in the build must not win over the client URL
    // `convex deploy` injected. That is what sent production's OAuth
    // discovery and token refresh at a backend from before those routes.
    expect(
      ingestUrlOf({
        siteUrl: "https://other-animal-456.convex.site",
        convexUrl: "https://made-up-animal-123.convex.cloud",
      }),
    ).toBe("https://made-up-animal-123.convex.site/ingest/v1");
    expect(
      ingestUrlOf({
        siteUrl: "http://127.0.0.1:3211",
        convexUrl: "https://made-up-animal-123.convex.cloud",
      }),
    ).toBe("https://made-up-animal-123.convex.site/ingest/v1");
  });

  test("a local backend's actions are on the next port", () => {
    expect(ingestUrlOf({ convexUrl: "http://127.0.0.1:3210" })).toBe(
      "http://127.0.0.1:3211/ingest/v1",
    );
    expect(ingestUrlOf({ convexUrl: "http://localhost:3210" })).toBe(
      "http://localhost:3211/ingest/v1",
    );
    expect(ingestUrlOf({ siteUrl: "http://127.0.0.1:3211" })).toBe("http://127.0.0.1:3211/ingest/v1");
  });

  test.each([
    ["nothing set", {}],
    ["blank", { convexUrl: "  ", siteUrl: "" }],
    ["not a URL", { convexUrl: "made-up-animal-123" }],
    ["the app's own domain", { convexUrl: "https://os.example.test" }],
    ["a site address that is not Convex's", { siteUrl: "https://os.example.test" }],
    ["a look-alike host", { convexUrl: "https://made-up.convex.cloud.example.test" }],
    ["plain http off this machine", { siteUrl: "http://made-up-animal-123.convex.site" }],
    ["credentials in the address", { siteUrl: "https://user:pass@made-up-animal-123.convex.site" }],
    ["a local address with no port", { convexUrl: "http://localhost" }],
  ])("%s gives no address, so no token is told where to go", (_what, config) => {
    expect(ingestUrlOf(config)).toBeNull();
  });

  test("every address it gives is one the push scripts would accept", () => {
    for (const config of [
      { convexUrl: "https://made-up-animal-123.convex.cloud" },
      { siteUrl: "https://other-animal-456.convex.site" },
      { convexUrl: "http://127.0.0.1:3210" },
    ]) {
      expect(ingestUrlProblem(ingestUrlOf(config)!)).toBeNull();
    }
  });
});

describe("convexSiteOrigin", () => {
  test("is the HTTP-actions origin the ingest address is built on", () => {
    expect(convexSiteOrigin({ convexUrl: "https://made-up-animal-123.convex.cloud" })).toBe(
      "https://made-up-animal-123.convex.site",
    );
    expect(
      convexSiteOrigin({
        siteUrl: "https://made-up-animal-123.convex.site/anything",
        convexUrl: "https://made-up-animal-123.convex.cloud",
      }),
    ).toBe("https://made-up-animal-123.convex.site");
    expect(
      convexSiteOrigin({
        siteUrl: "https://other-animal-456.convex.site",
        convexUrl: "https://made-up-animal-123.convex.cloud",
      }),
    ).toBe("https://made-up-animal-123.convex.site");
    expect(
      convexSiteOrigin({
        siteUrl: "https://made-up-animal-123.eu-west-1.convex.site",
        convexUrl: "https://made-up-animal-123.eu-west-1.convex.cloud",
      }),
    ).toBe("https://made-up-animal-123.eu-west-1.convex.site");
    expect(convexSiteOrigin({ convexUrl: "http://127.0.0.1:3210" })).toBe("http://127.0.0.1:3211");
  });

  test.each([
    ["nothing set", {}],
    ["the app's own domain", { convexUrl: "https://os.example.test" }],
    ["a site address that is not Convex's", { siteUrl: "https://os.example.test" }],
    ["a look-alike host", { siteUrl: "https://made-up.convex.site.example.test" }],
    ["plain http off this machine", { siteUrl: "http://made-up-animal-123.convex.site" }],
    ["credentials", { siteUrl: "https://user:pass@made-up-animal-123.convex.site" }],
  ])("%s gives no origin", (_what, config) => {
    expect(convexSiteOrigin(config)).toBeNull();
  });
});

describe("publicOrigin", () => {
  test("an https origin is taken as it is, with or without the closing slash", () => {
    expect(publicOrigin("https://os.example.test")).toBe("https://os.example.test");
    expect(publicOrigin(" https://os.example.test/ ")).toBe("https://os.example.test");
  });

  test.each([
    ["unset", undefined],
    ["blank", "  "],
    ["not a URL", "os.example.test"],
    ["plain http", "http://os.example.test"],
    ["plain http on this machine", "http://localhost:3100"],
    ["a path", "https://os.example.test/app"],
    ["a query", "https://os.example.test/?a=1"],
    ["an empty query", "https://os.example.test/?"],
    ["a fragment", "https://os.example.test/#a"],
    ["credentials", "https://user:pass@os.example.test"],
    ["a user name alone", "https://user@os.example.test"],
  ])("%s is not a public origin", (_what, value) => {
    expect(publicOrigin(value)).toBeNull();
  });
});

describe("ingestUrlOf with the app's public origin", () => {
  const convexUrl = "https://made-up-animal-123.convex.cloud";

  test("the public origin's own /ingest/v1 is preferred to the Convex address", () => {
    expect(ingestUrlOf({ osUrl: "https://os.example.test", convexUrl })).toBe(
      "https://os.example.test/ingest/v1",
    );
    expect(
      ingestUrlOf({
        osUrl: "https://os.example.test/",
        siteUrl: "https://other-animal-456.convex.site",
        convexUrl,
      }),
    ).toBe("https://os.example.test/ingest/v1");
  });

  test.each([undefined, "", "   "])("unset (%j), it is the Convex address as before", (osUrl) => {
    expect(ingestUrlOf({ osUrl, convexUrl })).toBe(
      "https://made-up-animal-123.convex.site/ingest/v1",
    );
  });

  test.each([
    "http://os.example.test",
    "https://os.example.test/app",
    "https://user:pass@os.example.test",
    "https://os.example.test/?a=1",
    "os.example.test",
  ])("set to %s, which is not a public origin, no address is shown at all", (osUrl) => {
    // Not the Convex address in its place: the owner meant teammates to save
    // the stable one, and a prompt that quietly shows the other hides the slip.
    expect(ingestUrlOf({ osUrl, convexUrl })).toBeNull();
  });

  test("with no Convex address behind it the pass-through answers 503, so nothing is shown", () => {
    expect(ingestUrlOf({ osUrl: "https://os.example.test" })).toBeNull();
    expect(ingestUrlOf({ osUrl: "https://os.example.test", convexUrl: "https://elsewhere.example.test" })).toBeNull();
  });

  test("the owner's domain is one the push scripts accept too", () => {
    expect(ingestUrlProblem(ingestUrlOf({ osUrl: "https://os.example.com", convexUrl })!)).toBeNull();
  });
});

describe("ingestAddressAllowed", () => {
  const os = "https://os.example.test";

  test("the public origin's /ingest/v1, a *.convex.site one, or this machine", () => {
    expect(ingestAddressAllowed("https://os.example.test/ingest/v1", os)).toBe(true);
    expect(ingestAddressAllowed("https://made-up-animal-123.convex.site/ingest/v1", os)).toBe(true);
    expect(ingestAddressAllowed("https://made-up-animal-123.convex.site/ingest/v1")).toBe(true);
    expect(ingestAddressAllowed("http://127.0.0.1:3211/ingest/v1")).toBe(true);
  });

  test.each([
    ["the public origin when none is configured", "https://os.example.test/ingest/v1", undefined],
    ["another https address", "https://elsewhere.example.test/ingest/v1", os],
    ["a host that starts like the public origin", "https://os.example.test.evil.test/ingest/v1", os],
    ["a subdomain of it", "https://a.os.example.test/ingest/v1", os],
    ["another port on it", "https://os.example.test:8443/ingest/v1", os],
    ["plain http to it", "http://os.example.test/ingest/v1", os],
    ["credentials on it", "https://user:pass@os.example.test/ingest/v1", os],
    ["another path on it", "https://os.example.test/standup/v1/open", os],
    ["a longer path on it", "https://os.example.test/ingest/v1/more", os],
    ["a query on it", "https://os.example.test/ingest/v1?to=elsewhere", os],
    ["a public origin that is not one", "https://os.example.test/ingest/v1", "http://os.example.test"],
    ["not a URL", "os.example.test/ingest/v1", os],
  ])("%s is refused", (_what, address, osUrl) => {
    expect(ingestAddressAllowed(address, osUrl)).toBe(false);
  });
});

describe("mcpUrlOf: where the owner's Claude is pointed", () => {
  const convexUrl = "https://made-up-animal-123.convex.cloud";

  test("the deployment's own /mcp/v1, by the rules the ingest address is held to", () => {
    expect(mcpUrlOf({ convexUrl })).toBe("https://made-up-animal-123.convex.site/mcp/v1");
    expect(mcpUrlOf({ siteUrl: "https://other-animal-456.convex.site/anything/", convexUrl })).toBe(
      "https://made-up-animal-123.convex.site/mcp/v1",
    );
    expect(mcpUrlOf({ convexUrl: "http://127.0.0.1:3210" })).toBe("http://127.0.0.1:3211/mcp/v1");
  });

  test("the app's public origin is preferred where one is configured", () => {
    expect(mcpUrlOf({ osUrl: "https://os.example.test/", convexUrl })).toBe(
      "https://os.example.test/mcp/v1",
    );
  });

  test.each([
    ["nothing configured", {}],
    ["a Convex address that is not one", { convexUrl: "https://elsewhere.example.test" }],
    ["plain http to a deployment", { siteUrl: "http://made-up-animal-123.convex.site" }],
    ["credentials in the address", { siteUrl: "https://user:pass@made-up-animal-123.convex.site" }],
    ["a public origin with no deployment behind it", { osUrl: "https://os.example.test" }],
    ["a public origin that is not https", { osUrl: "http://os.example.test", convexUrl }],
    ["a public origin with a path", { osUrl: "https://os.example.test/app", convexUrl }],
    ["a public origin with credentials", { osUrl: "https://user:pass@os.example.test", convexUrl }],
  ])("%s gives no address, rather than one a token should not be sent to", (_what, config) => {
    expect(mcpUrlOf(config)).toBeNull();
  });

  test("it is never the ingest address, and the ingest address is never this one", () => {
    const config = { osUrl: "https://os.example.test", convexUrl };
    expect(mcpUrlOf(config)).not.toBe(ingestUrlOf(config));
    expect(ingestAddressAllowed(mcpUrlOf(config)!, config.osUrl)).toBe(false);
  });
});
