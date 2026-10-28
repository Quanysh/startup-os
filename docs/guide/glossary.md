# Words the app uses

In alphabetical order. *Italics* are the app's own labels.

**Act scope.** A token or AI client that may *read and act*: propose and, where allowed, make
changes. The other scope is *read only*. Set on Settings › Connections.

**Agent.** An AI that works on the company's data on a schedule. Startup OS has four built in:
*chief of staff*, *engineering manager*, *sales and pipeline*, and *finance and compliance*.
Connected projects can report their own agents to the Agents page. See also *bot*.

**Agent token.** A secret an AI client (Claude Code, a script) uses to call the MCP server.
Made by the owner on Settings › Connections, shown once, and revocable at any time.

**Approval.** The owner's decision on a *proposal* or a paused tool call, on the Approvals
page: approve, edit then approve, or reject with a reason.

**Area.** The code's word for a page someone may be given (*finance*, *sales*, *board*…). The
Team page calls them pages. Every server function checks the caller's areas on every call.

**Benchmark band.** The range that is typical for a company at this stage, from a published
source with its year. A tile reads *Stronger than typical for seed*, *Typical for seed* or
*Weaker than typical for seed* against it.

**Board.** The task board: *Backlog* (not scheduled yet), *This week* (committed for this
week), *Doing* (in progress now) and *Done* (finished, newest first). Also the page (area) that
opens it.

**Bot.** An outside AI tool the owner has added on Agents › Bots, with its own permissions per
page, limits and rules. It calls the MCP server and, for anything that changes data, usually
proposes.

**Brief.** The chief-of-staff agent's short daily summary for the owner: at most eight lines per
company. On Today, hidden once it is more than 36 hours old.

**Bucket (period).** The day, week (from Monday, in UTC) or month (from the 1st) a stored figure
describes. Sending the same bucket again replaces the figure; it never adds to it.

**Burn (net burn).** Money going out less money coming in that is not financing (a loan or an
investment is not income), averaged over up to three finished months.

**Company switch.** The buttons at the top of the sidebar that pick which company the pages
show. Only with two companies.

**Connector.** A source the app reads itself on a schedule, such as the bank or Linear.

**Decision.** A record in Memory of what was decided, why, who owns it and when to look at it
again: *proposed*, *decided*, *revisit* or *reversed*.

**Draft.** A proposal that is only text, such as an investor update. Approving it keeps it for
you to copy. Nothing is ever sent.

**Earned autonomy.** After ten clean approvals of one simple kind of proposal (creating a task,
for example), the owner is offered to let that kind go through without a click. It can be
taken back from the *Decided* tab.

**Envelope.** The JSON document a script sends to `POST /ingest/v1`: its version, its source,
a batch id, when it was observed, and the rows (figures, deals, investors, contacts…). Strict:
an unknown field fails the whole envelope.

**Feature switch.** A setting in `convex/lib/features.ts` that adds or removes an optional part
of the app, such as a second company. All off as shipped. Something switched off answers
*"That is not part of this OS."*

**Focus.** What a role's Today page shows first: *founder*, *sales*, *engineering*,
*marketing*, *customers*, *finance* or *general*. It orders; it never grants.

**Freshness.** How current a figure is: *On time*, *Late* (past its expected interval), *Out of
date* (past twice that), *Failed*, *Not read yet*, or *Typed in*. Judged by the period the
figure describes, not by when it was written.

**Goal.** What the company means to do this quarter, in words, with a status: *on track*, *at
risk*, *off track* or *done*.

**Group.** Both companies added together, on Finance. Only with two companies.

**Handoff.** One bot asking another bot, or a person, to take over a piece of work: *open*,
*accepted*, *done*, *declined* or *closed*.

**Ingest.** The address that takes pushed data: `POST /ingest/v1`. Each source has its own
token (`INGEST_TOKEN_<SOURCE>`), and the token decides which source an envelope is for.

**Lens.** The view picker on Finance: *Group*, or one company. Only with two companies.

**MCP (Model Context Protocol).** A standard way for AI tools to use an app. Startup OS's MCP
server is at `/mcp/v1`; each bot also has its own address, `/mcp/v1/bot/<id>`.

**Meeting note.** A meeting's notes in Memory, with its action items. An action item can go
to the board with *Add to board*.

**Metric.** A number the app stores, declared once in the code with its unit, its period and
the one source allowed to write it.

**MRR (monthly recurring revenue).** What customers pay each month on an ongoing basis. As
shipped it is typed in on Finance › *Record a figure*; no tool computes it.

**Needs you.** Today's ranked list of everything waiting on you: late first, then today's,
then what is waiting, then what has gone quiet.

**One-company mode.** How the template ships: the app runs for one company, `"us"`. A second
company is the `secondCompany` switch.

**Outcome.** What came of something a bot tried on a deal, a customer, an investor or a
partner: *worked*, *failed* or *pending*. Shown on those records' pages.

**Owner.** The founder: the Google address (or addresses) in `OWNER_EMAILS`. Sees every page
and company; the only one who approves proposals and gives sensitive pages.

**Owner-only page.** A page no teammate can ever be given: Payroll, Costs, Approvals,
Assistant, and the owner's own connections.

**Permission request.** A bot asking for more access to a page. It waits on Approvals like a
proposal; approving it grants that access.

**Problem.** A board card that reports something broken, as opposed to a task.

**Proposal.** A change an agent or bot wants, waiting for the owner: what it would do, *why*,
the goal it serves, its urgency and its source. Open proposals expire after seven days.

**Role.** A label, a starting set of pages and a *focus*. Built in: co-founder, sales,
engineer; the owner can name more. It never grants anything by itself.

**Run now.** A button on Settings › Sources that starts a pulled source's sync at once.

**Runway.** How long the cash lasts: cash ÷ average net burn, in months. *Not burning* when
money in covers money out.

**Scope.** Whom a figure is about: the company, one company of two, or one product.

**Scorecard.** The company's numbers, against targets and benchmarks. Also the page (area) that
opens Today's company part and Goals.

**Sensitive page.** *Settings* and *Team*: only the owner can give them, one person at a time,
and no role includes them.

**Snapshot.** One stored value of a metric for one bucket.

**Source.** Every place a number can come from: *Manual entry* (typed in), a connector the app
reads, or a pushed source. Each number has exactly one.

**Suggest a change.** The link at the bottom of the sidebar: it puts a feedback card on the
board for whoever works on the app.

**Target.** The number you commit to for a scorecard figure, such as MRR of $50K a month. A
tile reads on or off target against it.

**Task (card).** An item on the board, in one column, optionally linked to a goal, with an
assignee and a due date.

**Teammate.** Anyone the owner adds on Settings › Team by Google address, with the pages and
companies the owner picks.

**Typed-in figure.** A figure with no system to read it from, entered on Finance › *Record a
figure* (needs the *settings* page).
