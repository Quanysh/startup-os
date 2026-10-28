# Security policy

Startup OS holds bank balances, pay, investor data and people's email subjects. We take reports of
security problems seriously and thank everyone who makes one responsibly.

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a security problem.**

Report it privately through GitHub:

1. Open this repository on GitHub and go to the **Security** tab.
2. Choose **Report a vulnerability**. This opens a private security advisory that only the
   maintainers can see.
3. Describe the problem, the steps to reproduce it, what an attacker could do with it, and the
   version (commit) you tested. Use made-up data in your example, never a real person's.

We aim to answer within seven days. We will tell you how the fix is going, agree with you when
it is published, and credit you in the advisory unless you prefer otherwise.

## What is in scope

Anything in this repository, in particular:

- getting past the access checks: reading a page or a company's rows you were not given,
  signing in without being on the team, a teammate widening their own access;
- reading or changing data through the ingest endpoint (`/ingest/v1`) or the MCP server
  (`/mcp/v1`) without the right token, or beyond a token's scope;
- a token, key or other secret appearing in a log, an error, a page or an answer;
- one person's own mail, calendar or notes reaching anyone else;
- payroll reaching anyone but the owner, or any token;
- an AI agent or bot changing data without the owner's approval where it should need it;
- injection, cross-site scripting or request forgery in the app.

Out of scope: problems in Convex, Vercel, Google or other services themselves (report those to
them), attacks that need the owner's own unlocked computer, and findings from automated scanners
without a way to exploit them.

## Supported versions

Only the latest commit on `main` gets security fixes. If you run a copy, keep it up to date by
merging this repository's `main` into yours.

## If you run your own copy

Your deployment is yours to secure. Keep secrets in the Convex and Vercel dashboards, never in
a file you commit; keep `OWNER_EMAILS` to the owner's own addresses; revoke AI-client tokens you
no longer use on Settings › Connections. If you publish your copy on GitHub, turn on **private
vulnerability reporting** in the repository's settings (Security › Private vulnerability
reporting) so people can reach you the same way.
