# The FullDots interface

A short map of the parts of the chat that are not plain messages. Light theme only; colours come from `src/client/tokens.css`, and each Dot keeps its own penguin and colour everywhere it appears (see [the brand notes](brand/README.md#the-dot) for its states).

## In a chat

- **Group chat.** Several Dots can answer in one chat; each reply carries its Dot's character and colour, and `@Name` addresses one Dot. See [TEAMS.md](TEAMS.md#group-chats).
- **Work band.** Where a Dot handed work to teammates, one lane per teammate shows its state, step, latest lines, time and tokens, live. Lanes fold into result chips when the work comes back; the teammates' results show as cards, and the lead's answer says what it was built from. See [TEAMS.md](TEAMS.md#watching-teammates-work).
- **Owner cards.** Approvals and computer takeovers show as cards where the Dot asked. See [APPROVALS.md](APPROVALS.md).
- **Computer activity.** A turn's computer and connector steps fold into one compact block before the reply; the live screen is in the side panel. See [COMPUTERS.md](COMPUTERS.md).

## In the sidebar

- **Dots** with what each is doing right now (**Working**, **Needs you**, **Paused**).
- **Chats** by recency, with teammates' chats nested under the chat that handed the work over, and a pulse on chats with work running.

## Motion and access

Every animation has a reduced-motion fallback (enforced by `tests/reduced-motion.test.ts`), and every state shown by colour or motion is also written in words. Interactive parts are reachable by keyboard; the work lanes add Enter, S and A on a focused lane.
