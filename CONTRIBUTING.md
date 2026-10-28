# Contributing to Startup OS

Thank you for helping. Startup OS is a template that founders copy to run their own company, so a
change here reaches every copy that updates. This page says how to make one that is easy to
accept.

You never need an account, a cloud deployment or a secret to work on it: everything runs on
your own machine with made-up data.

## Before you start

- **A bug?** Open an issue with the *Bug report* form. Say what you did, what you expected and
  what happened, with made-up data.
- **An idea?** Open an issue with the *Feature request* form first, before writing code, so we
  can agree it fits. Startup OS stays small on purpose.
- **A question?** Use the *Question* form, after a look at [the docs](docs/README.md).
- **A security problem?** Never in public. Follow [`SECURITY.md`](SECURITY.md).

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Get it running

You need [Node.js 20 or newer](https://nodejs.org) and [pnpm](https://pnpm.io/installation).
Fork the repository on GitHub, then:

```bash
git clone <your fork's URL> startup-os && cd startup-os
pnpm install
pnpm dev:local        # the app on http://localhost:3100, with made-up data
```

Leave that running. In a second terminal:

```bash
pnpm dev:signin                         # sign in as the owner (opens the browser)
pnpm dev:signin sales                   # or as a teammate: cofounder, sales, engineer, marketing, success
pnpm dev:seed                           # put the made-up data back as it was
```

- `pnpm dev:local` runs Convex's local backend (no account, no login) and Next.js. Stop it with
  Ctrl-C.
- There is no Google sign-in locally: `pnpm dev:signin` gives you a one-time link that signs
  the browser in as a made-up person.
- These commands refuse to run against anything but a backend on your own machine.

## Make the change

[`CLAUDE.md`](CLAUDE.md) is the rulebook: access, data, the UI, tests. Read it before changing
code; Claude Code reads it by itself. [Make it yours](docs/guide/customize.md) has step-by-step
recipes for a page, a data source and more.

1. **Branch** from `main` in your fork: `git switch -c short-name-of-the-change`.
2. **Test first.** Write the failing test, watch it fail, then make it pass.
3. **Small commits**, each one thing, each passing.
4. **Look at it in the browser**, as the role it is for (`pnpm dev:signin <role>`) and as one
   that should not have it.
5. **Check** before you push:

   ```bash
   pnpm lint && pnpm typecheck && pnpm test && pnpm build
   ```

6. **Open a pull request** to `main`. The template asks what changed, how you checked it, and a
   few questions. The same checks run on GitHub.

## What gets a closer review

These parts decide who is let in, what comes in from outside, where salaries and people's
mail are kept, and what reaches an AI model. A change to them is welcome, but say in the pull
request what you changed and why, and expect more questions:

- access: `convex/lib/owner.ts`, `convex/lib/roles.ts`, `convex/lib/company.ts`,
  `convex/auth*.ts`, `convex/team.ts`, and the tests that hold them
  (`convex/access.test.ts`, `convex/publicSurface.test.ts`);
- what comes in: `convex/ingest*.ts`, `convex/http.ts`, `convex/mcp.ts`, `scripts/push*`;
- pay and personal data: `convex/payroll*.ts`, `convex/costs*.ts`, `convex/mirror.ts`,
  `convex/lib/personal*.ts`;
- the tables (`convex/schema.ts`), the local-only commands (`scripts/dev/`, `convex/dev*.ts`),
  and the rules and checks (`CLAUDE.md`, `.github/`, `eslint.config.mjs`).

`.github/CODEOWNERS` lists them for a copy that wants a named reviewer.

## What never goes in the repository

- **Secrets:** keys, tokens, passwords, any `.env` file but `.env.example`.
- **Real data:** a real person's, customer's or investor's name, email or address, or a real
  company's figures.

Everything in a test, a fixture, the seed, a screenshot and a pull request is made up, and
looks it: "Maple Street Clinic", "Ada Example", `someone@example.test`.

## Licence

Startup OS is under the [GNU Affero General Public License v3.0](LICENSE). By opening a pull
request you agree that your contribution is licensed the same way.
