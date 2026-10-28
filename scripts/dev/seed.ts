// pnpm dev:seed
//
// Reset the LOCAL backend to the made-up data set (convex/lib/devSeedData.ts):
// every table but the sign-in ones is emptied and filled again, so running it
// twice lands on the same state. Prints counts per table, never a row.
//
// It refuses to run unless this folder is set up for a local backend
// (scripts/dev/guard.ts), and the function it calls refuses again inside the
// backend (convex/devSeed.ts).

import { convex, requireLocalTarget, stop } from "./convexCli";
import { printCounts } from "./counts";

// Any argument at all is a mistake: this command has no options, and
// certainly none that names a deployment.
if (process.argv.length > 2) stop("pnpm dev:seed takes no arguments.");
const target = requireLocalTarget();
console.log(`Resetting the local backend at ${target.url} to the made-up data set…`);
// The made-up data is more than one call may read, so the tables are emptied
// in steps first; each says whether more is left.
for (let step = 0; ; step += 1) {
  if (step >= 50) stop("The local backend could not be emptied. Look at the output above.");
  const emptied = convex({ kind: "run", fn: "devSeed:run", args: { step: "empty" } }, target, { quiet: true });
  if (!emptied.ok) stop("The made-up data could not be written. Look at the output above.");
  if (!/"more":\s*1/.test(emptied.stdout)) break;
}
const seeded = convex({ kind: "run", fn: "devSeed:run", args: {} }, target);
if (!seeded.ok) stop("The made-up data could not be written. Look at the output above.");
printCounts(seeded.stdout);
