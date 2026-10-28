import { vi } from "vitest";

// Every test runs as the made-up deployment of convex/lib/deployment.kit.ts
// (vitest's `setupFiles`): every switch of convex/lib/features.ts on and
// made-up outside ids, whatever the deployment's own file says. So the suite
// tests the code of every feature and depends on no real id, and passes the
// same in main (every switch on) and in the public template (every switch
// off, placeholder ids). A test that is about a switch mocks the module
// itself, which wins over this; what a deployment's values are is pinned in
// convex/lib/deployment.test.ts, which reads the real module.
vi.mock("./lib/features", async (importOriginal) => {
  const real = await importOriginal<typeof import("./lib/features")>();
  const { MADE_UP_DEPLOYMENT, allSwitchesOn } = await import("./lib/deployment.kit");
  return { ...real, ...MADE_UP_DEPLOYMENT, FEATURES: allSwitchesOn(real.FEATURES) };
});
