# Changelog

All notable changes to FullDots are listed here. The project follows [Semantic Versioning](https://semver.org), and releases before 1.0 may have changed without notice.

## Unreleased

### Added

- **A Dot can use an agent you run.** In the Dot dialog, Advanced takes an https AG-UI endpoint and an optional authorization header. The header is encrypted and is not sent back to the browser. That Dot's turns then go to the agent. Chat, mission control, pause and stop work as they do for any Dot. A remote agent uses its own tools, which the approval gate does not see. Hand-offs, Spaces and the computer stay FullDots tools. Private and local addresses are refused unless the host is listed in `AGENT_ENDPOINT_ALLOWED_HOSTS`. See [`docs/AGENTS.md`](docs/AGENTS.md).
- **Codex as a second coding agent.** With Coding agents on, each Dot's settings now have a Coding agent list: Claude Code (the default) or Codex. Codex is pinned to version 2.2.2 and installed on demand inside the Dot's computer (about 430 MB, not in the image). You sign in inside the computer with an API key or your ChatGPT account; FullDots never stores it. Codex starts in its read-only preset and every permission request waits for your approval, like Claude Code's. See [`docs/COMPUTERS.md`](docs/COMPUTERS.md#choose-claude-code-or-codex).
- **Share a Dot as a file.** Export a Dot from its form to a small Dot pack file, and import the file on this or another FullDots install to create a copy. A pack holds the role, look, approval mode, rules and that Dot's saved prompts. It never holds conversations, notes, memories, connector or Connected apps access, computer access, the model or any key, and secret-looking text is replaced with `[redacted]` both ways. An import shows a preview and creates a new Dot with no access. A pack cannot turn approvals off; it starts on Sensitive. See [`docs/TEAMS.md`](docs/TEAMS.md#share-a-dot).
- **A guide to running FullDots on a VPS.** Step-by-step instructions for running FullDots for a single owner on a plain Linux VPS with Docker Compose and Caddy for HTTPS, without Dokploy or a platform manager. Covers hardware sizing, security and firewall setup, .env configuration, starting services with SearXNG and Dot computers, backups, automated cron tasks, updates and troubleshooting. See [`docs/DEPLOY-VPS.md`](docs/DEPLOY-VPS.md) (closing [#17](https://github.com/asasemahmed/FullDots/issues/17)).
- **Coding workers inside Dot computers.** Enable Coding agents per Dot to delegate coding tasks with buffered tool progress, owner approvals for permission requests, and an in-computer sign-in hand-off. Workers stop when access is revoked, the Dot is paused or the worker leaves manual mode. The adapter and sign-in home stay outside the Files root in the persistent profiles volume, with managed-only settings and hooks. See [`docs/COMPUTERS.md`](docs/COMPUTERS.md#coding-agents).
- **A dark theme.** FullDots follows your operating system's light or dark setting, and you can pin Light or Dark in Settings → General → Appearance. The choice is saved per browser and applies before the first paint, so a dark screen never flashes light. Every screen has both versions, and text meets WCAG AA contrast in each. Dots keep their own colours in both themes. See [`docs/UI.md`](docs/UI.md) (by @naet001, closing [#7](https://github.com/asasemahmed/FullDots/issues/7)).
- **Connected apps through Composio.** With `COMPOSIO_API_KEY` set, Settings → General and each Dot gain a Connected apps switch, both off until you turn them on. A Dot can then use apps such as Gmail, Google Calendar and GitHub. An optional toolkit list limits which apps; a blank list allows every toolkit in the Composio project. Reads follow the Dot's approval mode, and every other action waits for approval. A missing sign-in shows Composio's Connect link in the chat. Arguments and results pass through Composio. See [`docs/CONNECTORS.md`](docs/CONNECTORS.md#connected-apps-composio).
- **Add a registry server as a connector.** Each Discover result with a hosted endpoint, or a local npm or PyPI package, has an Add button. It opens the connector form already filled in, with the name, address or pinned command and the environment variable names. Nothing is saved, connected or run until you press Save. Hosted addresses must be https and must not point at this machine or a private network. A local program needs `CONNECTORS_ALLOW_STDIO=true`; without it the button says why. See [`docs/CONNECTORS.md`](docs/CONNECTORS.md#discover-servers).
- **API keys for connected apps.** When an app asks for a key, a token, or a short set of fields you already have, the chat card shows those fields instead of a Connect link. The values go from the browser to the FullDots server and straight to Composio. FullDots does not store them, log them, or give them to the model. A failed check names the error type and the HTTP status. Settings → General lists the apps connected for you and can disconnect one. Apps that need an operator-registered OAuth app are still not offered. See [`docs/CONNECTORS.md`](docs/CONNECTORS.md#a-key-you-already-have).
- **Discover MCP servers.** Settings → Connectors has a Discover tab that searches the public MCP registry by server name and lists matches with a link to each repository. It only lists: nothing is installed from it yet. Off by default: set `CONNECTORS_REGISTRY_SEARCH=true` to turn it on, because each search sends the text you type to `registry.modelcontextprotocol.io`. See [`docs/CONNECTORS.md`](docs/CONNECTORS.md#discover-servers).
- **Secrets are removed from notes and saved memories.** Before a Dot note, a line a Dot proposes for its note, or a saved memory is stored, text that looks like a secret is replaced with `[redacted]`: API keys with a known prefix (`sk-`, GitHub, GitLab, Slack, Google, AWS and others), bearer tokens and authorization headers, passwords inside URLs, private key blocks, JWTs and long random-looking strings. Ordinary text, links, file paths, git hashes and UUIDs are left alone. The chat itself is not changed, and the log records how many values were hidden, never the values. See [`docs/SETUP.md`](docs/SETUP.md#dot-notes).

- **Talk to Dots from Slack and Telegram.** Settings → Channels connects your own bots, restricts messages and approval buttons to listed owner accounts, and keeps pending buttons across restarts. Slack uses Socket Mode and Telegram uses long polling, with no hosted account or public callback URL. See [Channels](docs/CHANNELS.md) (closing [#15](https://github.com/asasemahmed/FullDots/issues/15)).

### Changed

- **A new main layout.** The sidebar lists only your Dots. Each Dot shows what it is doing (its computer step in plain words, such as "Searching the web"), or its role while idle, and an amber count when something waits for you. Its chats sit behind an arrow beside it, closed until you open them, newest first with a time. Search, Inbox, Mission control, Spaces, Teams, Scheduled and activity and Memories moved to icons in the sidebar footer, next to **Settings** and **Apps**, which shows a few app logos and opens Settings → Connectors; Spaces and Teams open in a panel there. The computer panel on the right opens on wide windows until you close it, and the **Computer** button in the top bar brings it back. The top bar names the open chat. The sidebar's title filter is gone: Search everywhere (Ctrl+K) finds chats, messages, pages, Dots, prompts and teams. See [`docs/UI.md`](docs/UI.md#in-the-sidebar).
- **FullDots now uses ag-ui 1.0, TanStack AI 1.0 and CopilotKit 1.80.** Shared protocol types use one version throughout the agent stack; streaming, approvals and saved conversations keep their existing behavior.
- **Dot computers are limited to 2 CPUs.** The supervisor now sets a CPU limit on each computer next to its memory limit. Change it with `COMPUTER_CPUS` (a decimal such as `0.5` or `4`; `0` means no limit). A computer created earlier keeps its old limit until its container is removed (`docker rm -f opendots-computer-<dot id>`; its files and browser profile stay in volumes) and started again, and the supervisor image must be rebuilt once to pick the setting up. See [Dot computers](docs/COMPUTERS.md).

### Fixed

- **Codex can no longer read its private coding files.** In the read-only preset, sandboxed file reads and shell commands now refuse `/profiles/.coding/**` and `/proc/**`, including the sign-in file. The rule is a root-owned requirements file in the computer image, and the bridge will not start Codex if that file is missing or changed. On Linux the `**` rules expand to 16 directory levels. See [`docs/COMPUTERS.md`](docs/COMPUTERS.md#choose-claude-code-or-codex).
- A dark theme no longer flashes light when the page loads under `npm start` or in Docker. The server's Content-Security-Policy (`script-src 'self'`) blocked the inline script that applies the saved theme before the first paint, so it only ran under `npm run dev`. The script is now `public/theme-init.js`, loaded from `<head>`, and the policy is unchanged.
- Computer actions now answer with the right status (403, 404, 409, 502, 503) instead of 400 for everything, and unhandled computer failures mask raw error details.
- Browser search recognises Brave's current bot check ("Verifying you're not a bot"), which a new browser profile often sees. It used to be read as a results page with no results; now the search moves on to the next engine in `WEB_SEARCH_ENGINE`.

## 2.0.0 — the flock (2026-10-22)

The first major release since FullDots was forked: penguin Dots, teams, Spaces with files, browser search through each Dot's own computer, and work that runs on its own. The major version marks two changes to how an existing install behaves: Dot computers now run a headed browser, and the leftover Automatic Learning settings are gone (see Removed).

### Upgrading from 0.1.0

1. Back up first. From source, run `npm run backup` while FullDots runs; it copies the database and `data/connector.key` together. With Docker, copy the data volume as shown in [Deploy on Dokploy](docs/DEPLOY-DOKPLOY.md#6-backups).
2. Pull `v2.0.0`, then run `npm ci` (from source) or rebuild the images with the same compose files and profiles you started with plus `--build`. The database updates itself on start.
3. Dot computers created before the upgrade keep a headless browser. To switch one, stop it, remove its container (`docker rm -f opendots-computer-<dot id>`; its files and browser profile live in volumes and stay), and start it again from the Computer panel. See [Dot computers](docs/COMPUTERS.md).
4. Optional: for search with fewer captchas, set `WEB_SEARCH_PROVIDER=browser`, start SearXNG as the fallback (`COMPOSE_PROFILES=search`), and leave Google out of `WEB_SEARCH_ENGINE`. See [Web search](docs/SETUP.md#web-search-and-page-reader).

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
- **Search with the Dot's own browser.** When a Dot has a running computer with Browser access, `search_web` and `computer_search` search in that Dot's Chromium, visible in the live view, and return a short list of `{title, url, snippet, ref}` results instead of a page dump. Cookie banners on the search host are declined, a soft bot check moves the search to the next engine in `WEB_SEARCH_ENGINE` (DuckDuckGo, Brave, Bing, Startpage, Google), and a captcha hands the screen to you once. Computers run their browser headed on a virtual display (`COMPUTER_BROWSER_MODE=headed`), which search engines challenge far less than headless Chrome, and Brave's results are read from its real page layout. With `WEB_SEARCH_PROVIDER=browser`, SearXNG answers when the browser cannot. See [Web search](docs/SETUP.md#web-search-and-page-reader).
- **Export a conversation as Markdown** from its menu in the sidebar (`GET /api/conversations/:id/export.md`).
- **Private web search with SearXNG.** `WEB_SEARCH_PROVIDER=searxng` searches through your own SearXNG at `SEARXNG_URL`, keyless, so Dots can search from a VPS that DuckDuckGo blocks. Both compose files run it with `COMPOSE_PROFILES=search`, on an internal network without a public port. When DuckDuckGo answers with its bot check, Dots now say the server's address is blocked and point to SearXNG instead of asking you to wait.
- **Standing goals.** A goal runs on a schedule until the Dot calls `mark_goal_done`, with an optional run limit. Repeats get run limits too ([`docs/AUTOMATIONS.md`](docs/AUTOMATIONS.md)).
- **Parallel background work.** `BACKGROUND_CONCURRENCY` (default 4) tasks run at once on different Dots.
- **Triggers.** Webhooks with bearer, URL or HMAC secrets (hashed or sealed, shown once, rotatable), dedupe, rate and size limits; and polls of read-only connector tools that fire when the answer changes. Events become tasks in the trigger's conversation.
- **Token use and budgets.** Provider-reported tokens per Dot per UTC day, a once-a-day warning (`DOT_DAILY_TOKEN_WARN`), and an optional daily budget that pauses a Dot's background work.
- **Delete a page.** Its subpages move up to the deleted page's parent, and a retried review approval cannot recreate it (ported from OpenDots [#49](https://github.com/CopilotKit/OpenDots/pull/49)).

### Changed

- Dot computers run their browser headed by default. Set `COMPUTER_BROWSER_MODE=headless` to keep the 0.1.0 behaviour.
- A new README with current screenshots and an architecture diagram ([`docs/brand/architecture.svg`](docs/brand/architecture.svg)).
- Dependencies and GitHub Actions are up to date.

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
