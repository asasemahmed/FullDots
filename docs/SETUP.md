# Running FullDots

FullDots runs a React app and a Node server. The server stores pages, Space and Dot configuration, and conversation history in SQLite, and calls your configured model provider.

## Local development

Use Node.js 24 and npm.

```sh
npm ci
cp .env.example .env
npm run dev
```

Open http://127.0.0.1:5173. The API runs on port 4310. Without a model key, the app shows its setup state; it does not generate simulated replies.

For a built local app:

```sh
npm run build
npm start
```

Open http://127.0.0.1:4310. Keep the server running for background work.

## Model and storage

Model keys can now be added in **Settings → Models**, for several providers at once. See [Models](MODELS.md). `.env` still works: the variables below define the built-in default provider. Edit `.env` on the server and restart after changes:

| Variable                         | Purpose                                                         |
| -------------------------------- | --------------------------------------------------------------- |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Built-in default provider: its key and default model            |
| `OPENAI_BASE_URL`                | Built-in default provider: compatible model API endpoint        |
| `MODEL_PROVIDERS_ALLOW_LAN`      | Lets local providers (Ollama, LM Studio) run on another machine |
| `OWNER_ID`                       | Stable identity used for this deployment's conversations        |
| `DATABASE_PATH`                  | SQLite file containing pages, workspace and work metadata       |
| `OWNER_TOKEN`                    | Application access token; required for external bindings        |
| `APP_ORIGIN`                     | Exact browser origin when using a proxy or custom domain        |

Keys added in Settings → Models are encrypted with `CONNECTOR_SECRET_KEY` or `data/connector.key`. A database backup can restore them only with that same key.

Any OpenAI-compatible provider works; for OpenRouter set `OPENAI_BASE_URL=https://openrouter.ai/api/v1`. Provider credentials belong in `.env`, not client-side variables or source code. Conversation history is stored in the same SQLite file (`chat_runs` and `chat_threads` tables), so backing up `DATABASE_PATH` backs up everything. Telemetry is disabled in code: FullDots sets CopilotKit's telemetry opt-out flags before anything loads.

## Pages and page conversations

Select a Space to open its page library. Search for a document, switch between grid and list views, or create a new page. The visual editor supports formatting, headings, lists, checklists, tables, and slash commands. Use `/` to insert a block and Cmd/Ctrl+S to save immediately. Pages autosave after editing pauses; the save status tells you whether changes reached the server.

Page actions include creating subpages, moving a page within its Space, and editing Markdown source. Existing documents with unsupported visual-editor syntax stay in source mode to preserve their content. Manual editing works without a model key.

Open a page's chat and choose a specialist with access to that Space. Grant access from the Dot’s settings in the sidebar. The server creates or reuses a local conversation for that page and specialist. The Dot receives the current saved page as context and can read, create, and edit pages in its authorized Spaces. The page conversation uses that page’s Space by default; other chats use the Dot’s default page destination. Save your manual edits before asking it to revise the document. Revision checks reject stale writes; a conflict keeps your local draft available for recovery. Failed saves stop automatic retries until you retry or resolve the conflict, so a disconnected session does not silently replace newer content.

Use the conversation's save-to-page action to create a document from its saved text history. This requires a configured model. Pages retain a link to the source conversation, and page links in chat open the document workspace.

Back up the SQLite database: it contains page content, thread bindings, and conversation history. The template does not include multi-user page sharing, realtime collaboration, file uploads, or arbitrary interactive embeds.

## Web search and page reader

Dots search the public web with DuckDuckGo (`WEB_SEARCH_PROVIDER=duckduckgo`, the default). No API key is needed; search queries are sent to DuckDuckGo. Set `WEB_SEARCH_PROVIDER=disabled` to turn off search and research tools. Workspace and Dot research permissions, pause, and cancellation still apply.

To let Dots read search results in full, run the read-only page reader. Configure `BROWSER_URL` and `BROWSER_SECRET`, then run:

```sh
npx playwright install chromium
npm run browser
```

Use the same secret on the app and browser processes. Browser navigation is read-only with JavaScript disabled. Private addresses, redirects, and authenticated pages are unsupported; provide a canonical public URL. This is a bounded research tool, not a general desktop or shell.

## Persistent Dot computers

