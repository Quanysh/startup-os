import { beforeEach } from "vitest";

// No test reaches the network (vitest's `setupFiles`): before each test,
// `fetch` is one that fails the call, so a test that forgot to stub it
// (`vi.stubGlobal("fetch", …)` with a fake) fails instead of calling a real
// provider with a real key. `vi.unstubAllGlobals()` puts this one back.

export const NETWORK_REFUSED = "A test reached for the network: stub fetch with a fake (vi.stubGlobal).";

const refuse = (() => Promise.reject(new Error(NETWORK_REFUSED))) as typeof fetch;

beforeEach(() => {
  globalThis.fetch = refuse;
});
