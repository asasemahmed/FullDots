# Teams of Dots

A Dot can hand part of a task to a teammate whose role fits it better. For example, a lead Dot hands research to Scout, Scout hands the writing to Writer, and the result comes back to the conversation where you asked.

## Set up a team

Open a Dot's settings (its menu in the sidebar, **Edit Dot**) and tick the Dots it may hand work to under **Can hand work to**. A Dot with no teammates never sees the hand-off tools. A Dot that leads a [named team](#named-teams) may also hand work to that team's members.

## How a hand-off works

1. **The Dot hands work over.** It calls `delegate_to_dot` with the teammate's name, a self-contained brief and the deliverable it needs. The teammate does not see the original conversation, so the brief must carry the context.
2. **The teammate starts.** FullDots creates a new conversation for the teammate, titled "_Lead_ → _Teammate_: _first line of the brief_", and runs the work there as a background task, usually within a fraction of a second. You can open that conversation in the sidebar and watch it.
3. **The teammate works with its own settings.** It uses its own model, connectors, computer permissions, approval mode and token budget. Nothing is inherited from the Dot that asked.
4. **The teammate replies with the deliverable.** Its brief asks for the deliverable only: no preamble, no plan, no "I am ready".
5. **The result comes back.** When the teammate finishes, its final answer is posted to the original conversation as a new turn labelled **Delegated work**. The Dot that asked continues from there. If the teammate fails, that Dot is told why and decides what to do next.

A Dot can also call `check_delegation` to see whether handed work is still running.

## Several hand-offs at once

When a Dot hands work to several teammates in one turn, they work in parallel (up to `BACKGROUND_CONCURRENCY` at once, one turn per Dot) and their results come back together in **one** turn, with a section per teammate, including the ones that failed. The results wait for each other for at most `TEAM_RESULT_BATCH_MS` (1.5 seconds) after the first one arrived; what has arrived by then goes back together, and a result that arrives later gets a turn of its own. Waiting results are stored, so a restart neither loses nor repeats them.

The lead's reply starts as soon as its conversation is free: the end of any turn in that conversation, or of any turn of that Dot, retries the waiting results at once instead of on the 30 second safety sweep.

Each hand-off records when the teammate started (`startedAt`) and when its result reached the Dot that asked (`deliveredAt`); both are in `GET /api/conversations/:id/delegations`.

## Watching teammates work

Where a Dot hands work over, the chat shows a **work band**: one lane per teammate, in the teammate's colour. A small packet in the lead's colour flies to each lane as the work is handed over.

Each lane shows the teammate's character, its name, the first line of the brief (**Whole brief** opens the rest), what it is doing right now ("Opening website", "Using github", "Thinking"), the last two lines it wrote, how long it has worked and how many tokens it used. Every state is written out as well as shown:

| Lane says                                | Meaning                                                                                              |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Queued                                   | The hand-off waits for a free background slot.                                                       |
| Working, or the current step             | The teammate is working on it.                                                                       |
| Waiting: _Scout_ is busy in another chat | The teammate finishes a turn elsewhere first. Nothing there is interrupted.                          |
| Waiting: daily budget reached            | The teammate spent its token budget for today (UTC).                                                 |
| Waiting: _Scout_ is paused               | Resume the Dot to let it start.                                                                      |
| Waiting for your approval                | The approval card is in the lane: approve or deny it there.                                          |
| Your turn on the computer                | **Take over** opens the teammate's chat and its computer.                                            |
| Failed                                   | The error, with **Try again** (the same brief to the same teammate, as a new hand-off) and **Skip**. |
| Stopped by you                           | You stopped it. **Try again** is offered here too.                                                   |

A teammate that stops to wait for you (an approval, a takeover, a question) does not report back yet: its result is the reply it gives after you answered.

**Watching the chat itself.** The chevron on a lane opens the teammate's chat inside the lane and streams it live; **Open chat** goes to it. At most two lanes stream at once (opening a third closes the oldest), so the browser keeps connections free for the rest of the app.

**Stopping.** **Stop** on a lane, or **Stop everything** in the chat header, cancels the hand-off and anything it handed on. A teammate's turn is stopped only when it runs in that hand-off's own chat: a Dot that is busy in another chat keeps going there. The lead hears which work you stopped, together with the results that still come back, and is told not to redo it unless you ask.

