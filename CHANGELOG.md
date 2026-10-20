# Changelog

All notable changes to FullDots are listed here. The project follows [Semantic Versioning](https://semver.org), and 0.x releases may change without notice.

## Unreleased

### Added

- **Penguin Dots.** Every Dot is now a round penguin. Choose its species (Emperor, Adélie, Rockhopper, Macaroni or Chick) and its gear (headphones, glasses, beanie, scarf or bow tie) in the Dot's settings, next to its colour, which gains Ink. Dots that have not chosen keep a stable species from their id. The penguin shows what the Dot is doing: three pulsing dots while it thinks, three hopping dots while it writes, focused eyes while it uses a tool, an amber badge when it needs you, a burst of confetti when it is done, and a small grey dot when paused. Hand-offs and reviews have their own motion. The logo, favicon and brand art are drawn from the same code (`npm run brand`); see [`docs/brand/README.md`](docs/brand/README.md).
- **Cards for what a Dot creates or edits.** Saved and updated files and created or edited pages show in the chat as cards; clicking one opens it in a pane beside the chat (and keeps it current) instead of leaving for the Space. `update_space_file` lets a Dot replace or append to a text file, and `read_space_file` takes a file name, so a wrong guess lists the files that exist. See [`docs/SPACES.md`](docs/SPACES.md#files-from-a-dot).
- **Dots can keep files in Spaces.** `save_space_file`, `list_space_files`, `read_space_file` and `copy_computer_file_to_space` save a CSV, report or HTML page straight into a Space. A saved file shows in the chat as a card that opens the viewer, and HTML previews safely in a locked-down frame. Saving counts as Write files for approvals. See [`docs/SPACES.md`](docs/SPACES.md#files-from-a-dot).
- **Files in Spaces.** Upload files to a Space (or drop them on its library) and keep them beside its pages, under a page or at the top. A viewer shows CSV as a sortable table, Markdown rendered, text, JSON, images and PDFs; everything else downloads. Files are stored in the same SQLite database, up to `SPACE_FILE_MAX_MB` (default 10). See [`docs/SPACES.md`](docs/SPACES.md).
- **Guided Docker setup for Dot computers.** The Computer panel checks, starts and installs Docker and creates the computers with buttons. Each step shows its exact commands and runs them only after you allow them (`DOCKER_SETUP=off` hides it). A Dot can also do the setup itself through the approval gate, with the exact commands on the approval card and no terminal output. See [`docs/COMPUTERS.md`](docs/COMPUTERS.md#set-up-from-the-app).
- **Command palette and saved prompts.** Ctrl+K (Cmd+K) opens a keyboard-driven palette that searches chats, messages, pages, Dots and prompts (`GET /api/search`) and runs actions such as New chat with a Dot or Pause a Dot. Saved prompts live in Settings > Prompts (`/api/prompts`); deleting archives them.
- **Teams of Dots.** A Dot hands work to a teammate with `delegate_to_dot`; the teammate works in its own conversation and the result comes back as a new turn. Team grants per Dot, a depth limit (`TEAM_MAX_DEPTH`), loop protection and at most three hand-offs per turn ([`docs/TEAMS.md`](docs/TEAMS.md)).
- **Fast hand-offs.** Teammates start as soon as work is handed over, the results of one turn's hand-offs come back to the lead in one reply (`TEAM_RESULT_BATCH_MS`), a teammate's turn may take up to `DELEGATION_TIMEOUT` (300 s), teammates reply with the deliverable only, and child chats are named "Lead → Member: brief". `npm run bench:team` times it.
- **Pause a single Dot** from its sidebar menu. Its turns stop and its background work waits until it is resumed.
- **`npm run backup`** writes a consistent copy of the database (and the connector key) while FullDots runs.
- [`docs/ROADMAP.md`](docs/ROADMAP.md).
- **Deploy on Dokploy** with [`compose.dokploy.yml`](compose.dokploy.yml) and [`docs/DEPLOY-DOKPLOY.md`](docs/DEPLOY-DOKPLOY.md). The app image includes `scripts/backup.mjs`.
- **Private web search with SearXNG.** `WEB_SEARCH_PROVIDER=searxng` searches through your own SearXNG at `SEARXNG_URL`, keyless, so Dots can search from a VPS that DuckDuckGo blocks. Both compose files run it with `COMPOSE_PROFILES=search`, on an internal network without a public port. When DuckDuckGo answers with its bot check, Dots now say the server's address is blocked and point to SearXNG instead of asking you to wait.

- **Standing goals.** A goal runs on a schedule until the Dot calls `mark_goal_done`, with an optional run limit. Repeats get run limits too ([`docs/AUTOMATIONS.md`](docs/AUTOMATIONS.md)).
- **Parallel background work.** `BACKGROUND_CONCURRENCY` (default 4) tasks run at once on different Dots.
- **Triggers.** Webhooks with bearer, URL or HMAC secrets (hashed or sealed, shown once, rotatable), dedupe, rate and size limits; and polls of read-only connector tools that fire when the answer changes. Events become tasks in the trigger's conversation.
- **Token use and budgets.** Provider-reported tokens per Dot per UTC day, a once-a-day warning (`DOT_DAILY_TOKEN_WARN`), and an optional daily budget that pauses a Dot's background work.

- **Delete a page.** Its subpages move up to the deleted page's parent, and a retried review approval cannot recreate it (ported from OpenDots [#49](https://github.com/CopilotKit/OpenDots/pull/49)).

### Fixed

- `compose.yml` passes `BACKGROUND_CONCURRENCY`, `DOT_DAILY_TOKEN_WARN` and `TEAM_MAX_DEPTH` to the app.
- A model provider is shown as Ready only after a successful test, the built-in `.env` provider included.
- When a Dot is busy, the chat says so, keeps the message and offers to send it again or to stop the other work and send.

Ported from OpenDots, adapted to FullDots and covered by tests:

- Interrupted scheduled runs wait for an explicit retry instead of re-running ([#47](https://github.com/CopilotKit/OpenDots/pull/47)).
- Background runner database errors are contained and retried ([#12](https://github.com/CopilotKit/OpenDots/pull/12)).
- Dot turns know the current time ([#76](https://github.com/CopilotKit/OpenDots/pull/76)).
- Reviewed-page retries are bound to the saved draft ([#48](https://github.com/CopilotKit/OpenDots/pull/48)), and reverted drafts survive save errors ([#44](https://github.com/CopilotKit/OpenDots/pull/44)).
- The composer ignores Enter during IME composition ([#40](https://github.com/CopilotKit/OpenDots/pull/40)), and the home composer sends on Enter ([#95](https://github.com/CopilotKit/OpenDots/pull/95)).
- The connection error clears once polling recovers ([#73](https://github.com/CopilotKit/OpenDots/pull/73)).
- Voice calls survive short connection and status-poll drops, and failed compute turns can be retried ([#26](https://github.com/CopilotKit/OpenDots/pull/26), [#39](https://github.com/CopilotKit/OpenDots/pull/39), [#13](https://github.com/CopilotKit/OpenDots/pull/13)).
- Checklist checkboxes stay inline with their text ([#90](https://github.com/CopilotKit/OpenDots/pull/90)).
- Research keeps balanced brackets in requested URLs ([#99](https://github.com/CopilotKit/OpenDots/pull/99)).
- Unknown conversations, calls, Dots and pages return 404, and malformed JSON returns 400 ([#14](https://github.com/CopilotKit/OpenDots/pull/14), [#98](https://github.com/CopilotKit/OpenDots/pull/98), [#11](https://github.com/CopilotKit/OpenDots/pull/11)).
- Scheduled task activity logs use neutral wording ([#105](https://github.com/CopilotKit/OpenDots/pull/105)).
- `npm run dev` works on Windows ([#20](https://github.com/asasemahmed/FullDots/pull/20), by @brunnojob).

### Removed

- The leftover Automatic Learning settings (`learningContainerId`, `skillDeliveryEnabled`). The database columns stay; older clients that still send the fields are not refused.

## 0.1.0 — first public release (2026-10-09)

FullDots was forked from CopilotKit OpenDots at commit `c2569bb` (2 October 2026). This release covers the 13 commits made on top of that point. Later upstream changes are not merged. See [FullDots and OpenDots](README.md#fulldots-and-opendots).

### Added

- **Local conversations.** A SQLite agent runner stores threads, messages and runs on your machine ([`src/server/sqlite-runner.ts`](src/server/sqlite-runner.ts)).
- **Keyless web search** through DuckDuckGo ([`src/server/web-search.ts`](src/server/web-search.ts)).
- **Model providers.** Settings → Models with 14 presets, keys encrypted with AES-256-GCM, a per-Dot model picker, and per-provider request handling ([`docs/MODELS.md`](docs/MODELS.md)).
- **Connectors over MCP.** Streamable HTTP with SSE fallback, local programs behind `CONNECTORS_ALLOW_STDIO`, browser sign-in with automatic client registration, token presets, per-Dot tool grants that default to read-only, live revocation, and result redaction and size caps ([`docs/CONNECTORS.md`](docs/CONNECTORS.md)).
- **Approvals.** Sensitive actions pause for the owner. Approvals are bound to the exact action and are single-use. Modes are `sensitive`, `writes` and `off`. Paused turns resume after a restart ([`docs/APPROVALS.md`](docs/APPROVALS.md)).
- **Owner handoff** for password, verification-code and captcha steps ([`src/server/handoff-service.ts`](src/server/handoff-service.ts)).
- **One turn per Dot.** Chat, voice, scheduled tasks and resumes share a lock. Scheduled tasks skip conversations that wait for the owner. A Stop button ends background work ([`src/server/turn-registry.ts`](src/server/turn-registry.ts)).
- **Live computer view** with take-over controls ([`src/server/computer-stream.ts`](src/server/computer-stream.ts)).
- **Configurable work limits** for steps, time, shell commands and file size ([`src/server/limits.ts`](src/server/limits.ts)).
- **Audit trail** of computer and connector actions, and an optional notification webhook ([`src/server/notify.ts`](src/server/notify.ts)).
- **New interface.** Sidebar with search, date groups and chat actions; tabbed Settings; connector and model galleries with brand logos; an approvals view; a Dot form with sections; and a new Dot character and logo ([`docs/brand/`](docs/brand/README.md)).
- **Tests.** 72 test files and 1186 tests, up from 35 test files at the fork point, including a planted-secret regression test ([`tests/security.test.ts`](tests/security.test.ts)).
- Public documentation: README, NOTICE, CONTRIBUTING, SECURITY, and guides for models, connectors, approvals and computers.

### Changed

- Conversation storage moved from the hosted CopilotKit Intelligence service to local SQLite. Voice compute, call receipts and scheduled turns run in process.
- The app, server messages and package metadata are named FullDots.
- Computer use was reworked: a live view, a compact activity display in chat, and a smoother agent loop.
- The development server accepts loopback aliases of the app origin.
- Owner actions after a handback work again, and panel errors stay visible.

### Removed

- The hosted CopilotKit Intelligence thread service.
- Parallel search and its API key.
- Slack channels and Automatic Learning, which depend on Intelligence.
- CopilotKit telemetry, and the CopilotKit developer inspector overlay.
- OpenDots demo media. The README no longer uses it.

### Security

- Telemetry is disabled in code before the runtime loads ([`src/server/privacy.ts`](src/server/privacy.ts)). OpenRouter attribution headers are not sent.
- Model keys and connector tokens are encrypted at rest. Secrets are masked in tool results and never sent to the browser.
- The server refuses a non-loopback `HOST` without an `OWNER_TOKEN` of at least 24 characters.
- Connector discovery, registration and token requests refuse private addresses and do not follow redirects.
- A regression test plants secrets where the server keeps them and checks that none reach a response, webhook, model request, stored conversation, audit record or log line.
