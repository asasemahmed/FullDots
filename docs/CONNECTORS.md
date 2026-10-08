# Connectors

A connector gives a Dot tools that live outside FullDots, such as issues in GitHub or pages in Notion. FullDots loads each connector's tool list and offers those tools only to the Dots you grant them to. Approvals for connector actions are described in [Approvals](APPROVALS.md).

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

| State         | Meaning                                                                     |
| ------------- | --------------------------------------------------------------------------- |
| `connecting`  | FullDots is connecting. Its tools are not offered to Dots yet.              |
| `connected`   | Its tools are loaded and can be granted.                                    |
| `missing_env` | An environment variable it needs is not set. The missing names are listed.  |
| `error`       | Connecting or validation failed. The message is shown with secrets removed. |
| `disabled`    | The connector is turned off. Its tools are not offered.                     |

Use **Test** to check a connector and **Reload** to reconnect and reload its tool list.

Connectors start in the background when the server starts. If a connector is still connecting when a turn starts, that turn gets no tools from it. A dropped connection is retried after 1, 2, 5, 15 and then 60 seconds. Each tool call times out after 30 seconds by default (`callTimeoutMs`, between 1 second and 10 minutes).

## Presets

Presets fill in the URL or command, the headers and the environment variables. Vendor URLs and package names can change, so check the docs link before you rely on a preset.

| ID             | Transport | Environment variables                                                                                                        | Docs                                                                                                     |
| -------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `github`       | `http`    | `GITHUB_TOKEN` is sent as the `Authorization` header.                                                                        | [github/github-mcp-server](https://github.com/github/github-mcp-server)                                  |
| `notion`       | `http`    | `NOTION_TOKEN` is sent as the `Authorization` header. `Notion-Version` is fixed to `2022-06-28`.                             | [Notion MCP](https://developers.notion.com/docs/mcp)                                                     |
| `filesystem`   | `stdio`   | None. Add the directory to expose as the last argument. Access is limited to that directory.                                 | [servers/filesystem](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem)           |
| `fetch`        | `stdio`   | None. Runs `uvx mcp-server-fetch`.                                                                                           | [servers/fetch](https://github.com/modelcontextprotocol/servers/tree/main/src/fetch)                     |
| `google-drive` | `stdio`   | `GDRIVE_CREDENTIALS_PATH` is set to `~/.gdrive-server-credentials.json`. Run the server once to finish Google sign-in.       | [servers-archived/gdrive](https://github.com/modelcontextprotocol/servers-archived/tree/main/src/gdrive) |
| `gmail`        | `stdio`   | `GMAIL_CREDENTIALS_PATH` is set to `~/.gmail-mcp/credentials.json`. Run `npx @gongrzhe/server-gmail-autoauth-mcp auth` once. | [GongRzhe/Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server)                                |

The stdio presets need `CONNECTORS_ALLOW_STDIO=true`. Without it, saving a stdio connector is refused.

## Environment references and secrets

- FullDots does not store secret values. They are not kept in the database, in saved settings, in API responses or in the UI.
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
