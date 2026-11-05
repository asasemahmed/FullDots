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

## Accessibility

Interactive parts are reachable by keyboard; the work lanes add Enter, S and A on a focused lane. These conventions keep it that way:

- **Dialogs.** Every modal dialog (the Dot form, Settings, triggers, the team builder, notes, the command palette and the add-a-Dot confirm) uses `useModalDialog` from `src/client/useModalDialog.ts`. It moves focus in when the dialog opens (the first field, or the control the dialog names), keeps Tab and Shift+Tab inside it, skipping hidden, disabled and inert controls, closes on Escape and gives focus back to the control that opened it. A control inside that claims Escape (a list closing, say) prevents its default, and the dialog stays open. Give the dialog element `tabIndex={-1}` and spread the hook's `onKeyDown` on it. Pages inside Settings, such as a connector or a provider, are not dialogs: Escape goes back to the list and focus returns to the card. A menu item gives focus back to its menu button before it runs, so a dialog it opens returns focus there.
- **Names.** A button with only an icon has an `aria-label` that says what it does ("Close dialog", "Back to connectors"); the icon is `aria-hidden`. Cards put their status in their name ("GitHub, Not connected. Open details"). `tests/a11y-names.test.tsx` checks the source for unnamed buttons.
- **Status chips.** A status is always written in words, never colour alone. The chip on an open page (a connector, a provider) and the approval badge are `role="status"` regions, so a change such as Connecting… to Connected, or Waiting for you to Approved, is read out once. Gallery cards are not live regions, so a refresh does not read out every card. When answering an approval removes the focused button, focus moves to the card (in a chat) or the next waiting card (on the Approvals page), never straight onto another Approve.
- **Reduced motion.** With `prefers-reduced-motion: reduce`, a rule in `style.css` turns off every CSS animation and transition, and each stylesheet that animates also has its own fallback (`tests/reduced-motion.test.ts`). The Dot character is drawn by `penguin/live.ts`: it draws each state once, at rest, runs no animation loop, and settles at once when the setting changes while the page is open. Scrolling into view is instant instead of smooth.

## Install FullDots as an app

FullDots can be installed as a standalone app on phones and desktops. On a phone, choose **Add to Home Screen** from the browser menu. On a desktop browser, click the **Install** button in the address bar. The app opens in its own window with its own icon. It still needs your server running; there is no offline mode.
