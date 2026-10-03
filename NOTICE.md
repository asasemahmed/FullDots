# Notice

FullDots is derived from **OpenDots** by CopilotKit
(https://github.com/CopilotKit/OpenDots), forked at upstream commit `c2569bb`
("feat: add Parallel search and extraction to research"). OpenDots is
licensed under the MIT License, Copyright (c) Atai Barkai. That notice is
retained in [LICENSE](LICENSE), and the upstream commit history is preserved
in this repository.

FullDots is an independent project. It is not affiliated with, sponsored by,
or endorsed by CopilotKit. "CopilotKit" and "OpenDots" are names of their
respective owners and are used here only to identify the original work.

## Modifications

Changes made in FullDots relative to upstream include:

- Conversations are stored in a local SQLite agent runner
  (`src/server/sqlite-runner.ts`) instead of CopilotKit Intelligence. The
  runner is adapted from CopilotKit's MIT-licensed `@copilotkit/sqlite-runner`
  and rewritten for `node:sqlite` with local thread endpoints.
- Voice compute, call receipts, and scheduled turns run in process through
  that runner.
- Parallel web search is replaced with keyless DuckDuckGo search
  (`src/server/web-search.ts`) and the local read-only page reader.
- CopilotKit runtime telemetry is disabled in code (`src/server/privacy.ts`).
- Slack channels and Automatic Learning, which depend on CopilotKit
  Intelligence, are removed.

## Third-party components

FullDots depends on open-source packages including CopilotKit, AG-UI,
TanStack AI, Hono, React, Tiptap, and Playwright, each under its own license.
Dot computers use container images built from CopilotKit OpenBot
(see `deployment/computers/`, which carries its own license file).
