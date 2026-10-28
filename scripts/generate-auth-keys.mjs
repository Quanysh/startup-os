// Generates the signing keys Convex Auth needs (JWT_PRIVATE_KEY and JWKS).
//
//   node scripts/generate-auth-keys.mjs            print both, to paste yourself
//   node scripts/generate-auth-keys.mjs --set      set them on the dev deployment
//   node scripts/generate-auth-keys.mjs --set --prod   ... on production
//
// With --set the values go straight to `npx convex env set` and are never
// printed. Run once per deployment; running again signs everyone out.

import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const values = {
  // Convex env values are single-line: newlines in the PEM become spaces.
  JWT_PRIVATE_KEY: pem.trimEnd().replace(/\n/g, " "),
  JWKS: JSON.stringify({
    keys: [{ use: "sig", alg: "RS256", ...publicKey.export({ format: "jwk" }) }],
  }),
};

const args = process.argv.slice(2);
if (!args.includes("--set")) {
  for (const [name, value] of Object.entries(values)) {
    process.stdout.write(`${name}=${JSON.stringify(value)}\n\n`);
  }
  process.exit(0);
}

const target = args.includes("--prod") ? ["--prod"] : [];
for (const [name, value] of Object.entries(values)) {
  // `--` stops the CLI reading the PEM's leading dashes as a flag.
  const result = spawnSync("npx", ["convex", "env", "set", ...target, name, "--", value], {
    stdio: ["ignore", "ignore", "inherit"],
    env: process.env,
  });
  if (result.status !== 0) {
    console.error(`Failed to set ${name}.`);
    process.exit(result.status ?? 1);
  }
  console.log(`Set ${name}.`);
}
