# Approvals

Approvals stop a Dot before an action that could be hard to undo. You decide on a card in the conversation, or in the Inbox. This page covers which actions pause, the rules you can set per Dot, how an approval applies, how a Dot resumes afterwards, and how handoffs work when a page needs a person. Connector grants are described in [Connectors](CONNECTORS.md).

## Approval modes

Set **Approvals** in the Dot form. The default is `sensitive`.

| Mode                  | Asks before                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sensitive` (default) | Sensitive actions: destructive shell commands, clicks and selections on sensitive elements, submitting forms that look sensitive, Enter presses in sensitive places, and connector tools marked destructive. |
| `writes`              | Everything in `sensitive`, plus anything that changes data: every shell command, file writes, creating or editing Space pages, connector tools that can change data, and every Enter key press.              |
| `off`                 | Nothing, except paying and deleting, connector tools you set to `ask`, and rules you set to Ask me first. Handoffs still apply. `deny` overrides and Never rules still refuse the action.                    |

In `sensitive` mode, the Dot does not ask before ordinary clicks, typing without submit, file writes, shell commands outside the destructive list, read-only connector tools, or connector tools that change data but are not marked destructive.

## How the checks decide (heuristic)

The checks are heuristics. They look at the tool name, the arguments, the names of elements in the latest page snapshot, and the shell command text. They are not a sandbox. They can be wrong in both directions, so read each action before you approve it.

### Shell commands

A command is destructive when one of its parts matches a family below. FullDots checks the whole command and each part split at `;`, `&&`, `||`, `|`, newlines, backticks and brackets. It ignores quoted text, and it removes leading words such as `env`, `nohup` and `time`. It also checks commands inside `$(...)` and backticks.

- `sudo`, `doas`
- `rm`, `rmdir`, `unlink`, `shred`, `truncate`, and every `mv`
- A truncating redirect, `>` or `>|`, to a file. Appending with `>>`, `2>&1` and redirects to `/dev/null` do not count.
- `git push`, `git reset --hard`, `git clean`
- `curl` or `wget` that sends data or uses a method other than GET, such as `-d`, `-F`, `-T`, `--data...`, `--upload-file`, `--post-data`, or `-X POST`
- `ssh`, `scp`, `sftp`, `rsync`
- `npm`, `pnpm` or `yarn publish`; `cargo`, `gem` or `twine` publish, push or upload
- `docker`, `systemctl`
- `chmod`, `chown`, `chgrp`
- `mkfs`, `dd`, `shutdown`, `reboot`, `halt`, `poweroff`, `kill`, `killall`, `pkill`
- `sed -i` (in-place edit) and `tee` without `-a`
- Windows shell commands: `del`, `erase`, `rd`, `move`, `format`, `taskkill`, `Remove-Item`, `Move-Item`, `Set-Content`, `Out-File`, `Stop-Process`

The check also looks inside shell wrappers (`sh`, `bash`, `zsh`, `dash`, `ksh`, `fish`, `pwsh`, `powershell` or `cmd` with `-c`, `-Command` or `/c`) and `eval`, and treats the quoted command as a command of its own. `xargs` followed by `rm`, `mv`, `chmod`, `chown`, `kill` or another destructive command counts, and so does `find` with `-delete`, `-exec`, `-execdir`, `-ok` or `-okdir`. When the wrapped command cannot be read (an empty or `$variable` argument, or PowerShell `-EncodedCommand`), it asks.

Commands outside this list are not checked in `sensitive` mode. `npm test`, `python script.py` or `node build.js` can still change files. `writes` mode asks about them.

### Names of buttons, links and fields

A name is sensitive when it contains one of these words, in any letter case: `send`, `submit`, `publish`, `post`, `buy`, `pay`, `order`, `checkout`, `delete`, `remove`, `confirm`, `transfer`. The match is a substring match, so "Postal code" and "Border" also match.

### Enter key and typing with submit

- **`writes` mode:** every Enter key press is asked about, because it can submit a form.
- **`sensitive` mode:** an Enter press is asked about when the focused element has a sensitive name, when the page shows a sensitive button, link or menu item, or when FullDots does not know what has focus. Modifier combinations such as Ctrl+Enter count as Enter.
- **Typing with `submit` set:** asked about when the field name is sensitive, or when the page shows a sensitive button, link or menu item. This rule is the same in both modes.

FullDots does not read the browser's focus. It assumes the focus is the element the Dot last clicked or typed into during the turn. It forgets that after a navigation.

### Connector tools

| Tool hint                        | `sensitive` mode | `writes` mode |
| -------------------------------- | ---------------- | ------------- |
| Marked destructive               | Asks             | Asks          |
| Not read-only (can change data)  | Does not ask     | Asks          |
| Read-only                        | Does not ask     | Does not ask  |
| Unknown (connector reconnecting) | Asks             | Asks          |

A per-tool override replaces these rules for that tool, and it is more specific than the [rules per Dot](#rules-per-dot). `allow` never asks, even for a destructive tool. `ask` asks in every mode, including `off`. `deny` refuses the tool in every mode, including `off`.

### Files and Space pages

Writing a file, creating a Space page and editing a Space page count as changes to data. They ask in `writes` mode only.

## Rules per Dot

The **Rules** section of the Dot form sets, for each kind of action, what the Dot does:

- **Inherit** (the default): follow the approval mode. The form shows what Inherit means under the mode you picked.
- **Allow**: run without asking, in every mode.
- **Ask me first**: ask, in every mode, including `off`.
- **Never**: refuse before anything runs. The Dot gets the same kind of refusal as a `deny` override, and no approval can unlock it.

**Spend money** and **Delete things** offer only Inherit, Ask me first and Never. Their Inherit asks in every mode, including `off`, so no setting lets a Dot pay or delete without your click. The API refuses `allow` for them.

Rules take effect at once, also in a turn that is already running, and also over an approval you already gave.

### The order of the checks

1. A connector per-tool `deny` refuses the tool.
2. A connector per-tool `ask` or `allow` decides for that tool (it is the most specific setting).
3. The rules per Dot. When an action falls under several categories, the strictest rule wins: Never, then Ask me first, then Allow. Inherit has no opinion, except for Spend money and Delete things, where it means Ask me first.
4. The approval mode.

### Categories

The categories are heuristics, with the same limits as the checks above. Connector tools only tell FullDots whether they are read-only or destructive, so for connector tools the categories for sending, paying, deleting and publishing come from words in the tool name (split at `_`, `-`, `.` and capital letters). A read-only connector tool gets no category from its name. Words match whole words in any letter case, so "Border" is not "order".

| Category (id)                            | Covers                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Send messages (`send_messages`)          | Page actions and connector tools named with `send`, `reply`, `forward`, `message`, `dm`, `sms`, `notify` or `invite`; the shell commands `mail`, `mailx` and `sendmail`.                                                                                                                                                                                        |
| Spend money (`spend_money`)              | Page actions and connector tools named with `buy`, `purchase`, `pay`, `payment`, `checkout`, `check out`, `order`, `transfer`, `donate`, `charge` or `refund`.                                                                                                                                                                                                  |
| Delete things (`delete_things`)          | Page actions and connector tools named with `delete`, `remove`, `destroy`, `erase`, `purge`, `trash`, `wipe` or `unlink`; connector tools marked destructive; the shell commands `rm`, `rmdir`, `unlink`, `shred`, `find -delete`, `find -exec rm`, `git clean`, `del`, `erase`, `rd` and `Remove-Item`.                                                        |
| Publish (`publish`)                      | Page actions and connector tools named with `publish`, `post`, `tweet`, `share` or `deploy`; the shell commands `git push`, `npm`/`pnpm`/`yarn publish`, `cargo`/`gem`/`twine` publish, push or upload, and `docker push`.                                                                                                                                      |
| Run shell commands (`run_shell`)         | Every `computer_exec` command.                                                                                                                                                                                                                                                                                                                                  |
| Write files (`write_files`)              | Writing a file on the Dot's computer, or saving a file in a Space (`save_space_file`, `copy_computer_file_to_space`).                                                                                                                                                                                                                                           |
| Create pages (`create_pages`)            | Creating a Space page.                                                                                                                                                                                                                                                                                                                                          |
| Edit pages (`edit_pages`)                | Editing a Space page.                                                                                                                                                                                                                                                                                                                                           |
| Risky clicks (`risky_clicks`)            | Every click, choice, typing with submit or Enter press that `sensitive` mode asks about (see [Names of buttons, links and fields](#names-of-buttons-links-and-fields)), whatever the Dot's mode.                                                                                                                                                                |
| Hand work to teammates (`hand_off_work`) | `delegate_to_dot`, `hand_to_dot` in group chats, and `start_team_run` in team chats. No approval mode asks about it, so teams stay fast by default. Under Ask me first the card's exact action is the brief and the deliverable (the note for the next Dot, or every brief of a team run), and the hand-off is created only after you approve that exact brief. |

For page actions, the words are read in the name of the element clicked, chosen or typed into, and for typing with submit and Enter presses also in the names of the sensitive buttons, links and menu items on the page, because Enter can reach them. A shell command is read the same way as for the destructive list: each part, inside `sh -c`, `eval` and `xargs`, with quoted text ignored. A wrapped command that cannot be read counts under Send messages, Delete things and Publish.

**Treat as.** In the Dot's connector list, each allowed tool has a **Treat as** choice. Pick a category to pin the tool to it: the tool then falls under that category only, and the name words and hints no longer count for it. **Automatic** goes back to the heuristics.

Passwords, two-factor codes and verification challenges are not a category. [Handoffs](#handoffs-when-you-take-over-the-computer) for them always apply, whatever the rules say.

## Intent binding

An approval covers one intent. The intent is made of four parts:

- **Tool:** for example `computer_click` or `computer_exec`.
- **Page:** the origin and path, such as `https://example.com/checkout`. Query strings and fragments are ignored, and a trailing slash does not matter.
- **Element:** its role and name. Letter case and extra spaces do not matter.
- **Arguments:** for clicks and typing, the text typed, the option chosen, the key pressed and whether Enter was sent. For a shell command, the full command text and its timeout.