**When the results return** the band folds into one chip per teammate (**Show the work** opens it again), the **Delegated work** turn shows a card per teammate with a summary and **Show full result**, and the lead's combined answer below it says which teammates it was **Built from**.

**Sidebar.** A teammate's chat sits under the chat that handed the work over (the arrow folds it), with the teammate's character. A small pulse marks any chat with work running in it or under it, and each Dot row says whether the Dot is **Working** or **Needs you**.

**Keyboard and screen readers.** Each lane is a focusable group named after its teammate and its state. On a focused lane, Enter opens or closes its chat, S stops it, and A moves to its approval buttons. Lane changes are announced politely, at most once every two seconds per lane. With reduced motion the packet, the pulses and the bobbing are off and every change is instant, still in words.

The lanes read `GET /api/conversations/:id/delegations/progress` (owner only) and fetch it again when the live feed reports a change for the chat or its teammates' chats, and every 1.5 seconds while a teammate works. The other lane routes are `POST /api/conversations/:id/delegations/stop`, `POST /api/delegations/:id/stop`, `POST /api/delegations/:id/retry` and `GET /api/delegations/:id` (the whole result).

## Time limit

A teammate's turn on handed-over work may take `DELEGATION_TIMEOUT` seconds (default 300) instead of the usual `AGENT_TURN_TIMEOUT` (90 seconds plus grace). Shortly before the limit it is asked to wrap up; at the limit it stops and the Dot that asked receives what it has, with a note that it ran out of time. Other turns keep their usual limits.

## Speed check

`npm run bench:team` (or `node --import tsx scripts/team-bench.ts [iterations]`) runs hand-offs on a temporary database with an instant fake model and prints p50 and p95 for: hand-off to teammate start, last result to the lead's reply, the start spread of three teammates, and live event delivery. It needs no model key and is not part of the test suite.

## Limits

- **Depth:** hand-offs chain at most `TEAM_MAX_DEPTH` levels (default 2). A Dot that is already two levels down does its part itself.
- **No loops:** a Dot cannot hand work back to a Dot above it in the same chain.
- **Per turn:** a turn can hand over at most three pieces of work.
- **Usual rules:** hand-off tasks wait like any other background work, for paused Dots, busy Dots, pending approvals and spent budgets.
- **Deleted conversation:** if you delete the conversation that asked, its running hand-offs are cancelled.
- **Try again:** one hand-off can be tried at most five times in all; after that, ask the lead to hand it over again.

## Group chats

A conversation can have more than one Dot. The Dot you started it with is its **host**; the others are **participants** you added. Every Dot in the chat sees the whole conversation and answers in it with its own character, name and colour.

- **Mention a Dot.** Type `@` in the message box to pick a Dot (arrow keys, Enter or Tab to insert, Escape to close), or type `@Name` yourself. A message without a mention goes to the host, as before.
- **Adding asks once.** Mentioning a Dot that is not in the chat yet asks "Add _Writer_ to this chat? It will see the whole conversation." Nothing is sent until you choose **Add**; **Cancel** keeps your message in the box. You can also add a Dot with **+** in the chat header, and remove a participant with the small cross on its picture there.
- **Several mentions.** `@Scout find the dates, @Writer draft the post` gives each mentioned Dot its own turn in this chat, one after another in the order you mentioned them. The queue lives in your open page: each Dot starts once the previous one finished, and closing the page drops the Dots still waiting. Your message is stored once per Dot and shown once ("Also to Writer").
- **One turn at a time.** A chat runs one turn at a time. While a Dot answers, Send is disabled; if a message still meets a running turn, the chat names the Dot that is answering and offers **Send again** or **Stop the other work and send**.
- **Passing the baton.** A Dot can pass the chat to another Dot in it with `hand_to_dot` (the host counts as a member too). The next Dot takes the following turn in the same chat with the whole history, and the chat shows "_Scout_ handed to _Writer_". A hand-off counts against the three hand-offs per turn shared with `delegate_to_dot`, and it follows the **Hand work to teammates** rule: under Ask me first you approve each pass first.
- **Relay cap.** At most `TEAM_RELAY_MAX` Dot turns (default 4) run in a row without a message from you: the turn your message started plus the passes after it, queued ones included. Beyond that the Dot is told to finish its reply and the chat waits for you.

Safety:

