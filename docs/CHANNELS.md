# Talk to your Dots from Slack and Telegram

Open **Settings → Channels**. Each channel is off until you enable it and save.
Choose the Dot that answers and explicitly list your owner accounts. FullDots
connects directly to Slack or Telegram with your own bot. No hosted CopilotKit
account or public callback URL is needed.

## Slack

1. Create an app at [Slack Apps](https://api.slack.com/apps) for your workspace.
2. Enable **Socket Mode**. Create an app-level token with `connections:write`.
3. Under **OAuth & Permissions**, add bot scopes `chat:write`, `app_mentions:read`
   and `im:history`. These cover replies, mentions and direct messages. FullDots
   does not need profile, email, file-upload or administrator scopes.
4. Enable **Event Subscriptions**, subscribing to `app_mention` and `message.im`.
   Enable **Interactivity** for the approval buttons. Socket Mode carries these
   events without a Request URL. Enable the app's Messages tab so you can send DMs.
5. Install the app into your workspace. Copy the bot token and app-level token
   into Settings → Channels → Slack. Invite the bot to the channels you use.
6. Enter the allowed workspace ID and your Slack member ID. Find your member ID
   under your profile's **More → Copy member ID**. The workspace ID is the team
   segment of Slack's browser URL. List additional owner member IDs only if those
   accounts should have the same authority as you.
7. Choose a Dot, enable Slack and click **Save Slack**. Wait for **Connected**.
   DM the bot or mention it in a channel. Mention it again within the same thread
   to continue that conversation. Replies stay in that thread; flat DMs stay in
   the DM. Other senders and workspaces are ignored.

For a stop command, add `/stop` under the Slack app's Slash Commands and grant
the `commands` scope, then reinstall. It stops the channel's chosen Dot. You can
also stop a turn in FullDots. See [Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/).

## Telegram

1. Talk to [@BotFather](https://t.me/BotFather) in Telegram and use `/newbot`.
   Copy its bot token into Settings → Channels → Telegram.
2. Enter your numeric Telegram user ID in **Allowed Owner User IDs**. Use trusted
   Telegram account information to obtain the ID; do not enter a display name or
   username. You may restrict the channel further with an **Allowed Chat ID**.
3. For a private owner DM, you can instead enter its positive chat ID and leave
   the user list empty. FullDots checks that the sender is that same user in a
   private chat. Groups always require an explicit owner user list.
4. Choose a Dot, enable Telegram and click **Save Telegram**. Wait for
   **Connected**, then send the bot a message. In groups, address the bot by its
   username or reply to it. Forum topics stay separate. Use `/stop` to stop the
   chosen Dot's active turn.

FullDots uses long polling. Run only one instance for each bot token and remove
an old webhook before switching an existing bot to FullDots. No webhook server
is started. See the [Telegram Bot API](https://core.telegram.org/bots/api).

## Approvals, pause and restart

An action that needs approval sends its summary, tool and redacted arguments,
followed by **Approve** and **Deny** buttons. Read the details before choosing.
Only a listed owner can use a button. Buttons are single-use and bound to that
exact action and conversation. A text reply such as “yes” never approves.
Expired, changed or already decided actions cannot be approved again. The same
approval remains available in FullDots. Approval decisions use FullDots' normal
approval service and resume queue.

Button records and conversation mappings are stored in SQLite, so pending
buttons survive a server restart until the approval expires. Changing channel
settings invalidates old buttons and starts fresh channel conversation mappings.
Global pause, Dot pause and stopping a turn use the same controls as app turns.
Messages received while paused do not start work; resume and send a new message.
Stopping or restarting does not undo actions already completed.

Replies are sent after each turn, split to fit the platform. Saved pages and
Space files appear as FullDots links. Set `APP_ORIGIN` to the FullDots address
you can open from your messaging device; links still require owner sign-in.
FullDots retries failed deliveries up to five times without rerunning the Dot.
A failed message holds later replies and approval buttons in that conversation;
check its chat and approvals in FullDots. After a crash, a reply can arrive twice
if the platform accepted it before FullDots recorded delivery. Duplicate inbound
events do not rerun work. Interrupted work is not replayed from channel messages;
review the chat before sending a new request.

## Tokens and privacy

Tokens are encrypted with the existing connector key and are never returned to
the browser. Settings show **Set** or **Not set**. Blank token inputs keep the
saved token; **Clear saved token**, then Save, removes it. Disable the channel
before removing a required token. Back up the database and connector key together.
No new environment settings are required.

Messages, replies and approval details pass through Slack or Telegram and your
configured model provider. A group or Slack channel's other members may read
them even though only your listed owners can issue requests or press buttons.
Use a private conversation for private work. Unauthorized senders are ignored
silently. The log records only an ignored-event count, never their message text.
Provider failures expose only a safe error name and HTTP status when available.
File uploads, voice messages and edits are not channel task inputs in this release;
send a text request and use FullDots links for saved artifacts.

## Implementation

The MIT channel SDK adapters run directly through their public `start(sink)`
and `post` methods. FullDots owns the runner, SQLite state, locking, deduplication,
delivery retries and durable ActionStore. The SDK's hosted default runner and
in-memory action registry are not used. A test starts the real Slack adapter
against fake transport edges and runs a normal Dot turn without Intelligence.