These rules follow from that:

- A new reference after the page re-renders is fine. Refs and snapshot ids are not part of the intent.
- A different page path, a different element name or different text needs a new approval.
- An approval is single use, and only on the turn it resumes. The first matching action in that turn uses it. If that turn ends without using it, the approval lapses (shown as expired). An identical action later asks again.
- An approval applies only in the conversation where it was requested.
- A pending approval expires after `APPROVAL_TTL` (default 7 days), and you can no longer decide it.
- A click or typing action that uses a ref from an earlier turn, or a ref that was not on the page the Dot saw, never runs. The Dot gets the current page and must find the element again.
- A connector tool whose description is not available at that moment (for example while the connector reconnects) is treated as sensitive and asks.

## Requests from the Dot: `request_approval`

A Dot can ask for approval for an action that the checks did not catch. It calls `request_approval` with a summary and, optionally, an exact intent.

- **With an intent** (the tool, its arguments, and an element from the current page): approving covers that exact action once, under the same rules as above.
- **Summary only:** an advisory request. Approving records that you saw the summary. It does not allow any gated action. The next gated action still asks. The card shows "(advisory)".

## Deciding an approval

The approval card has two labelled parts:

- **Dot's description:** what the Dot says it is doing. The Dot wrote this, so it can be wrong.
- **Exact action:** what FullDots will run or type, such as the shell command or "type into textbox 'Notes' and press Enter". Long text is cut, with a link to show more. Check this part before you approve.