- Only **your** mentions start turns. `@Name` written by a Dot, returned by a tool or found on a web page is plain text and dispatches nothing; the only way for a Dot to involve another is the gated `hand_to_dot` tool, and only to Dots you added.
- The server refuses a turn for a Dot that is neither the host nor a participant on every path: the chat runtime, `POST /api/conversations/:id/turns`, headless turns and resume turns. A pass waiting for a Dot you removed is dropped.
- Each Dot keeps its own settings in the chat: model, approval mode, rules, pause, token budget and its one-turn-at-a-time lock. A message you address to a Dot counts as a chat message (`source: chat`), so approvals behave exactly as when you type to the host. A pass to a Dot over its daily budget waits like other background work.

API: `GET`/`POST /api/conversations/:id/participants` (`{ dotId }`, the confirm), `DELETE /api/conversations/:id/participants/:dotId`, `POST /api/conversations/:id/turns` (`{ text, dotId }`, answers 202 once the turn started; 403 for a Dot not in the chat, 409 while a turn runs), and `POST /api/conversations/:id/stop`. `/api/workspace` lists `participantIds` with each conversation.

## Named teams

A named team is a lead Dot plus up to eight members, with a name, an emoji, a colour, a work style and a mode. Teams live in the sidebar's **Teams** section, between Dots and Spaces: each row shows the team's emoji and name, its members' characters (lead first, a little larger) and a pulse while any of them is working. **+** opens the team builder; a row's menu has **Start team chat**, **Edit team** and **Archive team**. A team's page (`#/team/<id>`) shows who does what, how the team works, its recent chats and runs, and **Start team chat**.

### Building a team

