# Deploy FullDots on a Linux VPS

This guide walks through deploying FullDots for a single owner on a plain Linux virtual private server (VPS) with Docker and Caddy for HTTPS. No platform manager or PaaS is required.

## What you get

| Service               | What it does                                                     | Needed   |
| --------------------- | ---------------------------------------------------------------- | -------- |
| `app`                 | FullDots web app, API, and SQLite database                       | Always   |
| `browser`             | Isolated read-only page reader for full search result inspection | Optional |
| `searxng`             | Private web search for Dots when DuckDuckGo blocks server IP     | Optional |
| `computer-supervisor` | Manages one isolated Docker computer per Dot                     | Optional |

Only Caddy is exposed to the public internet on ports 80 and 443. The FullDots `app` service binds to loopback (`127.0.0.1:4310`), and internal helper services run on private Docker networks.

## 1. What you need

- **A Linux VPS.** Ubuntu 24.04 LTS is recommended. Other Linux distributions with Docker support work, but package commands in this guide use Ubuntu.
- **Hardware size:**
  - **Without Dot computers:** 2 vCPU and 4 GB RAM.
  - **With Dot computers:** 8 GB RAM or more. Each running Dot computer container can use up to 2 GB (`COMPUTER_MEMORY_BYTES`) and 2 CPUs (`COMPUTER_CPUS`).
  - **Disk:** At least 10 GB of free disk space for Docker image builds.
- **A domain name or subdomain** (for example, `dots.example.com`). Add a DNS `A` (IPv4) or `AAAA` (IPv6) record pointing to your server's public IP address before proceeding.

## 2. Prepare the server

Log in to your VPS via SSH as `root`.

### 1. Create a non-root user

```sh
adduser fulldots
```

Add the user to the `sudo` group:

```sh
usermod -aG sudo fulldots
```

Set up SSH keys for the new user, then log out and log back in as `fulldots`:

```sh
su - fulldots
mkdir -p ~/.ssh
cp /root/.ssh/authorized_keys ~/.ssh/
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys
```

### 2. Configure the firewall

Allow SSH, HTTP, and HTTPS traffic only:

```sh
sudo ufw default deny incoming
```

```sh
sudo ufw default allow outgoing
```

```sh
sudo ufw allow 22/tcp
```

```sh
sudo ufw allow 80/tcp
```

```sh
sudo ufw allow 443/tcp
```

```sh
sudo ufw enable
```

### 3. Install Docker Engine and the Compose plugin

Follow Docker's official installation documentation for Ubuntu:

- [Install Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [Linux post-installation steps](https://docs.docker.com/engine/install/linux-postinstall/)

Add your user to the `docker` group so you can run Docker without `sudo`:

```sh
sudo usermod -aG docker $USER
```

Log out and log back in for group membership to take effect, then verify:

```sh
docker compose version
```

## 3. Get FullDots

### 1. Clone the repository

```sh
git clone https://github.com/asasemahmed/FullDots.git
```

### 2. Check out the latest release tag

```sh
cd FullDots
```

```sh
git checkout v2.0.0
```

### 3. Create the environment file

```sh
cp .env.example .env
```

## 4. Configure .env

Open `.env` in a text editor:

```sh
nano .env
```

Generate random 32-byte secrets for required tokens:

```sh
openssl rand -base64 32
```

### Required settings

Set these values in `.env`:

```env
OWNER_TOKEN=<24+ random characters generated above>
APP_ORIGIN=https://dots.example.com
BROWSER_SECRET=<24+ random characters generated above>
```

- `OWNER_TOKEN`: The password you enter in your browser to unlock FullDots. Must be at least 24 characters.
- `APP_ORIGIN`: The exact public HTTPS address you open in your browser, without a trailing slash. Connector authentication redirects here; requests from other origins are rejected.
- `BROWSER_SECRET`: A shared secret between the app and the optional page reader container.

### Optional settings for a VPS

Configure optional features based on your server size and needs. Every variable below is documented in `.env.example`.

#### 1. Private search with SearXNG

DuckDuckGo frequently blocks VPS IP addresses with bot checks. Enable private SearXNG search:

```env
COMPOSE_PROFILES=search
WEB_SEARCH_PROVIDER=searxng
SEARXNG_URL=http://searxng:8080
WEB_SEARCH_ENGINE=brave,startpage,bing,duckduckgo
```

#### 2. Dot computers

To give each Dot its own container with a browser, filesystem, and shell:

```env
COMPOSE_PROFILES=search,browser,build-computers
COMPUTER_SUPERVISOR_URL=http://computer-supervisor:4300
COMPUTER_SUPERVISOR_TOKEN=<24+ random characters>
COMPUTER_TOKEN=<different 24+ random characters>
COMPUTER_NAMESPACE=opendots
COMPUTER_MEMORY_BYTES=2147483648
COMPUTER_CPUS=2
COMPUTER_BROWSER_MODE=headed
```

Keep `COMPUTER_NAMESPACE` unchanged for the life of the deployment. It determines container and volume names.

#### 3. Default model provider

You can provide credentials for a default provider in `.env`, or configure providers later in **Settings → Models**:

```env
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o
```

## 5. Start FullDots

Run the command corresponding to your configuration.

### (a) App only (with page reader)

```sh
docker compose -f compose.yml --profile browser up -d --build
```

### (b) App with Dot computers and SearXNG

```sh
docker compose -f compose.yml -f compose.computers.yml -f compose.computers-app.yml --profile search --profile browser --profile build-computers up -d --build
```

The initial build takes several minutes to compile TypeScript, build the client bundle, and download container images.

Verify that all containers are healthy:

```sh
docker compose ps
```

## 6. HTTPS with a reverse proxy

FullDots binds to `127.0.0.1:4310` on the host, as defined in `compose.yml`. It is not directly accessible from the internet. Use [Caddy](https://caddyserver.com) to provide automatic HTTPS certificates and route traffic to the app.

### 1. Install Caddy

Follow official instructions to install Caddy on Ubuntu:

```sh
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
```

```sh
curl -1sLF 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
```

```sh
curl -1sLF 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
```

```sh
sudo apt update && sudo apt install -y caddy
```

### 2. Configure Caddyfile

Replace `/etc/caddy/Caddyfile` with your domain:

```caddy
dots.example.com {
    reverse_proxy 127.0.0.1:4310
}
```

Caddy automatically handles WebSocket connections (used by the live computer view) and Server-Sent Events (used by chat streaming) without extra headers or timeout rules.

### 3. Reload Caddy

```sh
sudo systemctl reload caddy
```

Caddy obtains a Let's Encrypt or ZeroSSL certificate and starts serving your site at `https://dots.example.com`.

## 7. First sign-in and model setup

1. Open `https://dots.example.com` in your browser.
2. Enter your `OWNER_TOKEN` at the lock screen.
3. Open **Settings → Models** to configure your model providers (OpenAI, Anthropic, Google Gemini, Groq, Ollama, OpenRouter, and others). See [Models](MODELS.md).
4. Create your first Dot or team.

## 8. Backups

All state is stored in the Docker named volume `opendots-data` (mounted at `/data` in the container). It contains:

- `opendots.sqlite`: Conversations, pages, Spaces, tasks, triggers, and audit history.
- `connector.key`: The cryptographic key that encrypts stored model keys and connector tokens.

> [!IMPORTANT]
> A backup of `opendots.sqlite` is useless without `connector.key`. Always back up both files together.

### Manual backup

Run a temporary container to archive the volume to a local directory:

```sh
mkdir -p "$HOME/backups"
```

```sh
docker run --rm -v fulldots_opendots-data:/data -v "$HOME/backups":/backup alpine tar czf /backup/fulldots-$(date +%F).tgz -C /data .
```

Confirm the volume name with `docker volume ls | grep opendots-data`. If Docker used a different prefix, replace `fulldots_opendots-data` with your volume name.

### Manual restore

To restore from a backup archive:

```sh
docker compose down
```

```sh
docker run --rm -v fulldots_opendots-data:/data -v "$HOME/backups":/backup alpine tar xzf /backup/fulldots-YYYY-MM-DD.tgz -C /data
```

```sh
docker compose -f compose.yml up -d
```

### Automated daily cron backup

Create a daily cron job that writes an archive and removes backups older than 14 days:

```sh
crontab -e
```

Add this line (runs at 03:00 UTC daily):

```cron
0 3 * * * docker run --rm -v fulldots_opendots-data:/data -v /home/fulldots/backups:/backup alpine tar czf /backup/fulldots-$(date +\%F).tgz -C /data . && find /home/fulldots/backups -name "fulldots-*.tgz" -mtime +14 -delete
```

## 9. Updating

### 1. Create a backup

Always create a backup before updating:

```sh
docker run --rm -v fulldots_opendots-data:/data -v "$HOME/backups":/backup alpine tar czf /backup/fulldots-pre-update-$(date +%F).tgz -C /data .
```

### 2. Fetch the new release

```sh
git fetch origin --tags
```

```sh
git checkout <new-tag>
```

Check [CHANGELOG.md](../CHANGELOG.md) under the release's **Upgrading** section for migration instructions.

### 3. Rebuild and restart

```sh
docker compose -f compose.yml -f compose.computers.yml -f compose.computers-app.yml --profile search --profile browser --profile build-computers up -d --build
```

Database migrations run automatically at startup. SQLite columns and tables are added dynamically without data loss.

### 4. Updating Dot computers

Existing Dot computer containers keep their original environment and image until recreated (see [Dot computers](COMPUTERS.md)). To update a Dot's container after an image or mode change:

1. Stop the computer from its panel in the web interface.
2. Remove the container on the VPS:

```sh
docker rm -f opendots-computer-<dot-id>
```

3. Choose **Start** in the Dot's Computer panel.

The Dot's browser profile volume (`opendots-profile-<dot-id>`) and workspace volume (`opendots-workspace-<dot-id>`) are preserved.

## 10. Troubleshooting

### 1. App container exits immediately on startup

Check container logs:

```sh
docker compose logs app
```

If logs show `Set a 24+ character OWNER_TOKEN in .env`, set `OWNER_TOKEN` in `.env` to at least 24 random characters. Also check that `BROWSER_SECRET` is set when you use the page reader (`--profile browser`); `compose.yml` does not stop on a missing one, but the app and the page reader must share the same value.

### 2. 502 Bad Gateway from Caddy

Verify Caddy service status:

```sh
sudo systemctl status caddy
```

Check that the FullDots app is listening on loopback port 4310:

```sh
curl -I http://127.0.0.1:4310/
```

If connection is refused, verify the container is running:

```sh
docker compose ps app
```

### 3. "Enter your owner access token" rejected

Verify the value in `.env`:

```sh
grep OWNER_TOKEN .env
```

Ensure the token has no trailing spaces or surrounding quotes. If you modified `.env`, restart the container:

```sh
docker compose restart app
```

### 4. Dot computers show "unavailable" or will not start

Inspect supervisor logs:

```sh
docker compose -f compose.yml -f compose.computers.yml -f compose.computers-app.yml logs computer-supervisor
```

Common causes:

- The supervisor cannot access `/var/run/docker.sock`.
- `COMPUTER_SUPERVISOR_TOKEN` or `COMPUTER_TOKEN` is missing or mismatched.
- The `computer-image` was not built. Rebuild with `--profile build-computers`.

### 5. "DuckDuckGo is blocking searches from this server's IP address"

DuckDuckGo routinely blocks search requests from commercial VPS IP ranges. Check SearXNG container status:

```sh
docker compose logs searxng
```

Verify that `.env` includes `COMPOSE_PROFILES=search` and `WEB_SEARCH_PROVIDER=searxng`. SearXNG is not published on a host port, so test it from inside the app container, which reaches it as `searxng`:

```sh
docker compose exec app node -e "fetch('http://searxng:8080/search?q=test&format=json').then((r) => r.text()).then((t) => console.log(t.slice(0, 200)))"
```