Text typed into a field with a secret-looking name, such as password, passcode, secret, PIN, CVV, card number, one-time or OTP, is shown as `[hidden]`.

Approve or deny, with an optional note of up to 1,000 characters. Pending approvals appear in the Inbox, which has a count in the sidebar and in the browser tab title, and on the card in the conversation.

## How a paused turn resumes

1. The Dot's action returns `pending_approval`. The turn stops. The Dot writes a short summary and makes no more tool calls. Other tool calls in the same reply do not run.
2. You approve or deny.
3. The Dot gets a new turn in the same conversation. It appears as an **Approval decision** entry.
   - **Approve:** the Dot is told to perform that exact action now. The matching action runs once.
   - **Deny:** the Dot is told not to perform the action. It receives your note if you wrote one.
4. If the conversation or the Dot is busy with another run, the decision is saved. The new turn starts when that run finishes. Saved decisions survive a server restart.

Scheduled tasks wait. A scheduled task in a conversation with a pending approval does not start until the approval is decided or expires. A scheduled task for a Dot that is waiting for a handoff does not start until the handoff is done or dismissed.

## Handoffs: when you take over the computer

A handoff pauses the Dot where a person has to act. The Dot does not type the secret, and it does not try to solve a challenge.

| Kind         | When it starts                                                                                                                                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `credential` | The Dot is about to type into a field named for a password, passcode, PIN, CVV or card number. It also starts when the Dot is about to type into a sign-in identifier field (named for an email, username, login, account, phone or identifier) on a page with a Sign in or Log in button. |
| `two_factor` | The Dot is about to type into a field named for a verification, authentication, 2FA, MFA, OTP, one-time or security code.                                                                                                                                                                  |
| `captcha`    | A verification challenge appears on the page after an action.                                                                                                                                                                                                                              |
| `other`      | The Dot calls `request_handoff` because it needs you for something else.                                                                                                                                                                                                                   |

