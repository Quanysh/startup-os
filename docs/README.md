# Startup OS documentation

Start with the guide if you will use the app; start with the setup guide if you will run it.

## For the team: using Startup OS

| Document | Read it when |
|---|---|
| [How it works](guide/overview.md) | First. The core ideas in plain words: the scorecard, goals, the week, who sees what, where data comes from, and AI that only proposes. |
| [A tour of every page](guide/tour.md) | You want to know what a page is for and what fills it. |
| [Roles: who sees what](guide/roles.md) | You are deciding what to give a teammate, or want a daily and weekly routine. |
| [Your first week](guide/first-week.md) | You are setting the app up for a new company, or were just invited. |
| [Questions](guide/faq.md) | You have one. |
| [Words the app uses](guide/glossary.md) | A word on a page is unclear. |
| [When something goes wrong](guide/troubleshooting.md) | Sign-in fails, a page is empty, a deploy refuses. |

## For whoever runs it: setting it up and changing it

| Document | What it covers |
|---|---|
| [Setting up your own Startup OS](setup.md) | From a fresh copy to a running deployment: Convex, Google sign-in, Vercel, every setting, pushing data, connecting Claude. |
| [Make it yours](guide/customize.md) | Name, logo, colours, currency, features, a second company, a new page, a new data source, a bot. |
| [Pushing data to the OS](ingest.md) | The `POST /ingest/v1` contract: every envelope, with examples. |
| [The Assistant and the MCP server](assistant.md) | How Claude and bots connect, the tools, the limits, bots and their permissions. |
| [The agents protocol](agents-protocol.md) | How another project reports its AI agents to the Agents page. |
| [The built-in agents' instructions](agents/README.md) | What each of the four agents is told, and how to change it. |
| [`CLAUDE.md`](../CLAUDE.md) | The rulebook for changing the code: access, data, the UI, tests. |

## For contributors

- [`CONTRIBUTING.md`](../CONTRIBUTING.md): how to propose a change.
- [`SECURITY.md`](../SECURITY.md): how to report a vulnerability, privately.
- [`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md): how we treat each other.
