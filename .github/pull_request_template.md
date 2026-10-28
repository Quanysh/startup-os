## What changed, and why

<!-- Two or three sentences: what someone using Startup OS will notice, and the reason. Link the issue it closes ("Closes #123"). -->

## How it was checked

- Tests added or changed:
- Pages looked at locally (`pnpm dev:local`), and as which role (`pnpm dev:signin <role>`):
- Screenshots, if the change is visible (made-up data only):

## Before asking for review

- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass.
- [ ] No secret and no real data: no key or token, no real person, company, figure or address in the code, a test, a fixture, a screenshot or this description.
- [ ] A new function the browser can call is built with a gated builder (`memberQuery` / `memberMutation` / `ownerQuery` / `ownerMutation`), has its line in `SURFACE` in `convex/access.test.ts`, and keeps to the caller's companies.
- [ ] A missing number is shown as missing, never as zero.
- [ ] No name, address or other typed text goes into a log, a thrown error or a sync message.
- [ ] If this touches access, ingest, pay, personal data or the schema, the description says what and why.
- [ ] The docs (`docs/`, `README.md`) still say what the app does.

<!-- The full rules are in CLAUDE.md, and how to contribute is in CONTRIBUTING.md. Delete a line that does not apply rather than ticking it. -->
