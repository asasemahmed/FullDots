# Deploy FullDots on Dokploy

[Dokploy](https://dokploy.com) is a self-hosted platform that builds and runs Docker apps on your own server. It gives HTTPS, domains, environment variables and redeploys on every push to GitHub. This guide deploys FullDots from your GitHub repository with `compose.dokploy.yml`.

## What you get

| Service               | What it does                                                      | Needed   |
| --------------------- | ----------------------------------------------------------------- | -------- |
| `app`                 | FullDots itself: web app, API and the SQLite database in a volume | Always   |
| `browser`             | The page reader that lets Dots read web pages in full             | Always   |
| `searxng`             | Private web search for Dots when DuckDuckGo blocks your server    | Optional |
| `computer-supervisor` | Starts one isolated computer per Dot (browser, files, terminal)   | Optional |

Only `app` is reachable from the internet, through Dokploy's proxy on your domain with HTTPS. The page reader, SearXNG and the supervisor sit on internal networks.

## Before you start

- **A server with Dokploy installed.** Any Linux VPS works (Ubuntu 24.04 is a good choice). Run Dokploy's one-line installer as root on a fresh server: `curl -sSL https://dokploy.com/install.sh | sh`, then open `http://<server-ip>:3000` and create the admin account.
- **Size:** 2 vCPU and 4 GB RAM for FullDots without computers. With Dot computers, plan 8 GB RAM or more: each running computer gets up to 2 GB (`COMPUTER_MEMORY_BYTES`) and 2 CPUs (`COMPUTER_CPUS`). Builds need about 10 GB of free disk.
- **A domain or subdomain** such as `dots.example.com`, with an `A` record pointing to the server's IP. Create the record before you add the domain in Dokploy, so the HTTPS certificate can be issued.
- **The code on GitHub.** Dokploy builds what is on the branch you choose, so push your commits first.

## 1. Connect GitHub to Dokploy

1. In Dokploy, open **Settings → Git → GitHub** and choose **Create GitHub App**.
2. GitHub asks you to name the app and install it. Install it on your account and give it access to the `FullDots` repository (or all repositories).
3. Back in Dokploy the GitHub provider now shows as connected. Pushes to the repository can now trigger deploys.

## 2. Create the service

1. **Projects → Create Project**, for example `FullDots`.
2. Inside it, **Create Service → Compose**. Name it `fulldots`.
3. In the **General** tab:
   - **Provider:** GitHub
   - **Repository:** `FullDots`, **Branch:** `main`
   - **Compose Path:** `./compose.dokploy.yml`
   - **Compose type:** Docker Compose
4. Turn on **Autodeploy** so each push to `main` redeploys.

## 3. Set the environment

Open the **Environment** tab and paste the variables below, with your own values. Generate each secret separately, for example with `openssl rand -base64 32`. Never reuse one secret for two variables.

```env
# Required
OWNER_TOKEN=<24+ random characters: you type this to unlock FullDots>
APP_ORIGIN=https://dots.example.com
BROWSER_SECRET=<24+ random characters>

# Optional: a default model provider. You can also add providers later in Settings > Models.
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=
```

- `APP_ORIGIN` must be exactly the address you open in the browser, with `https://` and without a trailing slash. Connector sign-in redirects there, and requests from any other origin are refused.
- Model keys you add in **Settings → Models** are encrypted with `connector.key`, which is created in the data volume on first start.

Save, then continue with the domain before the first deploy.

## 4. Add the domain

Open the **Domains** tab, **Add Domain**:

- **Service name:** `app`
- **Host:** `dots.example.com`
- **Path:** `/`
- **Container port:** `4310`
- **HTTPS:** on, **Certificate:** Let's Encrypt

The live updates (server-sent events) and the live computer screen (WebSocket) work through Dokploy's proxy without extra settings.

## 5. Deploy

Press **Deploy**. The first build takes several minutes: it installs dependencies, builds the web app, and downloads Chromium for the page reader. Follow it in the **Deployments** tab. When `app` shows as healthy, open `https://dots.example.com` and enter your `OWNER_TOKEN`.

Then, in FullDots: **Settings → Models** to add a provider and pick the default model, and create your Dots and teams.

## 6. Backups

Everything FullDots stores lives in the `fulldots-data` volume: the SQLite database and `connector.key`. Without the key, saved model keys and connector sign-ins cannot be read, so always back up both together.

- **In Dokploy:** **Volume Backups** on the compose service, volume `fulldots-data`, to an S3-compatible destination (add one under **Settings → Destinations**), on a schedule such as daily.
- **By hand on the server:**

  ```sh
  docker run --rm -v <project>_fulldots-data:/data -v "$PWD":/backup alpine \
    tar czf /backup/fulldots-$(date +%F).tgz -C /data .
  ```

  Find the exact volume name with `docker volume ls | grep fulldots-data`.

Redeploys keep the volume. Do not delete it from Dokploy unless you mean to erase everything.

## 7. Recommended: private web search

Dots search with DuckDuckGo by default, and DuckDuckGo blocks many VPS addresses. A Dot then reports that DuckDuckGo is blocking searches from the server's IP address. The fix is the `searxng` service: your own [SearXNG](https://docs.searxng.org), which asks several search engines for FullDots. No API key and no account are needed.

Add to the **Environment** tab:

```env
COMPOSE_PROFILES=search
WEB_SEARCH_PROVIDER=searxng
```

Redeploy. SearXNG starts next to the app with no public port, and the app reaches it at `http://searxng:8080` (the default `SEARXNG_URL`). Its settings live in [`deployment/searxng/settings.yml`](../deployment/searxng/settings.yml) in the repository: JSON results on, bot limiter off, SearXNG's default engines. Change that file and redeploy to adjust it. With Dot computers too, list both profiles: `COMPOSE_PROFILES=search,computers`.

Some engines may still refuse a server address now and then. SearXNG then uses the others, and a Dot names the engines that did not answer if none did.

## 8. Optional: Dot computers

Each Dot can have its own computer (a browser it can drive, files, a terminal). On a server this needs the computer supervisor.

**Read this first.** The supervisor mounts the server's Docker socket so it can start containers. Anything that controls that socket controls the server's Docker, including Dokploy's own containers. The supervisor is pinned, hardened and reachable only on an internal network with its own token, and FullDots itself never gets the socket. Still, enable computers only on a server you dedicate to FullDots, and keep shell access off for Dots that do not need it.

To enable, add to the **Environment** tab (with private search on, use `COMPOSE_PROFILES=search,computers`):

```env
COMPOSE_PROFILES=computers
COMPUTER_SUPERVISOR_URL=http://computer-supervisor:4300
COMPUTER_SUPERVISOR_TOKEN=<24+ random characters>
COMPUTER_TOKEN=<a different 24+ random characters>
COMPUTER_NAMESPACE=fulldots
```

Redeploy. The first build also builds the computer image from the pinned OpenBot revision, which takes a while. Each Dot's computer is created the first time you start it from its computer panel. Computers and their volumes are not part of the compose project, so Dokploy does not remove them on redeploy. Keep `COMPUTER_NAMESPACE` the same for the life of the deployment.

## Updating

Push to `main`. With Autodeploy on, Dokploy rebuilds and restarts. Database changes run automatically at start and only add tables and columns. Back up first before large updates.

## Troubleshooting

- **The deploy stops at once with "Set OWNER_TOKEN…" (or `APP_ORIGIN`, `BROWSER_SECRET`).** The variable is missing from the Environment tab.
- **The page loads but says "Enter your owner access token".** That is the lock screen. Enter `OWNER_TOKEN`.
- **"Cross-origin requests are not allowed" or "Unrecognized host".** `APP_ORIGIN` does not match the address in your browser exactly.
- **No HTTPS certificate.** The DNS record does not point to the server yet, or ports 80 and 443 are closed in the server's firewall.
- **"The AI provider is overloaded right now".** The model provider is busy. FullDots already retried. Try again shortly or choose another model.
- **"DuckDuckGo is blocking searches from this server's IP address".** Turn on private search (section 7). Waiting does not help.
- **"Could not reach SearXNG at http://searxng:8080".** `COMPOSE_PROFILES` does not include `search`, or the `searxng` container is not running. Check its logs in Dokploy.
- **A Dot's computer shows as unavailable.** Check that `COMPOSE_PROFILES=computers` is set, that both computer tokens are set, and that `computer-supervisor` is healthy in Dokploy.
