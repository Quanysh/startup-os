import { defineConfig } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import convexPlugin from "@convex-dev/eslint-plugin";

export default defineConfig([
  {
    // The public template's overlay holds files that are checked inside the
    // export (`pnpm template:export`), not here.
    ignores: [".claude/**", "**/.next/**", "convex/_generated/**", "template/**"],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  ...convexPlugin.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    // Every public Convex function must go through one of the four gated
    // builders in convex/lib/owner.ts (memberQuery / memberMutation, ownerQuery
    // / ownerMutation). Importing the raw builders anywhere else would expose
    // a function to any signed-in session, or to nobody's check at all.
    // Every extension Convex's bundler deploys, not only .ts: a .tsx or .mjs
    // file under convex/ is published like any other.
    files: ["convex/**/*.{js,mjs,cjs,ts,tsx,mts,cts,jsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // With and without the extension: both resolve to the same file.
              group: ["**/_generated/server", "**/_generated/server.js"],
              importNames: ["query", "mutation", "action"],
              message:
                "Use memberQuery / memberMutation or ownerQuery / ownerMutation from convex/lib/owner.ts, or an internal* builder.",
            },
          ],
          // The untyped builders underneath the generated ones.
          paths: [
            {
              name: "convex/server",
              importNames: ["queryGeneric", "mutationGeneric", "actionGeneric"],
              message:
                "Use memberQuery / memberMutation or ownerQuery / ownerMutation from convex/lib/owner.ts, or an internal* builder.",
            },
          ],
        },
      ],
    },
  },
  {
    // The browser may import the generated API, plain shared code under
    // convex/lib, and the source manifest. It must never import a file that
    // defines Convex functions: that drags server code into the bundle.
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@convex/*",
                "!@convex/_generated",
                "!@convex/lib",
                "!@convex/connectors",
                "@convex/connectors/*",
                "!@convex/connectors/manifest",
              ],
              message:
                "Import only @convex/_generated, @convex/lib/* or @convex/connectors/manifest from the UI.",
            },
            {
              // The same files reached by a relative path instead of the alias.
              regex: "^(\\.\\./)+convex/",
              message: "Import Convex code through the @convex alias, which is checked.",
            },
            {
              // Server-only modules that happen to live under allowed folders.
              group: [
                "@convex/_generated/server",
                "@convex/lib/owner",
                "@convex/lib/teamDirectory",
                "@convex/lib/personal",
                "@convex/lib/snapshotWriter",
                "@convex/lib/pipelineWriter",
                "@convex/lib/pipelineOps",
                "@convex/lib/pipelineCards",
                "@convex/lib/pipelineFields",
                "@convex/lib/wonCustomers",
                "@convex/lib/partnerFields",
                "@convex/lib/memberOf",
                "@convex/lib/agentToken",
                "@convex/lib/mcpTools",
                "@convex/lib/agentStore",
                "@convex/lib/agentBuilt",
                "@convex/lib/agentStartupOsTools",
                // The model clients and the runner of Startup OS's own agents: a provider's key and its calls stay on the server.
                "@convex/lib/modelClients",
                "@convex/lib/agentRuntime",
                "@convex/lib/agentData",
                "@convex/lib/briefs",
                "@convex/lib/proposals",
                "@convex/lib/questions",
                "@convex/lib/chat",
                // Startup OS's own four agents: the text of docs/agents/, their seeding, and the Mac's runs.
                "@convex/lib/osAgentDocs",
                "@convex/lib/osAgentDefaults",
                "@convex/lib/osAgentRuns",
                // The bots' rules as stored, and what whoami reads of a caller's own client.
                "@convex/lib/botRuleVersions",
                "@convex/lib/whoami",
                // The bots' week and month, read from their daily rollup.
                "@convex/lib/botTelemetry",
              ],
              message: "This module only runs inside Convex.",
            },
          ],
        },
      ],
    },
  },
  {
    // The only files allowed to build ungated public functions: the wrappers
    // themselves and the non-throwing `viewer.me` the sign-in gate reads.
    files: ["convex/lib/owner.ts", "convex/viewer.ts"],
    rules: { "no-restricted-imports": "off" },
  },
]);