In the builder, drag Dots from **Your Dots** onto the stage, or press their **Add** buttons (the keyboard and phone path). The first Dot becomes the lead and sits in the centre; members orbit it. In the member list each member has a role ("finds sources"), an order handle (focus it and use the arrow keys, Home and End), **Move up**/**Move down**, **Make lead** and **Remove**. On a phone the stage is hidden and the list is the whole picture. The builder checks what the server checks: a name not used by another active team, exactly one emoji, a colour from the Dot palette, a lead that is not also a member, no Dot twice, at least one and at most eight members.

The lead is not a member row: `teams.leadDotId` names it and `team_members.position` orders the members from 0.

### Who may hand work to whom

A Dot's teammates are now the Dots ticked for it under **Can hand work to** in its settings **plus** the members of every active team it leads. Nothing is stored or migrated: the team-given entries are computed each time and shown in the Dot dialog as locked rows ("via 🚀 Launch crew"); change them on the team. Members get **nothing** from a team: being on the same team does not let them hand work to each other or to the lead. Archiving the team takes the lead's team-given teammates away again. A Dot with two or more ticked teammates can press **Make a team from these teammates** to create a team it leads; the ticks stay as they are.

### Team chats and modes

**Start team chat** opens a new conversation bound to the team (`thread_bindings.teamId`) and hosted by the lead. A banner names the team, its mode and style.

- **Lead plans** (the default). You talk to the lead. Its instructions name the team, the members in order with their roles, and the style, and it gets one tool, `start_team_run({ briefs: { "<member name>": "<brief>" }, shared?: "<context>" })`. The server makes one step per member that got a brief (every member when only `shared` is given; `shared` is prepended to each brief) and runs them in the team's style. The lead may call it **once per turn**, only in a turn you started (a chat message, or the approval of one); the turn that brings the results back cannot start another run. It does not count against the three hand-offs per turn of `delegate_to_dot`, and it follows the **Hand work to teammates** rule: under Ask me first you approve the run, briefs in full, before anything starts.
- **Direct**. Your message goes straight to every member, with no lead model call (`POST /api/teams/:id/dispatch { threadId, text }`, which the chat uses for you). The chat stores your message with a short "Sent to …" line from the lead, and when every member has finished it posts one **Results** message with a section per member (stored as a turn of the lead, so it is replayed and attributed like any other reply). With **Lead summarises** on, the lead then adds one short summary turn.

### Work styles

- **All at once**: every step starts together, as many as `BACKGROUND_CONCURRENCY` allows; the rest queue.
- **Step by step**: steps run strictly in member order, whatever order the briefs came in; members without a brief are skipped; each member's brief carries the previous member's result. A step that fails ends the chain: the remaining steps are skipped and the lead hears what was done.
- **With a reviewer**: the members work at once, then the team's reviewer checks and improves their combined work before the lead hears back. See [The reviewer](#the-reviewer).

The lead hears back **once**, when the run ends: one resume turn with every result, a section per member, including the ones that failed or were skipped. Each Dot takes part at most once per run, and the lead is never a step. Every step is an ordinary hand-off (its own conversation "_Lead_ → _Member_: …", task, model, approvals, budget and `DELEGATION_TIMEOUT`); `delegations.origin` says `team` for a lead's run and `owner` for a direct message (`dot` for everything else). Depth and loop limits apply as for any hand-off.

### Runs, cancel and archive

Each run is a `team_runs` row (style, mode, status, created/finished/cancelled times) with one `team_run_steps` row per member (its delegation, position and status). `GET /api/teams/runs/:id` returns the run with each step's brief, conversation and timings; `POST /api/teams/runs/:id/cancel` stops it: every step's task is cancelled and the lead is not resumed. A member's turn is stopped at once only when it is running on that step's own conversation; the same member working in another chat is left alone. Deleting a team chat removes its runs and steps.

**Stop everything** in a team chat cancels its running team runs first (so no next step or review starts), then stops the chat's other hand-offs. **Stop** on one member's lane stops only that member, and its run moves on without it: in step by step the later steps are skipped; in a review run the reviewer checks what the others delivered.

Archiving a team keeps its Dots, its chats and its runs; it leaves the sidebar and stops granting its lead anything. A team whose lead Dot is removed is archived, not deleted, and a removed member leaves every team (Dots cannot be deleted yet; the store method is ready for when they can).

Mission control groups Dots under their teams; a Dot in several teams appears under each, and Dots in no team share a last group. Search finds active teams by name and description, the Ctrl+K palette offers **Start team chat with …** and **Create team**, and a saved prompt can belong to an active team.

### The reviewer

A team with the **With a reviewer** style names a reviewer Dot (the builder's **Who reviews** picker, `teams.reviewerDotId`). The reviewer is never the lead and never a member: each Dot takes part in a run once, and the reviewer looks at the members' work from outside. Adding the reviewer to the team as a member takes it off reviewing. It gets the team space like the members, but no right to hand work to anyone.

How a review run goes, all decided by the server (the same in **Lead plans** and **Direct** chats):

1. The members with a brief work at once, as in All at once. The reviewer's step waits.
2. When every member has finished, the reviewer gets their combined results (each member's result, and the owner's request when known) and is asked to **check and improve**: reply with the improved combined deliverable and a one-paragraph verdict that starts with **APPROVED** or **CHANGES**. Members that failed or were stopped are left out; if none delivered, the review is skipped.
3. **At most one send-back.** If the verdict is CHANGES, the members it names (a whole-word match on their names; all of them when it names none) get its notes and their first version and revise once. The reviewer then checks once more; whatever it says the second time, nothing is sent back again. A verdict that is neither APPROVED nor CHANGES counts as approved.
4. The lead resumes once with the **reviewed result** first and every member's **raw result** below it (marked "revised after the review" where a member revised). In a Direct chat the Results message shows "Checked by _Reviewer_" and the reviewed result above the members' sections.

Each step is recorded in `team_run_steps` with `role` `worker` or `reviewer`. A step that goes round again keeps its one row: `delegationId` is its newest hand-off and `firstDelegationId` its first. The run records `reviewerDotId`, the reviewer's latest `verdict` (`approved`, `changes` or `unclear`) and `sentBack`. A review team without a reviewer (for example because its reviewer Dot was removed) runs like All at once.

In the chat the members' lanes fold into "2 results, under review by _Critic_" while the reviewer's lane is full size, its character **reviewing**; the band then says **Sent back** while members revise, and **Checked by _Critic_** after the last check.

### Team run bands

A lead's `start_team_run` call draws its run's work band in the chat, with the same lanes as a hand-off: one per member in member order, each with its live state, Stop, approvals and chat. In **Step by step** the later steps wait in order ("Waits for _Scout_"), joined by a connector and numbered. A **Direct** chat stores its "Sent to …" line with the run's id, so the band appears right under it. When the run is done the band folds into result chips, and the result turn shows a card per member (and the reviewer). The band reads `runs` in `GET /api/conversations/:id/delegations/progress`: each run of the chat with its steps, roles, verdict and log page.

### Templates

**Start from a template** at the top of the builder (new teams only) offers four ready-made teams:

| Template       | Dots                                          | Style           |
| -------------- | --------------------------------------------- | --------------- |
| Launch crew    | Launch Lead; Marketer, Writer, Engineer       | All at once     |
| Research desk  | Research Lead; Scout, Analyst; Critic reviews | With a reviewer |
| Content studio | Content Lead; Writer, Editor                  | Step by step    |
| Support desk   | Support Lead; Triage, Responder               | All at once     |

Choosing one shows what it creates, a team name and **Create a team space** (on by default); **Create** calls `POST /api/teams/from-template { templateId, name?, space? }`. It creates each Dot with its name, instructions, colour, penguin and gear, web research on, note proposals off, approval mode **sensitive**, no computer access and **no connector grants**; then the team with its roles, style, mode (Lead plans) and reviewer; and, when asked, its Space. A taken name gets " 2", " 3", … (Dots, the team and the Space alike), so a template can be used again. Everything it creates is an ordinary Dot, team and Space: edit or archive them like any other. The templates live in `src/shared/team-templates.ts`.

### Team space

A team can have a home Space: **Create a team space** in the builder, or **Create space** on the team page (`POST /api/teams/:id/space`, or `space: true` on `POST /api/teams` and `PATCH /api/teams/:id`). It is named after the team and created once.

- **Every Dot on the team gets access**: the lead, the members and the reviewer. When the team changes, access follows: a Dot that joins gets it, a Dot that leaves loses it.
- **The team takes back only what it gave.** `team_space_grants` records each access the team added. A Dot that already had access (you ticked it by hand) has no grant row and keeps its access when it leaves; access you remove by hand is not given back by the team; access to a Space that is the Dot's default page destination, or that another team gave, is not removed. Archiving a team leaves its Space and access as they are.
- **Team chats save pages there by default.** A team chat, and a member's step chat of a team run, use the team space as the default page destination (the Dot's instructions, `create_space_page` without a `spaceId`, and **Save as page**), when that Dot has access. An open page keeps its own Space, and other chats keep the Dot's own default.

### Run log

With **Keep a run log** on (a team setting, `teams.runLog`, on by default; it only does something when the team has a space), every finished team run writes one page into the team's own Space, never anywhere else and without asking (the owner's decision). The page is titled "_Team_ run — 2026-10-13 14:05" (UTC) and holds:

- the team, style, mode, outcome and duration, and a link to the team chat;
- your request (the message the run answers);
- for a review run, the reviewer's verdict and the reviewed result;
- every member's deliverable (or what went wrong), with links to the member's chat, and to its first version when it revised.

The page names the team chat as its source. Runs you stop are not logged. The team page's **Recent runs** shows the verdict of review runs and a **Run log** link to each log page (`log: { spaceId, pageId }` on each run).

API: `GET /api/teams` (`?archived=1` for archived ones too; also lists the Dots working right now), `POST /api/teams` (`reviewerDotId`, `runLog` and `space` optional), `POST /api/teams/from-template`, `GET`/`PATCH /api/teams/:id`, `PUT /api/teams/:id/members` (`{ members: [{ dotId, role }] }` in order), `POST /api/teams/:id/space`, `POST /api/teams/:id/archive`, `POST /api/teams/:id/conversations`, `POST /api/teams/:id/dispatch`, `GET /api/teams/runs/:id`, `POST /api/teams/runs/:id/cancel`. `GET /api/dots/:id/team` also lists the team-given teammates as `implied`.

## Settings

| Variable                 | Default | Purpose                                                                  |
| ------------------------ | ------- | ------------------------------------------------------------------------ |
| `TEAM_MAX_DEPTH`         | 2       | How many hand-offs may chain (1 to 5).                                   |
| `DELEGATION_TIMEOUT`     | 300     | Seconds a teammate's turn on handed-over work may take (0 = no limit).   |
| `TEAM_RESULT_BATCH_MS`   | 1500    | Milliseconds one turn's results wait for each other (0 to 60000).        |
| `BACKGROUND_CONCURRENCY` | 4       | Background tasks, hand-offs included, running at once on different Dots. |
| `TEAM_RELAY_MAX`         | 4       | Dot turns in a row in a group chat without your message (1 to 20).       |
