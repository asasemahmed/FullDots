# Security

FullDots is alpha software for a single owner. It is self-hosted, not a hosted service, and it has not been independently audited. Do not expose it to people you do not trust with your Dots' tools, and do not run it on a shared host without reading this page.

## Supported versions

Security fixes go to `main` and the latest 0.1.x release. Older versions are not patched.

## Reporting a vulnerability

Report privately through GitHub:

1. Open the [FullDots repository](https://github.com/asasemahmed/FullDots).
2. Go to the **Security** tab.
3. Choose **Report a vulnerability**.

Include the version or commit, how you run FullDots (source, Docker, computers on or off), steps to reproduce, and the impact you expect. Do not include real credentials, private URLs or personal data. Do not open a public issue for a vulnerability.

If the Security tab is not available to you, open a public issue that asks for a private channel. Put no exploit details in it.

### What to expect

This is a personal project, so response is best effort. There is no response-time guarantee and no bug bounty. Confirmed issues are fixed on `main`.

## In scope

- **Key handling.** Model keys, connector tokens and the encryption key leaking into a response, log, stored conversation, audit record, webhook or model request, or being stored in the clear.
- **OAuth callback.** Connector browser sign-in: the callback page, state handling, token exchange, redirect handling, and tokens reaching the browser.
- **Approval gate bypass.** A Dot running an action that should have paused, reusing an approval for a different action or a second time, or typing a password, code or captcha answer.
- **Sandbox escape from the Dot computer.** A Dot reaching the host, the supervisor, other Dots' computers, or credentials outside its own computer.
- **SSRF.** Requests to private or link-local addresses through connectors, connector sign-in, model providers or the page reader.
- **Authentication.** Reaching the API without the owner token on a non-loopback binding, or cross-origin requests that the origin checks should block.

## Out of scope

- Findings that need an attacker to already control your machine, your `.env` or your database.
- Prompt injection that only changes what a Dot says. It matters when it causes an action that the approval gate, a tool grant or a permission should have stopped.
- The approval checks missing an unusual shell command, in the default `sensitive` mode. These checks are heuristics and are documented as such in [docs/APPROVALS.md](docs/APPROVALS.md). Report a bypass only if it defeats a documented rule.
- Weaknesses in third-party services, providers or MCP servers you connect.
- Denial of service by the owner against their own instance.

## Security design

The details are in the code and docs linked here.

- **Local data.** Conversations, pages, settings and the audit trail live in one SQLite file ([`src/server/sqlite-runner.ts`](src/server/sqlite-runner.ts)). Treat that file as sensitive: it holds your conversation history and encrypted credentials.
- **No telemetry.** [`src/server/privacy.ts`](src/server/privacy.ts) disables CopilotKit telemetry, and the code has no analytics.
- **Encrypted secrets.** Pasted model keys and connector tokens are encrypted with AES-256-GCM, bound to their row and column ([`src/server/connector-crypto.ts`](src/server/connector-crypto.ts)). The key comes from `CONNECTOR_SECRET_KEY` or a generated `data/connector.key`. On Windows the key file's permissions are not restricted, so protect the `data` folder. Variables referenced from `.env` are read from the environment and not stored ([docs/CONNECTORS.md](docs/CONNECTORS.md)).
- **Owner token.** A non-loopback `HOST` needs an `OWNER_TOKEN` of 24+ characters or the server will not start ([`src/server/index.ts`](src/server/index.ts)). The API rejects cross-origin requests ([`src/server/origins.ts`](src/server/origins.ts)). Use HTTPS in front of any remote deployment.
- **Approvals.** Sensitive actions pause for the owner. An approval is bound to the tool, page, element and arguments of one action, and is used once ([`src/server/approval-gate.ts`](src/server/approval-gate.ts), [`src/server/approval-store.ts`](src/server/approval-store.ts), [docs/APPROVALS.md](docs/APPROVALS.md)). These are heuristics, not a sandbox.
- **Handoff.** A Dot stops before password, verification-code and captcha steps and never types them ([`src/server/handoff-detect.ts`](src/server/handoff-detect.ts)).
- **Connectors.** Tools are granted per Dot, read-only by default, and checked again just before each call. Results are redacted and capped. Discovery, registration and token requests refuse private addresses and do not follow redirects ([`src/server/connector-oauth.ts`](src/server/connector-oauth.ts)). Local-program connectors are off unless `CONNECTORS_ALLOW_STDIO=true`; those programs run with the server's rights, so enable it only for programs you trust.
- **Model providers.** Providers other than local ones must use HTTPS and cannot point at private addresses. Local providers accept private addresses only with `MODEL_PROVIDERS_ALLOW_LAN=true` ([docs/MODELS.md](docs/MODELS.md)).
- **Dot computers.** Each Dot's computer is a separate container with its own credential derived from a master secret. The master secret and the supervisor token are not forwarded to a computer. Browser, file and shell permissions are per Dot, start disabled and are checked by the server ([docs/COMPUTERS.md](docs/COMPUTERS.md), [`deployment/computers/`](deployment/computers/README.md)).
- **Page reader.** The optional reader is read-only, runs with JavaScript disabled, blocks private addresses and does not follow redirects. Run it in its own container, keep it off private networks, and do not publish its port.
- **Planted-secret test.** [`tests/security.test.ts`](tests/security.test.ts) plants secrets where the server keeps them and checks that none reach a response, webhook, model request, stored conversation, audit record or log line.

## Operating it safely

- Run on loopback unless you need remote access. Put HTTPS in front of anything else.
- Never commit `.env` files, `data/` or database files.
- Treat page text, uploaded content and model output as untrusted. Grant each Dot the tools it needs and no more.
- Keep approvals on `sensitive` or `writes` for Dots with a computer, connectors that can change data, or access to money or messaging.
- Review each approval card before you accept it.
- Back up the database together with its encryption key, and keep the backup protected.
