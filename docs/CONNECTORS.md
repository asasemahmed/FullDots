# Connectors

A connector gives a Dot tools that live outside FullDots, such as issues in GitHub or pages in Notion. FullDots loads each connector's tool list and offers those tools only to the Dots you grant them to. Approvals for connector actions are described in [Approvals](APPROVALS.md).

A connector can sign in with the browser (OAuth) or use a token from `.env` on the server. Some connectors need no sign-in. See [Browser sign-in](#browser-sign-in) and [Presets](#presets).

## What a connector is

A connector is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server. FullDots supports two transports:

- **Streamable HTTP** (`http`): a server at an `http://` or `https://` URL. Most hosted services use this.
- **stdio** (`stdio`): a program that FullDots starts on the same machine. FullDots talks to it through standard input and output. This is off until you set `CONNECTORS_ALLOW_STDIO=true`. See [Local programs](#local-programs-stdio-and-host-trust).

A Dot sees each connector tool as `mcp__<connector>__<tool>`. The name uses only letters, digits, `_` and `-`, and is at most 64 characters. If two connectors would produce the same name, the second one shows an error and its tools are not offered.

## Add a connector

1. Open **Settings** and find **Connectors** under Service setup.
2. Choose **Add connector**. Pick a preset (see [Presets](#presets)), or fill in the custom form: a name, a transport, and either a URL (Streamable HTTP) or a command, arguments and working directory (stdio).
3. For each header or environment row, choose **env** to name an environment variable, or **literal** to type a value that is not a secret. See [Environment references](#environment-references-and-secrets).
4. Save. Names can be up to 40 characters: letters, digits, spaces, `_` and `-`, starting with a letter or digit. Each name is unique.

A connector shows one of these states:

| State         | Meaning                                                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connecting`  | FullDots is connecting. Its tools are not offered to Dots yet.                                                                                                   |
| `connected`   | Its tools are loaded and can be granted.                                                                                                                         |
| `needs_auth`  | Not connected. A browser sign-in connector has no tokens yet, or the service revoked access. Its tools are not offered. See [Browser sign-in](#browser-sign-in). |
| `missing_env` | An environment variable it needs is not set. The missing names are listed.                                                                                       |
| `error`       | Connecting or validation failed. The message is shown with secrets removed.                                                                                      |
| `disabled`    | The connector is turned off. Its tools are not offered.                                                                                                          |

Use **Test** to check a connector and **Reload** to reconnect and reload its tool list.

Connectors start in the background when the server starts. If a connector is still connecting when a turn starts, that turn gets no tools from it. A dropped connection is retried after 1, 2, 5, 15 and then 60 seconds. Each tool call times out after 30 seconds by default (`callTimeoutMs`, between 1 second and 10 minutes).

## Presets

Presets fill in the URL or command, the headers and the environment variables. Vendor URLs and package names can change, so check the docs link in Settings before you rely on a preset.

The **How it signs in** column says how the preset connects:

- **Browser sign-in**: choose **Connect with browser**. See [Browser sign-in](#browser-sign-in).
- **Token in .env**: put the token in `.env` on the server and restart the server.
- **No sign-in**: the endpoint needs no credentials.
- **Local program**: FullDots starts a program on this machine. This needs `CONNECTORS_ALLOW_STDIO=true`.

The **Token alternative** column names the environment variable for a token. For a browser sign-in preset, it is the option under **Use a token instead**. For a token preset, it is the variable the connector reads.

## Discover servers

**Discover** is the second tab on **Settings → Connectors**. It searches the public [MCP registry](https://registry.modelcontextprotocol.io) for servers you might connect to, and lists each result with its name, description, version and a link to its repository.

- **Off by default.** Set `CONNECTORS_REGISTRY_SEARCH=true` in `.env` and restart FullDots to turn it on. While it is off, the tab explains how and shows no search box. The route answers `403` with a message that says how to turn it on.
- **Your search text leaves this machine.** Each search sends the text you type to `registry.modelcontextprotocol.io`. The request carries only that text and the paging values the registry needs. It has no cookies, no account and no connector values. Leave the setting off if you do not want the text to leave the machine.
- **The registry matches server names, not descriptions.** A search for "weather" finds `io.github.example/weather`, but not a server whose only mention of weather is in its description.
- **Add opens a form to review. Nothing else happens.** A result with a hosted endpoint, or a local npm or PyPI package, has an **Add** button. It opens the connector form already filled in. Nothing is saved, connected or run until you press **Save** in that form. Saving uses the same route as a connector you make by hand, so sign-in, encryption and tool grants work the same way.
- **Hosted servers.** The form gets the name (the server's title, else the last part of its registry name), the address, and a Streamable HTTP connector. Only `https` addresses can be added from here. An address is refused when it has credentials in it, or when it points at this machine or a private network: `localhost`, a loopback, private, link-local or shared (CGNAT) IP address, a single-word name, or a name ending in `.local` or `.internal`. The check reads the address as written. It does not look up where a public name points, so a public name that resolves to a private address is not caught. The form still lets you change the address by hand after you press Add, so read it before you press Save. An address with a placeholder in braces, such as `{region}`, needs a value, so add that one by hand with **Custom connector**.
- **Local programs.** The Add button needs `CONNECTORS_ALLOW_STDIO=true`. While it is off, the button is disabled and says why, with a link to [Local programs](#local-programs-stdio-and-host-trust). With it on, the form shows the exact command, pinned to the version the registry gives: `npx -y <package>@<version>` for npm, and `uvx <package>==<version>` for PyPI. It never uses `latest`. The form also lists each environment variable the package declares, with an empty value. Enter the name of a variable in the server's `.env` that holds its value, as for any local program. Save stays blocked until every one has a value. The line "This program will run on this machine when a Dot uses the connector" is shown above Save.
- **Not supported yet.** Packages from other registries (for example OCI images or NuGet), packages that run their own web server, and packages whose version is not a plain number such as `1.2.3`. A version of `latest` or a range such as `^1.2` is never pinned, so those packages are added by hand. The form does not fill in the package's own required arguments, such as a folder for a filesystem server. Add those under **Arguments** before you save.
- **The badges say how a server runs.** **Remote** is a hosted endpoint. **Local program** is a program FullDots would start on this machine.
- **Results are cached for 24 hours** on the server, per search and page, so repeat searches do not query the registry again. The cache holds up to 200 searches and is cleared when FullDots restarts.
- **Limits.** The registry is contacted with a 10-second timeout. An answer over 1 MB, a redirect, or an answer FullDots cannot read is refused, and the tab shows a short message.

| Service           | How it signs in | Endpoint                                         | Token alternative       |
| ----------------- | --------------- | ------------------------------------------------ | ----------------------- |
| `github`          | Token in .env   | `https://api.githubcopilot.com/mcp/`             | `GITHUB_TOKEN`          |
| `paypal`          | Token in .env   | `https://mcp.paypal.com/http`                    | `PAYPAL_ACCESS_TOKEN`   |
| `notion`          | Browser sign-in | `https://mcp.notion.com/mcp`                     | —                       |
| `linear`          | Browser sign-in | `https://mcp.linear.app/mcp`                     | `LINEAR_API_KEY`        |
| `atlassian`       | Browser sign-in | `https://mcp.atlassian.com/v2/mcp`               | —                       |
| `asana`           | Browser sign-in | `https://mcp.asana.com/v2/mcp`                   | —                       |
| `intercom`        | Browser sign-in | `https://mcp.intercom.com/mcp`                   | `INTERCOM_ACCESS_TOKEN` |
| `sentry`          | Browser sign-in | `https://mcp.sentry.dev/mcp`                     | `SENTRY_ACCESS_TOKEN`   |
| `huggingface`     | Browser sign-in | `https://huggingface.co/mcp`                     | `HF_TOKEN`              |
| `cloudflare`      | Browser sign-in | `https://mcp.cloudflare.com/mcp`                 | `CLOUDFLARE_API_TOKEN`  |
| `cloudflare-docs` | No sign-in      | `https://docs.mcp.cloudflare.com/mcp`            | —                       |
| `supabase`        | Browser sign-in | `https://mcp.supabase.com/mcp`                   | `SUPABASE_ACCESS_TOKEN` |
| `neon`            | Browser sign-in | `https://mcp.neon.tech/mcp`                      | `NEON_API_KEY`          |
| `stripe`          | Browser sign-in | `https://mcp.stripe.com`                         | `STRIPE_AGENT_API_KEY`  |
| `filesystem`      | Local program   | `npx -y @modelcontextprotocol/server-filesystem` | —                       |
| `fetch`           | Local program   | `uvx mcp-server-fetch`                           | —                       |
| `google-drive`    | Local program   | `npx -y @modelcontextprotocol/server-gdrive`     | —                       |
| `gmail`           | Local program   | `npx -y @gongrzhe/server-gmail-autoauth-mcp`     | —                       |

Notes on specific presets:

- `sentry`: the token variable must hold the whole value `Sentry-Bearer <token>`. FullDots sends it as given.
- `stripe`: use a restricted API key. Stripe asks for its own confirmation before write actions.
- `filesystem`: add the directory to expose as the last argument. Access is limited to that directory.
- `google-drive` and `gmail`: run the program once to finish Google sign-in. See each preset's docs link.
- The stdio presets need `CONNECTORS_ALLOW_STDIO=true`. Without it, saving a stdio connector is refused.

## Browser sign-in

To connect a service with your browser:

1. Open **Settings → Connectors** and pick the service.
2. Choose **Connect with browser**.
3. Sign in on the service's page in the pop-up. The pop-up closes when sign-in finishes, and the connector shows **Connected**.

If the browser blocks the pop-up, choose **Open the sign-in page** in the connector sheet. Use that link to open the sign-in page in a new tab.

FullDots registers itself with the service automatically (dynamic client registration). You do not create an OAuth app or enter a client ID.

### Redirect address

The service sends you back to `<APP_ORIGIN>/api/connectors/oauth/callback`.

- Open FullDots at exactly `APP_ORIGIN`. If you open it at another address, the sign-in pop-up may not report back to the main window.
- If `APP_ORIGIN` is not set, FullDots uses `http://<HOST>:<PORT>`. In development it uses `http://127.0.0.1:5173`. Set `APP_ORIGIN` in `.env` when you open FullDots at a different address.
- Services accept only `http://localhost`, `http://127.0.0.1` or `https://` addresses. A LAN address such as `http://192.168…` will not work. For remote access, put FullDots behind an HTTPS reverse proxy and set `APP_ORIGIN` to that HTTPS address.
- Intercom accepts only `localhost` and `127.0.0.1`. Set `APP_ORIGIN` to one of them, and open FullDots at that address.

### What FullDots stores

After sign-in, FullDots stores:

- the access token and the refresh token,
- the client registration that the service issued to FullDots.

These values are encrypted with AES-256-GCM in the local SQLite database. The key comes from `CONNECTOR_SECRET_KEY` (64 hex characters, or base64 of 32 bytes). If that variable is not set, FullDots creates a key once at `data/connector.key`, next to the database.

- Keep the key with the database. If the key is lost, the stored tokens cannot be read. The connector then shows **Not connected**, and you sign in again.
- Changing `CONNECTOR_SECRET_KEY` has the same effect. Restart the server after you change it.
- On Windows, FullDots does not restrict the key file's permissions. Protect the `data` folder yourself.

Tokens are never shown in the app, never sent to the browser and never logged. They are masked in tool results.

### Refresh, disconnect and delete

- Tokens refresh automatically when the connection needs them.
- If a service revokes access, the connector shows **Not connected**. A Dot that uses the connector gets a message that it needs to be connected in Settings.
- **Disconnect** removes the stored tokens. FullDots also asks the service to revoke them, when the service supports that. Dots keep their grants, but they get no tools from the connector until you connect again.
- **Delete** removes the connector, its stored tokens and its registration.

### Not supported yet

- **GitHub**: use a token (`GITHUB_TOKEN`).
- **Google Workspace**: needs your own Google Cloud OAuth client. Use the `google-drive` or `gmail` local program presets for now.
- **Figma** and **Vercel**: these services accept only approved clients.

## Environment references and secrets

- FullDots does not store the values of secrets from `.env`. They are not kept in the database, in saved settings, in API responses or in the UI. The exception is tokens from [browser sign-in](#browser-sign-in). Those are stored encrypted.
- Put secret values in environment variables, in `.env` on the server, for example `GITHUB_TOKEN=`. Restart the server after you change them.
- A connector refers to a variable by name, for example `{ env: "GITHUB_TOKEN" }`. Settings shows the name and whether the variable is set. It never shows the value.
- Variable names use uppercase letters, digits and `_`, and start with a letter or `_`.
- A header or environment name that looks like a secret must be a reference. A name is treated as secret when it contains `authorization`, `key`, `token`, `secret`, `password` or `cookie`, in any letter case. A literal value for such a name is refused.
- A literal value that looks like a credential draws a warning. It is a string of 24 or more letters and digits (with a few symbols) and no spaces. Move it into an environment variable.
- Names that are not secret, such as `Notion-Version`, can take a literal value.
- For the `Authorization` header: if the value has no auth scheme, FullDots puts `Bearer ` in front of it. So `GITHUB_TOKEN` can hold the bare token. If the value already starts with a scheme such as `Bearer `, it is sent unchanged.
- Known secret values of 8 characters or more are removed from tool results and error messages before the Dot sees them.

## Local programs (stdio) and host trust

> **Warning.** A stdio connector runs a program on the machine that runs FullDots. FullDots does not sandbox that program. It runs with the same user rights as the server and can read and write anything that user can reach. Turn on `CONNECTORS_ALLOW_STDIO` only for programs you trust, on a machine you control.

- `CONNECTORS_ALLOW_STDIO` is `false` by default. While it is off, no stdio program starts, and a stdio connector shows an error.
- The program gets a minimal environment. It gets the connector's own environment values, plus `PATH`, `HOME`, `USERPROFILE`, `SYSTEMROOT`, `TEMP` and `TMP`. Other server variables are not passed, including the model key and the other connectors' tokens.
- The filesystem preset limits itself to the directory you name. Other programs have no such limit unless their own options set one.

## Grants for each Dot

A connector does nothing for a Dot until you grant it. Grants are set per Dot in the Dot form, under the model field. Each enabled connector lists its tools, with one checkbox for each.

- **Read-only tools are ticked by default.** A tool counts as read-only only when the connector marks it that way (the MCP `readOnlyHint` annotation). A tool with no mark counts as one that can change data.
- **Tools that can change data are not ticked.** Each one shows the warning "this can change things outside FullDots". Ticking one stores an explicit list of tools in place of "all read-only tools". After that, newly added read-only tools are not granted automatically.
- **Overrides** store one setting per tool: `allow`, `ask` or `deny`. `allow` skips the approval prompt for that tool, including destructive tools. `ask` always asks, in every approval mode except `off`. `deny` blocks the tool for that Dot in every mode. See [Approval modes](APPROVALS.md#approval-modes). The Dot form does not edit overrides in this version. They are set through the grants API, `PUT /api/dots/:id/connectors`.

## Revoking access

- Removing a tool from a Dot's grants, disabling a connector and deleting a connector all take effect at once.
- Each connector call checks the grant again just before it runs. A revoked tool returns "This connector tool was revoked by the owner." to the Dot, and nothing runs.
- A turn that is already running ends when its grant or its connector changes.

## Results and limits

- Text parts of a result are joined with line breaks. Images, audio and embedded resources are replaced with a short placeholder, such as `[image omitted]`.
- A result longer than `CONNECTOR_RESULT_MAX_CHARS` (default 20000) is cut. The end of the text says how many characters were removed.
- Results are marked untrusted (`untrusted: true`). The tool description tells the Dot that results are data. A page, issue or message can still contain text that tries to give instructions. The Dot is told to treat that text as data, but a model can still be misled. Grant only the tools a Dot needs.
- A failed call returns an error result to the Dot. It does not fail the whole turn.

## Audit log

Each connector call adds one row to the action audit log (the `action_audit` table in the SQLite database). The row records the Dot, the conversation, the tool name, the actor and the outcome. It does not record the arguments or the results.

## Connected apps (Composio)

Connected apps let a Dot use accounts you have already signed into, such as Gmail, Google Calendar or GitHub, through [Composio](https://composio.dev). This is separate from the connectors above. A connector is an MCP server you add yourself. A connected app is a toolkit in a Composio project.

Composio is a hosted service. When a Dot uses one of these tools, the arguments and the results pass through Composio. FullDots does not keep a copy of the provider token. The session id stays on the server.

### Turn it on

1. Create a Composio project and copy its API key.
2. Set `COMPOSIO_API_KEY` in `.env` and restart FullDots. Until that key is set, the switches below stay hidden and no Composio client is created.
3. In **Settings → General**, turn on **Connected apps**. This is off until you turn it on.
4. Open the Dot and turn on **Connected apps** there too. Both switches have to be on.
5. Optionally fill **Toolkit allow-list** with comma-separated slugs, for example `gmail, google_calendar`. A blank list allows every toolkit in the Composio project.

`OWNER_ID` is the id Composio uses for your accounts. Leave it as it is after you connect an app. Changing it makes those connections look like a different person.

The first time a tool needs a sign-in, the chat shows a **Connect this app** card. If the app uses Composio's own consent screen, the card has a link: open it, sign in, then tell the Dot the app is connected. If the app asks for a key or token you already have, the card is a short form instead. The action does not run until you finish that step.

When Connected apps is on, **Settings → General** lists the apps connected for you and can disconnect one. Disconnecting removes it from Composio. A key you typed still works at the app until you rotate it there.

### Approvals

Every connected-app call goes through the same approval gate as other tools. A tool whose name contains a read word (`GET`, `LIST`, `SEARCH`, `FETCH`, `READ` or `FIND`) is treated as a read and follows the Dot's approval mode the way a built-in read does: it is not held. Anything else, including a name FullDots does not recognise, is sensitive. In `sensitive` and `writes` the Dot stops and the card shows the app, the action and the arguments, with anything that looks like a secret masked. In `off` it is not asked. See [Approvals](APPROVALS.md).

Pausing the workspace or the Dot, stopping the turn, or changing either switch or the allow-list cancels a call that is already running.

### A key you already have

Most apps in Composio's catalogue do not use the consent screen. They ask for a secret you already hold: an API key, a token, or a short set of fields such as a subdomain plus a key. The card shows the fields Composio lists for that app, with each field's label, a short explanation, and whether it is a secret. A secret is a password box.

The browser sends those values to the FullDots server, which sends them straight to Composio to create the connected account. FullDots does not store them, does not write them into the chat, and does not give them to the model. The card then says the app is connected, or it says Composio refused and names only the error type and the HTTP status. Tell the Dot the app is connected and it can retry, the same way it does after a Connect link.

Composio keeps the key. FullDots keeps the toolkit name and whether the connection succeeded.

Composio accepts a key without asking the app whether the key works. A key the app would reject can still show as connected. A follow-up check that tries one read-only action and removes the connection if the app refuses is not done yet.

### What passes through Composio

The values you type, the tool arguments, and the tool results are sent to Composio. FullDots does not keep a copy of the key or of the provider token. The session id stays on the server.

### What is not supported yet

Apps that need an OAuth application registered by the operator, about 56 of the 1,540 apps this catalogue was checked against, are not offered. FullDots does not show a form or a Connect link for those.
