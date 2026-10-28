# Your first week

Two checklists: one for the founder setting Startup OS up for a new company, and a shorter one
for a teammate who has just been invited. Tick them off as you go.

## For the founder

### Before you start (an hour, alone)

- [ ] Try it on your laptop first: `pnpm dev:local`, then `pnpm dev:signin` (the
      [README](../../README.md#try-it-on-your-laptop-in-five-minutes) says how). Click
      through every page with the made-up data, and sign in as `sales` and `engineer` to see
      what a teammate sees.
- [ ] Read [How it works](overview.md). Ten minutes.

### Day 1: set it up

Follow [the setup guide](../setup.md). In short:

- [ ] Put your company's name, logo and currency in `convex/lib/identity.ts`
      ([Make it yours](customize.md)).
- [ ] Create a Convex project and a Vercel project, and a Google sign-in client.
- [ ] Set your own Google address as the owner (`OWNER_EMAILS`). Until it is set, nobody can
      sign in at all.
- [ ] Deploy, open the app and sign in. You should land on Today.

Expect most pages to say *Not known yet* or *Not read yet* at this point. That is right: no
data has arrived. A missing number is never shown as zero.

### Day 2: invite the team

For each person, on **Settings › Team › Add a teammate**:

- [ ] Type their **Google account email** (the one they will sign in with).
- [ ] **Start from a role** (co-founder, sales, engineer, or one you named). This ticks its
      usual pages.
- [ ] Tick or untick pages. Give *Today* to anyone who will connect their own mail and
      calendar. Give the sensitive *Settings* and *Team* pages only if they will help run the
      app.
- [ ] Save. *"Nothing is sent to them."* Tell them yourself to sign in at your app's address
      with that Google account, and send them the [teammate checklist](#for-a-teammate-who-was-just-invited).

[Roles](roles.md) has what each role starts with.

### Day 3: connect your first sources

Start with the two or three that matter most. Each is optional. For each pulled source, set
its key in the Convex dashboard ([setup guide, section 6](../setup.md#6-environment-variables)),
then press *Run now* on **Settings › Sources**.

- [ ] **The bank** (Mercury): `MERCURY_API_TOKEN`, read only. Cash, money in and out, and so
      burn and runway.
- [ ] **Your MRR.** If no tool knows it, type it in on **Finance › Record a figure** once a
      month. (This needs the sensitive *Settings* page, which the owner has.)
- [ ] **Linear**, if you use it: `LINEAR_API_KEY`. The board's *Linear issues* tab.
- [ ] **GitHub:** list your organisations in `GITHUB_ORGS` (`convex/lib/features.ts`), set
      `INGEST_TOKEN_GITHUB`, and run `pnpm gather:github --send` daily on a machine you
      control ([setup guide, "Pushing data"](../setup.md#8-pushing-data)).
- [ ] **Your own mail and calendar:** Settings › Connections › Google (needs the extra Google
      settings in the setup guide).
- [ ] **Payroll and Costs:** type in this month's pay and your recurring costs. Finance's *All
      costs* and the budget fill from them.

Check **Settings › Sources** afterwards: each one should say *On time*.

### Day 4: set goals and targets

- [ ] On **Goals and targets**, write three to five goals for this quarter. For example:
      "Close the seed round", "Ten paying customers", "Ship the self-serve sign-up".
- [ ] Give each an owner and a due date. Set the status honestly: *on track*, *at risk* or
      *off track*.
- [ ] Set a **target** for the figures that matter, such as MRR per month.
- [ ] On the **Board**, add the first tasks for each goal and link each to its goal.

### Day 5: your first weekly review

There is no weekly review page yet; use this list (and keep it, for every Monday):

- [ ] **Today:** clear *Needs you* and **Approvals**.
- [ ] **Goals and targets:** go through each goal with the team. Change statuses.
- [ ] **Board:** move last week's finished cards to *Done*; agree on *This week*.
- [ ] **Finance:** cash, net burn, runway. Is every figure fresh?
- [ ] **Memory:** record any decision made this week, with the reason and a date to look
      at it again.

### Later, when you are ready

- [ ] Connect **Claude** to the app (Settings › Connections, or claude.ai's custom
      connector): [setup guide, section 9](../setup.md#9-connect-claude-the-mcp-server).
- [ ] Switch on the **built-in agents** on the Agents page, and decide where they run (your
      Mac, or Gemini).
- [ ] Add a **bot** for a job you repeat, on **Agents › Bots**, with only the pages it needs.
- [ ] Connect the **Telegram** bot so people hear about tasks assigned to them.

## For a teammate who was just invited

- [ ] Open the app's address and choose **Continue with Google**, with the Google account the
      owner added. (Another account sees *"This account does not have access"*: sign out and
      choose the right one.)
- [ ] Look at the sidebar: it lists only the pages the owner gave you. If a page you need is
      missing, ask the owner; nobody else can add it.
- [ ] If you have *Today*: go to **Settings › Connections**, make your own token and give
      your Claude the daily prompt, so your mail, calendar and notes appear on Today. Only you
      see them.
- [ ] Open the **Board** and find the cards assigned to you.
- [ ] Read [Roles](roles.md) for your role's suggested daily and weekly routine.
- [ ] Something should be different? Use **Suggest a change** at the bottom of the sidebar.
