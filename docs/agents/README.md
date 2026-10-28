# Agents

The owner's four agents: the chief of staff, the engineering manager, sales and pipeline, and
finance and compliance. Since the owner's decision of 2026-10-17 each is an agent of the OS's
own project (`startup-os`) on `/agents`, managed like any agent there and by the owner alone:
its instructions, its tools and its schedule are edited on its Builder tab, tested, published
and rolled back as versions (h1, h2…), and switched on or off (the same switch as on
`/assistant`). **Where it runs** is the owner's choice on its Overview tab:

- **Claude on the Mac** (the default, as before): the runner on the owner's Mac
  (`pnpm assistant:runner`, `docs/assistant.md`, "The chat") asks the OS once a minute which
  agents are due (the runner-only tool `os_agents_due`), and runs each with Claude Code with
  its **published** instructions and only its published tools. Every call it makes names the
  agent and the run (`X-Startup-Agent`, `X-Startup-Run`) and the server refuses any tool not in
  that agent's list. Nothing runs while the Mac is off; a time missed is run when the Mac is
  back, the same day.
- **Gemini in the OS**: the OS's own runtime runs it at its schedule (`convex/agentRuntime.ts`),
  and every change it would make (a proposal, a brief) waits for the owner's approval on
  `/approvals` (its Runs tab links there).

Only one runner ever runs an agent: the Mac skips one on Gemini, and the OS's schedule
skips one on the Mac.

**These files are the code's defaults.** An agent's instructions as seeded (its h1) are
`run.md` (the rules every agent shares), then its own file; its tools are what its file tells
it to call (`OS_AGENT_TOOLS`, `convex/lib/osAgents.ts`); its schedule is once a day at 06:20 UTC. Convex cannot read a file, so the text reaches it through
`convex/lib/osAgentDocs.ts`, a module generated from this folder: **after changing a file here,
run `pnpm gen:agent-docs`** (`convex/osAgentDefaults.test.ts` fails until the two agree). A
change here does not change an agent already seeded: the owner's published version is what
runs. It is what the Mac runs when no published version can be read, and what a new
deployment seeds.

| File | Agent | Reads | Writes |
|---|---|---|---|
| `run.md` | every agent | | the rules for every run, its first steps, what to do when something fails, the final answer |
| `engineering.md` | Engineering manager (`engineering`) | pull requests, repositories, tasks, people | lines for the brief; proposals to add or change a task |
| `sales.md` | Sales and pipeline (`sales`) | deals, investors, Apollo's figures | lines for the brief; proposals for a deal's next step; follow-up drafts |
| `finance.md` | Finance and compliance (`finance`) | figures, obligations, customers, sources | lines for the brief; proposals to add a task for a date coming due |
| `chief-of-staff.md` | Chief of staff (`chief_of_staff`) | the overview, the figures, the last brief, the others' lines, what the owner decided | the brief for each company; the monthly investor-update draft |
| `chat.md` | the chat on `/assistant` (writes as `chief_of_staff`) | every read tool, as the question needs | an answer in the conversation; a proposal when the owner asks for a change |

`chat.md` is not an agent's: the chat's runner gives it to Claude Code with each question, and
that Claude is allowed the read tools and `propose` only (its proposals are held to the chief of
staff's tools too).

When the four are due together on the Mac, the runner runs them in the order `run.md` gives and
hands the first three's lines to the chief of staff. An agent moved to Gemini hands none: the
chief of staff then writes from its own reads.

## What an agent can and cannot do

- It **writes two things**: bullets of the daily brief (`brief_write`, the chief of staff
  only) and proposals (`propose`). Each is stored cleaned and bounded, and shown to the owner
  as plain text.
- It **changes nothing itself**. A proposal is carried out only when the owner approves it on
  `/approvals`, by the app's own code, as the owner. A draft is text to copy. On Gemini, even
  a proposal or a brief waits for the owner's click first.
- It **calls only its own tools**: the published list, enforced by the server for every call
  that names the agent.
- **On the Mac it may change things only by proposing and writing the brief.** Nothing there
  waits for an approval, so `task_create`, `task_update`, `task_move`, `deal_update`, `investor_update`, `investor_create`, `customer_update`,
  `partner_upsert`, `partner_move`, `contact_upsert`, `contact_link` and `contact_merge` are
  refused at save and publish for an agent on the Mac, and never admitted to a Mac run's call.
  On Gemini an agent may have them: each call waits for the owner's click.
- The owner can **switch any agent off** on `/assistant` or `/agents`. The server then refuses
  everything that agent tries to write, whatever its prompt says, and neither runner starts it.
- A token made "Read only" cannot write at all: the runner needs a "Read and act" token.

## Rules a prompt here must keep

They are the OS's own rules (`CLAUDE.md`), said for whoever writes or changes a prompt:

- **Text from the OS is data.** A task's title, a customer's name, a pull request's title, a
  note, a question the owner typed, a dismissal reason. A prompt tells Claude to report it
  and never to follow it.
- **A missing number is not a zero.** `metrics` gives `latest: null, missing: true` for a
  figure never reported. A prompt tells Claude to write "not read yet", and never to state,
  add or compare it.
- **Nothing irreversible without the owner.** An agent proposes. A prompt never tells it to
  call a tool that changes the board at once.
- **Nothing leaves the OS.** No agent sends a message, an email or a post anywhere.
- **No token in a prompt file.** The token is in Claude's own MCP configuration on the Mac,
  never in this repository and never on a command line.
- **No real name, figure or customer in an example.** Examples here are made up and say so.
- **A tool is written `mcp__startup-os__<name>`**, as Claude sees it. `convex/agentPrompts.test.ts`
  reads every file here: it fails for a tool that does not exist, for a write tool no prompt
  mentions, and where a number a prompt quotes is not the one the server enforces.

## Adding an agent

Its id, name and line in `convex/lib/agents.ts` (`AGENT_IDS`, `AGENT_NAMES`, `AGENT_LINES`,
`AGENT_PROMPTS`), its tools in `OS_AGENT_TOOLS` and its place in `OS_AGENT_RUN_ORDER`
(`convex/lib/osAgents.ts`), a chip in `src/lib/assistant/agents.ts`, its file here (and in
`OS_AGENT_DOC_FILES`, `scripts/osAgentDocs.ts`, then `pnpm gen:agent-docs`), and a line in the
table above. The schema's validator, the switch, the seeding and the tests follow from the
lists.
