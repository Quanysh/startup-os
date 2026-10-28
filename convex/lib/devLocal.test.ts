import { describe, expect, test } from "vitest";
import {
  LOCAL_OWNER_EMAIL,
  NOT_LOCAL,
  isLocalDeployment,
  isLocalUrl,
  localEmail,
  localRefusal,
} from "./devLocal";

describe("a URL that is this machine's own", () => {
  test.each([
    "http://127.0.0.1:3210",
    "http://127.0.0.1:3211/",
    "http://localhost:3210",
    "http://LOCALHOST:3100/some/path",
    "http://127.0.0.1",
  ])("%s is local", (url) => {
    expect(isLocalUrl(url)).toBe(true);
  });

  // Cloud deployments, and everything dressed up to look local.
  test.each([
    "https://happy-animal-123.convex.cloud",
    "https://happy-animal-123.convex.site",
    "https://happy-animal-123.eu-west-1.convex.cloud",
    "https://api.convex.dev",
    "https://127.0.0.1:3210",
    "https://localhost:3210",
    "http://127.0.0.1.example.com:3210",
    "http://localhost.example.com",
    "http://example.com/127.0.0.1",
    "http://example.com/?host=localhost",
    "http://127.0.0.1@example.com",
    "http://localhost:3210@happy-animal-123.convex.cloud",
    "http://user:pass@127.0.0.1:3210",
    "http://127.0.0.2:3210",
    "http://0.0.0.0:3210",
    "http://[::1]:3210",
    "http://192.168.1.10:3210",
    "http://mylocalhost:3210",
    "ws://127.0.0.1:3210",
    "127.0.0.1:3210",
    "localhost",
    "",
    "not a url",
  ])("%s is not", (url) => {
    expect(isLocalUrl(url)).toBe(false);
  });

  test("nothing at all is not local", () => {
    expect(isLocalUrl(undefined)).toBe(false);
    expect(isLocalUrl(null)).toBe(false);
  });
});

describe("a deployment that runs on this machine", () => {
  test.each(["anonymous:anonymous-agent", "anonymous:anonymous-startup-os", "local:startup-os-1a2b"])(
    "%s is local",
    (name) => {
      expect(isLocalDeployment(name)).toBe(true);
    },
  );

  test.each([
    "dev:happy-animal-123",
    "prod:happy-animal-123",
    "preview:happy-animal-123",
    "happy-animal-123",
    "anonymous-agent",
    "anonymous:",
    "local:",
    "Anonymous:agent",
    " anonymous:agent",
    "prod:anonymous:agent",
    "dev:local:thing",
    "anonymous:agent prod:happy-animal-123",
    "anonymous:agent\nprod:happy-animal-123",
    "",
  ])("%j is not", (name) => {
    expect(isLocalDeployment(name)).toBe(false);
  });

  test("nothing at all is not local", () => {
    expect(isLocalDeployment(undefined)).toBe(false);
    expect(isLocalDeployment(null)).toBe(false);
  });
});

describe("where a development function may run", () => {
  const LOCAL = {
    cloudUrl: "http://127.0.0.1:3210",
    siteUrl: "http://127.0.0.1:3211",
    ownerEmails: LOCAL_OWNER_EMAIL,
  };

  test("on a local backend whose only owner is the made-up one", () => {
    expect(localRefusal(LOCAL)).toBeNull();
    expect(localRefusal({ ...LOCAL, ownerEmails: ` ${LOCAL_OWNER_EMAIL.toUpperCase()} ` })).toBeNull();
  });

  test.each([
    ["a cloud deployment", { cloudUrl: "https://happy-animal-123.convex.cloud", siteUrl: "https://happy-animal-123.convex.site" }],
    ["a cloud address behind a local-looking site", { cloudUrl: "https://happy-animal-123.convex.cloud" }],
    ["a cloud site behind a local-looking address", { siteUrl: "https://happy-animal-123.convex.site" }],
    ["no address at all", { cloudUrl: undefined, siteUrl: undefined }],
    ["a real owner", { ownerEmails: "someone@example.com" }],
    ["a real owner beside the made-up one", { ownerEmails: `${LOCAL_OWNER_EMAIL},someone@example.com` }],
    ["no owner", { ownerEmails: undefined }],
    ["an empty owner list", { ownerEmails: "  " }],
  ])("not on %s", (_name, change) => {
    expect(localRefusal({ ...LOCAL, ...change })).toBe(NOT_LOCAL);
  });

  test("a production deployment that somehow had the made-up owner is still refused", () => {
    expect(
      localRefusal({
        cloudUrl: "https://happy-animal-123.convex.cloud",
        siteUrl: "https://happy-animal-123.convex.site",
        ownerEmails: LOCAL_OWNER_EMAIL,
      }),
    ).toBe(NOT_LOCAL);
  });
});

describe("the made-up local people", () => {
  test("the owner is one address, whatever company is asked", () => {
    expect(localEmail("owner", "both")).toBe(LOCAL_OWNER_EMAIL);
    expect(localEmail("owner", "kz")).toBe(LOCAL_OWNER_EMAIL);
  });

  test("a teammate's says the role and the companies, on a reserved domain", () => {
    expect(localEmail("sales", "us")).toBe("sales.us@startup-os.test");
    expect(localEmail("cofounder", "both")).toBe("cofounder.both@startup-os.test");
    expect(LOCAL_OWNER_EMAIL.endsWith(".test")).toBe(true);
  });
});
