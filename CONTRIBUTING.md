# Contributing to FullDots

Thanks for helping. FullDots is an alpha, single-owner, self-hosted app. Small, focused changes with tests are the easiest to review.

Before you start:

- Open an issue first for anything larger than a small fix, so we can agree on the approach.
- Changes that belong in OpenDots itself are welcome there too: <https://github.com/CopilotKit/OpenDots>. FullDots does not track upstream, so a fix may need to go to both.
- Report security problems privately. See [SECURITY.md](SECURITY.md).

## Set up

You need Node.js 24 or newer and npm.

```sh
git clone https://github.com/<your-username>/FullDots.git
cd FullDots
npm ci
cp .env.example .env
npm run dev
```

Open <http://127.0.0.1:5173>. The API runs on port 4310. You can work on most of the app without a model key. [docs/SETUP.md](docs/SETUP.md) covers the page reader, voice and Docker. [docs/COMPUTERS.md](docs/COMPUTERS.md) covers Dot computers and needs Docker.

## Run the checks

CI runs these on every pull request ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). Run them before you push:

```sh
npm run check-format && npm run lint && npm run typecheck && npm test && npm run build
```

`npm run format` fixes formatting. `npm test` runs Vitest once and takes about a minute. If a test times out on a slow machine, run it again on its own before you report it.

## Pull requests

1. Fork the repository and create a branch from `main`. Use a short, descriptive name such as `fix-approval-expiry`.
2. Make one change per pull request.
3. Add or update tests (see below).
4. Update the docs in [`docs/`](docs/) when behavior or configuration changes. Add new environment variables to [`.env.example`](.env.example) with a comment.
5. Open the pull request against `main`. Say what changed and why, and how you checked it. Include a screenshot for interface changes. Check narrow screens and keyboard access too.

## Code style

- Match the surrounding code. The project uses TypeScript, React and Hono.
- Prettier formats the code and ESLint checks it. Do not argue with the formatter; run `npm run format`.
- Keep names plain and comments short. Explain why, not what.
- Do not add controls that look like they connect a service when no adapter exists.
- Keep everything except the model provider and the connectors the owner adds running locally. Do not add telemetry, analytics or calls to services the owner did not configure.

## Tests

Tests are required for behavior changes. They live in [`tests/`](tests/) and run with Vitest.

- Add a regression test for every bug fix. The test should fail without the fix.
- Changes to approvals, permissions, cancellation, durable jobs, connectors or the API need tests for the failure paths, not only the happy path.
- Use the fakes in `tests/fixtures/` instead of live services. Tests must not need network access or real keys.
- If you add a new place where the server stores or forwards a secret, extend [`tests/security.test.ts`](tests/security.test.ts).

## Commit messages

Write plain, descriptive messages. Use a short imperative summary line, for example `Refuse expired approvals on resume`, and add a body when the reason is not obvious. No prefix convention is required.

## No secrets in issues or pull requests

Never post API keys, tokens, `.env` files, `data/` contents or databases. A database holds your conversation history and stored credentials. Remove private page content, URLs and names from logs and screenshots.

A good bug report has: the run mode (`npm run dev`, `npm start` or Docker), Node version, operating system, steps to reproduce, expected behavior and actual behavior.

For feature requests, describe the workflow you want before proposing an implementation.

## License

By contributing, you agree that your work is released under the [MIT License](LICENSE). Keep applicable notices for any third-party code or assets you add, and list them in [NOTICE.md](NOTICE.md).
