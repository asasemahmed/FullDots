# Approvals

Approvals stop a Dot before an action that could be hard to undo. You decide on a card in the conversation, or in the Approvals view. This page covers which actions pause, how an approval applies, how a Dot resumes afterwards, and how handoffs work when a page needs a person. Connector grants are described in [Connectors](CONNECTORS.md).

## Approval modes

Set **Approvals** in the Dot form. The default is `sensitive`.

| Mode                  | Asks before                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sensitive` (default) | Sensitive actions: destructive shell commands, clicks and selections on sensitive elements, submitting forms that look sensitive, Enter presses in sensitive places, and connector tools marked destructive. |
| `writes`              | Everything in `sensitive`, plus anything that changes data: every shell command, file writes, creating or editing Space pages, connector tools that can change data, and every Enter key press.              |
| `off`                 | Nothing, except connector tools you set to `ask`. Handoffs still apply. `deny` overrides still refuse the tool.                                                                                              |

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

A per-tool override replaces these rules for that tool. `allow` never asks, even for a destructive tool. `ask` asks in every mode, including `off`. `deny` refuses the tool in every mode, including `off`.

### Files and Space pages

Writing a file, creating a Space page and editing a Space page count as changes to data. They ask in `writes` mode only.

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

Approve or deny, with an optional note of up to 1,000 characters. Pending approvals appear in the Approvals view, which has a count in the sidebar, and on the card in the conversation.

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

Handoffs apply in every approval mode, including `off`.

When a handoff starts:

1. The Dot stops. The computer panel shows **Your turn:** with the reason, and two buttons: **Take control** and **Dismiss**.
2. **Take control:** you control the live screen. Type the value yourself and finish the step.
3. **Give control back:** the handoff is done. The Dot resumes and takes a fresh snapshot before it continues. It does not type the secret.
4. **Dismiss:** you decline. FullDots cancels the computer's request, and the Dot is told you declined. It reports what it finished and what is left, then stops. If the cancel fails, FullDots stops and starts the Dot's computer. Its browser profile and files persist across the restart.

The computer ends its own request after 10 minutes. The Dot's turn has already ended, so the Dot does not act in the meantime. **Take control** sends a new request, so you can still take over after that time. The handoff stays waiting until you take control or dismiss it.

Chat messages still reach a Dot that is waiting for a handoff. A browser action in that chat is refused while you hold control or a request is open.

**Never paste passwords, codes or other secrets into the chat.** Type them on the live screen. Chat messages are saved in the conversation on this machine, and the Dot is told never to ask for them.

## Notifications

Set `NOTIFY_WEBHOOK_URL` to receive a POST for each new approval (title "Approval needed") and each new handoff (title "Your turn on the computer").

- The body is JSON with `title`, `text` and `url`. `text` is the short summary, cut to 500 characters. It does not include the arguments, the exact action or any secret.
- The webhook only notifies. You cannot approve or deny from it.
- A request times out after 5 seconds, and redirects are refused. A failed request is logged and is not retried.

## Limits

- **Focus is inferred.** If you click or type on the live screen, or the page moves focus on its own, FullDots can guess wrong about which element an Enter key will reach. In `sensitive` mode, a wrong guess can let an Enter press run without a prompt.
- **The patterns are heuristics.** They miss obfuscated commands, actions done through other tools, and sensitive actions with names they do not list. They also ask about harmless things, such as every `mv`.
- **`sensitive` mode does not review ordinary shell commands or file writes.** Use `writes` if you want those checked.
- **Approve consciously.** You approve the exact action text, not the Dot's description. If you do not understand the exact action, deny it.
- **One turn per Dot.** While a Dot runs background work (a scheduled task or a resume), a chat message to it is refused with "busy with …" and a Stop button. The refused message stays in the conversation without a reply; send it again after stopping or waiting.
- **Resumes give up.** A resume that keeps failing (for example with a broken model key) is retried for a while and then dropped, so it never repeats forever. The approval stays decided; ask the Dot again.
