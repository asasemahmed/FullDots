# Notice

## Origin

FullDots is derived from **OpenDots** by CopilotKit (<https://github.com/CopilotKit/OpenDots>). It was forked at upstream commit `c2569bb` ("feat: add Parallel search and extraction to research", PR #15, 2 October 2026). OpenDots is licensed under the MIT License, Copyright (c) Atai Barkai. That notice is kept in [LICENSE](LICENSE), and the upstream commit history is preserved in this repository.

FullDots is an independent project. It is not affiliated with, sponsored by, or endorsed by CopilotKit. "CopilotKit" and "OpenDots" are names of their respective owners and are used here only to identify the original work.

Changes made upstream after the fork point are not included in FullDots. See [FullDots and OpenDots](README.md#fulldots-and-opendots).

## What FullDots changed

Relative to OpenDots at `c2569bb`:

- Conversations are stored by a local SQLite agent runner ([`src/server/sqlite-runner.ts`](src/server/sqlite-runner.ts)) instead of CopilotKit Intelligence. The runner is adapted from CopilotKit's MIT-licensed `@copilotkit/sqlite-runner` and rewritten for `node:sqlite` with local thread endpoints.
- Voice compute, call receipts and scheduled turns run in process through that runner.
- Parallel web search is replaced by keyless DuckDuckGo search ([`src/server/web-search.ts`](src/server/web-search.ts)) and the local read-only page reader.
- CopilotKit telemetry is disabled in code ([`src/server/privacy.ts`](src/server/privacy.ts)). OpenRouter attribution headers are not sent.
- Slack channels and Automatic Learning, which depend on CopilotKit Intelligence, are removed.
- Added: model providers (Settings → Models), MCP connectors with browser sign-in, approvals, owner handoff, one turn per Dot, a live computer view, configurable work limits, an audit trail, an optional notification webhook, a redesigned interface, and a larger test suite. [CHANGELOG.md](CHANGELOG.md) lists them.

## Third-party components

FullDots depends on open-source packages, including CopilotKit, AG-UI, TanStack AI, the Model Context Protocol SDK, Hono, React, Tiptap, Playwright and Simple Icons. Each is under its own license; see `package.json` and `package-lock.json`.

Dot computers use container images built from CopilotKit OpenBot (MIT). See [`deployment/computers/`](deployment/computers/README.md), which carries OpenBot's license in [`LICENSE.openbot`](deployment/computers/LICENSE.openbot).

## Third-party art and trademarks

- The brand marks in the connector and model galleries come from [Simple Icons](https://simpleicons.org) (CC0). They are trademarks of their owners and are used only to identify those services. Their use does not imply affiliation with or endorsement by any of them.
- The Hugging Face connector icon, [`public/connectors/huggingface.svg`](public/connectors/huggingface.svg), is the Hugging Face logo. It is a trademark of Hugging Face and is used only to identify that service.
- The FullDots logo and the Dot characters in [`docs/brand/`](docs/brand/README.md) are original artwork made for this project. They are released under the MIT License with the code.
