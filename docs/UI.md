# The FullDots interface

A short map of the parts of the chat that are not plain messages. Colours come from `src/client/tokens.css` and follow the light or dark theme, while each Dot keeps its own penguin and colour everywhere it appears (see [the brand notes](brand/README.md#the-dot) for its states).

## In a chat

- **Group chat.** Several Dots can answer in one chat; each reply carries its Dot's character and colour, and `@Name` addresses one Dot. See [TEAMS.md](TEAMS.md#group-chats).
- **Work band.** Where a Dot handed work to teammates, one lane per teammate shows its state, step, latest lines, time and tokens, live. Lanes fold into result chips when the work comes back; the teammates' results show as cards, and the lead's answer says what it was built from. See [TEAMS.md](TEAMS.md#watching-teammates-work).
- **Owner cards.** Approvals and computer takeovers show as cards where the Dot asked. See [APPROVALS.md](APPROVALS.md).
- **Computer activity.** A turn's computer and connector steps fold into one compact block before the reply; the live screen is in the side panel. See [COMPUTERS.md](COMPUTERS.md).

## In the sidebar

- **Dots, and only Dots.** Under each name: what the Dot is doing right now (**Working**, its computer step such as **Searching the web** or **Opening website**, **Needs you**, **Paused**), or its role while it is idle. An amber count marks a Dot with approvals, hand-offs or questions waiting for you; amber always means "waiting for you", on the Inbox badge too.
- **Each Dot's chats** sit behind the arrow beside it, closed until you open them; the sidebar remembers which you opened. **New chat with …** comes first, then the chats newest first with the time of their last activity, the latest eight and **Show more** for the rest. A teammate's chat also sits under the chat that handed the work over, and a pulse marks chats with work running.
- **The footer** has Search everywhere (Ctrl+K), Inbox, Mission control, Spaces, Teams, Scheduled and activity, and Memories as icons, then **Settings** and **Apps**. Apps shows the logos of a few apps you can connect (Gmail, Google Calendar, GitHub, Notion) and opens Settings → Connectors. Spaces and Teams open a panel above the footer with their pages, files and teams; Escape closes it.
- **The computer panel** is on the right. It opens on wide windows until you close it with ✕ or the **Computer** button in the top bar, and FullDots remembers your choice. It shows the computer of the Dot you are chatting with. On narrower windows it slides over the chat, and on a phone the sidebar is a drawer behind the menu button.

## Themes

FullDots follows the operating system by default and can be pinned to Light or Dark in **Settings → General → Appearance**. The choice is saved per browser (`fulldots-theme` in `localStorage`) and is applied before the first paint, so a dark screen never flashes light.

All colour lives in `src/client/tokens.css` as custom properties. `:root` holds the light palette and `[data-theme='dark']` on `<html>` overrides the same names; components only ever read the names. `src/client/theme.ts` resolves and applies the theme, and `tests/theme.test.ts` keeps the two palettes in step and checks text contrast against WCAG AA. Before the app loads, `public/theme-init.js` applies the saved theme from the `<head>` of `index.html`. It is a separate file because the server's Content-Security-Policy blocks inline scripts, and the same test checks that it resolves the theme exactly as `theme.ts` does.

## Motion and access

Every animation has a reduced-motion fallback (enforced by `tests/reduced-motion.test.ts`), and every state shown by colour or motion is also written in words. Interactive parts are reachable by keyboard; the work lanes add Enter, S and A on a focused lane.