Handoffs apply in every approval mode, including `off`, and no rule changes them.

When a handoff starts:

1. The Dot stops. The computer panel shows **Your turn:** with the reason, and two buttons: **Take control** and **Dismiss**.
2. **Take control:** you control the live screen. Type the value yourself and finish the step.
3. **Give control back:** the handoff is done. The Dot resumes and takes a fresh snapshot before it continues. It does not type the secret.
4. **Dismiss:** you decline. FullDots cancels the computer's request, and the Dot is told you declined. It reports what it finished and what is left, then stops. If the cancel fails, FullDots stops and starts the Dot's computer. Its browser profile and files persist across the restart.

The computer ends its own request after 10 minutes. The Dot's turn has already ended, so the Dot does not act in the meantime. **Take control** sends a new request, so you can still take over after that time. The handoff stays waiting until you take control or dismiss it.

Chat messages still reach a Dot that is waiting for a handoff. A browser action in that chat is refused while you hold control or a request is open.

**Never paste passwords, codes or other secrets into the chat.** Type them on the live screen. Chat messages are saved in the conversation on this machine, and the Dot is told never to ask for them.

## The Inbox

The Inbox (the tray icon in the sidebar footer, or `#/inbox`) collects everything that waits for you, with a badge counting it in the sidebar and in the tab title, for example "(3) FullDots". It has four sections:

- **Approvals:** the same card as in the conversation, with **Open conversation**.
- **Your turn on the computer:** waiting handoffs. **Take over here** opens the Dot's conversation and computer and takes control in one click; **Decline** dismisses the handoff.
- **Questions:** what a Dot asked with `ask_owner` while it worked in the background. Write an answer and press **Send answer** (or Ctrl+Enter). **Skip** archives the question without an answer. Either way the Dot gets one new turn in the same conversation, shown as **Your answer**; after Skip it is told there is no answer. A question unlocks nothing: approvals still apply to whatever the Dot does next. While a question is open, scheduled work in its conversation waits, like it does for a pending approval.
- **Finished work:** results of background work; see [Always-on work](AUTOMATIONS.md#results-and-questions-in-the-inbox). **Open chat** marks one read; **Mark read** and **Archive** do what they say.

`#/approvals` still works: it opens the Inbox on the Approvals section, so older notification links and bookmarks keep working.

### Desktop notifications

Press **Enable desktop notifications** in the Inbox to let the browser show a notification when a new approval, handoff or question arrives while FullDots is open in a tab. The browser asks for permission only after that click. A notification names the Dot and the kind of request, for example "Scout needs your approval"; it never contains the prompt, the action's arguments, the question or a result. Clicking it opens the Inbox. Nothing is shown for the chat you are looking at, and finished work never notifies.

## Notifications

Set `NOTIFY_WEBHOOK_URL` to receive a POST for each new approval (title "Approval needed"), each new handoff (title "Your turn on the computer") and each new question (title "<Dot> has a question"; `text` is the question).

- The body is JSON with `title`, `text` and `url`. `text` is the short summary, cut to 500 characters. It does not include the arguments, the exact action or any secret.
- The webhook only notifies. You cannot approve or deny from it.
- A request times out after 5 seconds, and redirects are refused. A failed request is logged and is not retried.

## Limits

- **Focus is inferred.** If you click or type on the live screen, or the page moves focus on its own, FullDots can guess wrong about which element an Enter key will reach. In `sensitive` mode, a wrong guess can let an Enter press run without a prompt.
- **The patterns are heuristics.** They miss obfuscated commands, actions done through other tools, and sensitive actions with names they do not list. They also ask about harmless things, such as every `mv`.
- **`sensitive` mode does not review ordinary shell commands or file writes.** Use `writes`, or set Run shell commands and Write files to Ask me first, if you want those checked.
- **Rule categories are heuristics too.** A connector tool whose name does not say what it does falls under no category: pin it with **Treat as**.
- **Approve consciously.** You approve the exact action text, not the Dot's description. If you do not understand the exact action, deny it.
- **One turn per Dot.** While a Dot runs background work (a scheduled task or a resume), a chat message to it is refused with "busy with …" and a Stop button. The refused message stays in the conversation without a reply; send it again after stopping or waiting.
- **Resumes give up.** A resume that keeps failing (for example with a broken model key) is retried for a while and then dropped, so it never repeats forever. The approval stays decided; ask the Dot again.
