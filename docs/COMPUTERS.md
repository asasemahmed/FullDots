# A computer for each Dot

FullDots connects each specialist to its own container through [OpenBot](https://github.com/CopilotKit/OpenBot)'s computer service and supervisor. A Dot's ID determines its computer and persistent volumes. Files and browser profiles survive stop/start; they are separate from Spaces pages and conversation history.

The app exposes selected computer tools to the same Dot agent used by web chat, scheduled work, and voice's compute delegation. Browser, workspace-file, and shell permissions are saved per Dot and checked by the server. They start disabled. No action falls back to your host's shell or files when the computer service is unavailable.

## Set up from the app

When FullDots runs on your own computer (`HOST` is loopback and the app is not in a container), a Dot's Computer panel shows **Set up with Docker** whenever computers are not set up. It replaces the commands below with buttons:

1. **Check Docker** runs `docker --version` and `docker info` and tells you whether Docker is missing, stopped or running.
2. **Install Docker Desktop** (`winget` on Windows, `brew` on macOS) or **Start Docker** opens Docker Desktop and waits until it answers.
3. **Create Dot computers** confirms Docker is running, builds the images and starts the supervisor. Only once that works does it add the `COMPUTER_*` values and two new random secrets to `.env`, keeping values you already set, and hand them to the running server, so no restart is needed. The secrets reach Docker Compose through the environment, never in a command line. With `npm run dev`, the server restarts when `.env` changes, which is why it is written last.

**Let a Dot do it.** On the same local install, a Dot whose computer is unavailable can offer to set it up itself with the `docker_setup` tool. Each step appears in the chat as an approval card that lists the exact commands, and nothing runs until you approve it, whatever the Dot's approval mode. The Dot reports each result in a sentence and never shows terminal output; a long build keeps running, and the Dot checks back with `docker_status`.

Every step in the Computer panel first shows the exact commands and runs them only after you choose **Allow and run**. Command output stays hidden; if a step fails, **Technical details** shows what Docker reported. The server runs a fixed list per step, with no shell, and refuses a request whose approved commands differ from that list. On Linux the app only checks Docker and creates the computers; install and start Docker with your system's tools. Set `DOCKER_SETUP=off` to remove the buttons.

## Start services for local development

Use a working Docker Engine with Compose v2 and BuildKit support for additional build contexts. Keep the application on Node.js 24 as described in [Setup](SETUP.md). Add two different random secrets of at least 24 characters to `.env` and set:

```dotenv
COMPUTER_SUPERVISOR_URL=http://127.0.0.1:4312
COMPUTER_SUPERVISOR_TOKEN=REPLACE_WITH_A_RANDOM_SECRET
COMPUTER_TOKEN=REPLACE_WITH_A_DIFFERENT_RANDOM_SECRET
COMPUTER_NAMESPACE=opendots
```

Do not use the placeholder values. The supervisor token authorizes lifecycle requests. The computer token is a master used to derive a different credential for each Dot; the master stays in the application and supervisor.

Build both images before starting the supervisor:

```sh
docker compose -f compose.computers.yml build computer-image computer-supervisor
docker compose -f compose.computers.yml up -d computer-supervisor
npm run dev
```

The computer-image service is a build target, not a shared computer to run. The supervisor creates a container when you start a Dot's computer. In this local arrangement, each computer publishes a dynamic loopback port for the app to reach. Port 4312 is the loopback supervisor endpoint. The local control network uses a normal bridge so Docker can publish that port. The container-app overlay makes the control network internal and removes the host port; the app then connects through service DNS.

Open a Dot's **Computer** panel, enable computer access and the capabilities you want, then choose **Start**. Check its status, navigate to a page, and refresh its screen. Only grant shell access when that Dot needs to run commands.

## Run the application in containers

Configure the existing `OWNER_TOKEN` and `BROWSER_SECRET` as well as the computer secrets. Use the overlay that connects the app to the supervisor and computer network:

```sh
docker compose -f compose.yml -f compose.computers.yml -f compose.computers-app.yml build computer-image computer-supervisor app browser
docker compose -f compose.yml -f compose.computers.yml -f compose.computers-app.yml up -d app browser computer-supervisor
```

Here, the app addresses computers by their container names. Computers have no published host ports. The supervisor lives on a separate control network, and only the supervisor mounts the Docker socket. Neither the web app nor a Dot's computer receives that socket. Changing the namespace changes which containers and volumes are selected; keep it stable and unique for each deployment.

## Use the computer

- **Browser:** navigate and inspect the current page, including screenshots and element snapshots. Browser profiles keep cookies and logins across container restarts. The panel shows the screen live, as Chrome draws it, instead of refreshing a picture. Only one panel at a time can watch a Dot's screen; opening it elsewhere stops it here until you choose **Watch here**. If the live connection cannot be made, the panel falls back to a snapshot every few seconds and offers **Retry live view**.
- **How a Dot drives the browser:** every browser action (open a page, click, type, choose an option, press a key, scroll) returns a fresh list of the page's interactive elements, up to 150, so a Dot acts on what it was just given instead of asking for a new snapshot after each step. `computer_search` searches the web in the Dot's browser (dismissing cookie banners on the search host and rotating across `WEB_SEARCH_ENGINE` on a soft bot block) and returns a compact list of `{title, url, snippet, ref}` results with `snapshotId`, so the Dot can open a result with `computer_click` or `computer_navigate` without reading a full search page dump. `computer_select` chooses an option in a native or custom dropdown by opening it, clicking the matching option, and falling back to typing the text. OpenBot has no select call, so this is built from clicks, typing and keys; it never presses Enter in a plain text field and stops pressing keys once an option has been clicked. If the computer refuses an action because control was just handed back, the Dot refreshes the page and goes on (navigation, keys, scrolling) or is shown the new page before repeating a click or typing. If you hold control, or a site shows a captcha, the Dot is told to stop and wait for you; it never works around either. Screenshots are not sent to the model: it receives only the address and size, and reads the page through its text and elements. The live view in the panel is how you see the screen.
- **Take control:** pause agent input while you click, type, scroll, paste, or press keys directly on the live screen. Click the screen first so it receives the keyboard; Shift+Esc leaves it. Release control when done. The agent must obtain a fresh snapshot before resuming element actions.
- **Files:** list, read, and write text files in the Dot's workspace. Paths must stay relative to that workspace. These files are not automatically added to Spaces pages.
- **Terminal:** run a bounded command inside that Dot's container when shell access is enabled. Command output is displayed; execution does not run on the FullDots host.
- **Activity:** inspect action names, who requested them, and success/failure. The audit record deliberately excludes typed values, file contents, and full commands.
- **Replay:** the panel's **Replay** tab steps through the browser steps of the open conversation: the address and title, what the Dot did, whether it worked, and a small picture of the screen after the step. Use the slider with the arrow keys, Page Up/Down, Home and End, pick a request or the whole conversation, and choose **Jump to live** to return. Steps come from the chat itself, so the tab works without pictures. Pictures are kept per Dot while **Keep a replay** is on in the computer settings (on by default whenever Browser is on): after each page-changing step (open, click, type, choose, key, scroll) the app takes a screenshot inside that same action, so Activity still shows one entry, shrinks it to a JPEG at most 1024 pixels wide, and stores it in the database. When you are watching the live screen, the latest frame is reused instead. Each Dot keeps the newest `COMPUTER_REPLAY_FRAMES` steps (300 by default; 0 keeps none); a conversation's pictures are deleted with it. Pictures show whatever was on the screen, so turn the switch off for a Dot whose pages you do not want stored.
- **Take over from the chat:** when a Dot asks for your help, its card in the chat offers **Take over here**, which opens the computer and takes control in one click. While you hold control, a banner across the panel says the Dot is paused and sees nothing you type, shows why it asked, and offers **Hand back**.

The browser runs headed on a virtual display inside the container (`COMPUTER_BROWSER_MODE=headed`, the default). Search engines and many sites show a captcha far more often to a headless browser, which announces itself as `HeadlessChrome`. Set `COMPUTER_BROWSER_MODE=headless` only if you need to save a little memory. The supervisor replaces a computer only when its image or token changes, so a computer created before you change the mode keeps its old one: stop it, remove its container (`docker rm -f opendots-computer-<dot id>`, which keeps the named profile and workspace volumes), and start it again from the Computer panel.

Stop retains files and browser profiles. The app does not expose a destructive reset action. Stopping the supervisor does not stop its dynamically created computers; stop each Dot's computer first if you want them all offline. Compose does not own those dynamically created containers or volumes. Do not delete named workspace/profile volumes as routine cleanup.

The live screen is a WebSocket from your browser to FullDots, which relays it to the computer; the computer's own address and credential never reach the browser. It uses a one-time ticket obtained through the authenticated API, so the owner token is never placed in a URL. Behind a reverse proxy, allow WebSocket upgrades for `/api/dots/*/computer/stream` and set `APP_ORIGIN`. Revoking Browser access closes an open live screen within a second.

Revoking a capability cancels the application's active request and prevents subsequent actions. Cancellation cannot undo completed side effects, and an upstream browser operation may finish after the request is cancelled. Stop the computer when you need to end all activity in its container. Activity retains the latest 1,000 completed records per Dot, plus pending requests.

The template uses standard Docker container isolation; containers share the host kernel. Shell access permits programs and network access inside the container and can read that Dot's own browser profile. Run this on infrastructure appropriate for that trust level. `COMPUTER_RUNTIME=runsc` can select an already-installed gVisor runtime; the template does not install it or claim stronger isolation by default. It does not configure a restrictive network-egress policy.

## Verify and troubleshoot

Create two Dots and enable the capabilities being tested. Write a file in the first computer, then verify that the second cannot list it. Stop/start the first and verify the file persists. Test a browser session across a restart, takeover and handback, disabled permissions, and pause behavior. Confirm that computer tools fail clearly if the service is unavailable.

A configured endpoint is not evidence that Docker successfully provisioned a computer. An unavailable status can mean the Docker daemon is down, the image was not built, credentials differ, or the app cannot reach the returned computer address. Use the local arrangement for a host-run app and the app overlay for a container-run app. Do not substitute an arbitrary returned service URL or expose the computer API directly to the internet.

The source revision and the narrow per-Dot credential patch are documented in [deployment/computers](../deployment/computers/README.md). On a master-token or image change, the supervisor replaces owned computer containers on their next ensure request, retaining their profile and workspace volumes. This ends any in-flight activity; coordinate updates with active work.

Automated tests use controlled service fixtures for policy, request, and lifecycle behavior. Live Docker, model, and voice checks must be recorded separately from those tests.