For a separate browser, persistent files, and optional shell for each specialist, follow [Computer setup](COMPUTERS.md). This uses pinned OpenBot computer/supervisor services and per-Dot permissions. Search and the page reader remain available alongside configured computer tools; use the computer for JavaScript-heavy or interactive pages. Enable each Dot's required capabilities before use.

## Work limits and per-Dot models

Each Dot can use its own provider and model: open the Dot's settings and pick a model, or leave it on Default to use the default model. See [Models](MODELS.md).

How long and how far a Dot may work is set in `.env`; see the commented block in `.env.example` for every setting and its default. Times are in seconds. For example, to let a Dot work for up to ten minutes with thirty tool steps and run shell commands for up to ten minutes:

```dotenv
AGENT_TURN_TIMEOUT=600
AGENT_MAX_STEPS=30
COMPUTER_EXEC_MAX_TIMEOUT=600
```

A step is one reply from the model together with its tool calls; `AGENT_MAX_STEPS` accepts 1 to 1000. A Dot never ends a turn mid-sentence: the last step it is allowed is spent without tools on a short summary of what it did, what is left, and what it needs from you. When `AGENT_TURN_TIMEOUT` passes, the Dot gets `AGENT_TURN_GRACE` more seconds (20 by default) to write that summary before the turn is stopped, and if it is stopped it says so in the conversation. Set `AGENT_TURN_TIMEOUT=0` or `TASK_TIMEOUT=0` for no time limit on a Dot's turn or on a scheduled task run (scheduled runs and calls internally stop after 24 hours, so a crashed run is eventually retried); steps, tokens and the computer limits still apply. A scheduled run or a call stops its turn when its own limit passes, so keep `TASK_TIMEOUT` above `AGENT_TURN_TIMEOUT` plus the grace period if you want the summary to be written.

Shell commands and file writes are capped by the OpenBot computer itself (10 minutes and 1 MB). The computer request timeout is raised automatically so it always outlives the longest shell command. Restart the server after changing these values.

## Calls

The included speech adapter uses the Realtime API at `api.openai.com`. Set `VOICE_API_KEY` to a key with access to that API and `VOICE_MODEL` to a supported Realtime model (the local UI test used `gpt-realtime-2.1`); `VOICE_NAME` selects the voice. `OPENAI_BASE_URL` changes the compute model endpoint only, not speech. Calls use browser microphone access and WebRTC. Hosted deployments need HTTPS. The server mediates provider setup and delegates compute to the selected Dot's conversation.

A configured key is not evidence of a successful call. Verify microphone access, audio playback, compute delegation, interruption, hangup, and the saved receipt with your deployment before relying on voice workflows.

## Containers

Set `OWNER_TOKEN` and `BROWSER_SECRET` to different random secrets of at least 24 characters in `.env`, then run:

```sh
docker compose up --build -d
```

Open http://localhost:4310. The app port binds to loopback. The browser service is optional: set a 24+ character `BROWSER_SECRET` and run `docker compose --profile browser up --build` to enable it; it has no published port. Application data lives in the `opendots-data` volume, mounted at `/data`: the SQLite database (conversations, pages, workspace) and, unless you set `CONNECTOR_SECRET_KEY`, the generated `connector.key` that encrypts saved model keys and connector sign-ins. Keep both together when you back up. Set `APP_ORIGIN` if you open FullDots at an address other than `http://localhost:4310`; browser sign-in for connectors redirects there.

`compose.yml` passes through the variables listed in `.env.example` (model, voice, search, connector, approval, and limit settings). A connector's own secret, such as `GITHUB_TOKEN`, is passed through only if you add a line for it under `environment:` in `compose.yml`.

Inside a container, `localhost` is the container itself. To use Ollama or LM Studio running on the host, set the provider's base URL to `http://host.docker.internal:11434/v1` (or the LM Studio port) and set `MODEL_PROVIDERS_ALLOW_LAN=true` in `.env`.

```sh
# Stop services while retaining saved data.
docker compose down
```

For remote hosting, configure an HTTPS reverse proxy and the matching `APP_ORIGIN`. See [Security](../SECURITY.md) for the template's deployment boundary.

## Development checks

```sh
npm run check-format
npm run lint
npm run typecheck
npm test
npm run build
```

Automated tests use service fixtures. Live model and voice verification requires your own configured services.
