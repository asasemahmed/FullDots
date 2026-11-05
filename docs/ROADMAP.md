# Roadmap

FullDots aims to give always-on AI coworkers with their own computers, app connectors, approvals and teams, while staying local-first, private, model-agnostic and self-hosted. This is what is done and what is next.

| Phase | What the owner gets                                                                                                    | Status  | Settings it adds                                                               |
| ----- | ---------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------ |
| 0     | Working Docker setup, an audit trail, labels on server-started turns, per-Dot pause, `npm run backup`                  | Done    | none                                                                           |
| 1     | MCP connectors with presets, browser sign-in and per-Dot tool grants                                                   | Done    | `CONNECTORS_ALLOW_STDIO`, `CONNECTOR_RESULT_MAX_CHARS`, `CONNECTOR_SECRET_KEY` |
| 2     | Approvals before risky actions, owner handoff for passwords and codes, resume after restart                            | Done    | `APPROVAL_TTL`, `NOTIFY_WEBHOOK_URL`                                           |
| 3     | Standing goals, parallel background work, webhook and poll triggers, token use and budgets                             | Done    | `BACKGROUND_CONCURRENCY`, `DOT_DAILY_TOKEN_WARN`                               |
| 4     | Reach your Dots from anywhere: Slack and Telegram chat and approvals, an installable app                               | Done    | Settings → Channels                                                            |
| 5     | Teams of Dots: a Dot hands work to a teammate and gets the result back                                                 | Done    | `TEAM_MAX_DEPTH`                                                               |
| 6     | Computers that do more: a full Linux desktop, Claude Code and Codex as coding workers, Dots backed by an agent you run | Done    | `COMPUTER_DESKTOP_IMAGE`, `AGENT_ENDPOINT_ALLOWED_HOSTS`                       |
| 7     | Dot computers on a server you own, reached over SSH, while FullDots stays where it is                                  | Planned | to come                                                                        |

Run all of FullDots on a server with the [VPS guide](DEPLOY-VPS.md) or [Dokploy](DEPLOY-DOKPLOY.md).

Guides: [Connectors](CONNECTORS.md) · [Approvals](APPROVALS.md) · [Automations](AUTOMATIONS.md) · [Teams](TEAMS.md) · [Channels](CHANNELS.md) · [Computers](COMPUTERS.md) · [Setup](SETUP.md)

Ideas and help are welcome. The [open issues](https://github.com/asasemahmed/FullDots/issues) list what is up for grabs, and the pinned issue explains how to start.
