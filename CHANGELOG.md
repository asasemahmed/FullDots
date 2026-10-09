# Changelog

All notable changes to FullDots are listed here. The project follows [Semantic Versioning](https://semver.org), and 0.x releases may change without notice.

## 0.1.0 — first public release (2026-10-09)

FullDots was forked from CopilotKit OpenDots at commit `c2569bb` (2 October 2026). This release covers the 13 commits made on top of that point. Later upstream changes are not merged. See [Relationship to OpenDots](README.md#relationship-to-opendots).

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
