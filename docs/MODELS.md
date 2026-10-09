# Model providers

A model provider is a service that runs the language models your Dots use. FullDots talks to every provider through the same OpenAI-compatible chat API. You can add several providers, and each Dot can use a different one.

Providers are managed in **Settings → Models**. You can also keep using the variables in `.env`; see [Default (from .env)](#the-built-in-provider-default-from-env).

## Add a provider

1. Open **Settings** and choose **Models**.
2. Choose **Add provider**, then pick a preset. Choose **Custom (OpenAI-compatible)** for any other server that speaks the OpenAI chat API.
3. Choose how the key is supplied:
   - **Paste a key.** The key is encrypted on this computer and never shown again.
   - **Use a variable from .env.** Type the variable name, for example `GROQ_API_KEY`. Only the name is saved. Set the variable in `.env` and restart the server.
   - **No key.** Only for local providers and custom servers that need no key.
4. Save. FullDots tests the connection at once and lists the provider's models.
5. Choose **Set as default** on a model if you want it used by default, or leave the default as it is.

The test is a model-list request. It shows a result such as `Connected · 42 models · 310 ms`, or the reason it failed.

## Manage providers

- **Test connection** runs the test again.
- **Refresh** reloads the model list. Lists are cached for 10 minutes.
- **Enabled** turns a provider off without deleting it. A disabled provider serves no Dot and no default. A Dot that uses it shows the disabled message in its conversation.
- **New API key** replaces a stored key. After saving, the key field shows only the last four characters.
- **Delete provider** erases the saved key from this computer. It is refused while a Dot or the default model uses the provider. The message names the Dots. Switch those Dots to another provider, or set another default, and then delete.

The built-in provider from `.env` is read-only in the UI. Edit `.env` and restart the server to change it.

## Default model

The default model is used by any Dot that has no provider and model of its own. Research briefs also use it.

FullDots picks the default in this order:

1. The model set as default in **Settings → Models**, when its provider exists.
2. Otherwise, `OPENAI_MODEL` from `.env`, on the built-in provider.

## Choose a model for a Dot

Open a Dot's settings and use the model field. It offers these choices:

- **Default**, which uses the default provider and model. The field shows the current default.
- **A model from a provider.** Models are grouped by provider. Only enabled providers appear.
- **Use a custom model id**, for a model that is not in the list. Type the exact id the provider expects. Use letters, digits, and `. : / @ + - _` only. Spaces are not allowed.

A Dot that names a provider must also have a model. If the Dot names a provider that no longer exists, the Dot uses the default provider and model instead, and the server log records a warning.

## The built-in provider: Default (from .env)

If `OPENAI_API_KEY` is set, FullDots shows a built-in provider named **Default (from .env)**. It works like this:

- `OPENAI_API_KEY` is its key.
- `OPENAI_BASE_URL` is its base URL. It defaults to `https://api.openai.com/v1`.
- `OPENAI_MODEL` is its model when no default is set in **Settings → Models**.

These variables keep working unchanged. A Dot with no provider behaves as it did before. The provider is read-only in the UI, so change it in `.env` and restart.

## Providers

Presets list the base URL and the key for each provider. The base URL is the address FullDots calls, and the key is what you need to supply.

| Provider                   | Base URL                                                  | Key        | Notes                                                                                                                                                                                                       |
| -------------------------- | --------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI                     | `https://api.openai.com/v1`                               | Required   | Sends `max_completion_tokens`. Reasoning models reject `max_tokens`.                                                                                                                                        |
| Anthropic                  | `https://api.anthropic.com/v1`                            | Required   | Claude through Anthropic's OpenAI compatibility layer. Anthropic describes this layer as mainly for testing. Temperature is capped at 1. Add a workspace ID only if your key belongs to several workspaces. |
| Google Gemini              | `https://generativelanguage.googleapis.com/v1beta/openai` | Required   | Uses Google's OpenAI-compatible endpoint, which Google still marks as beta.                                                                                                                                 |
| OpenRouter                 | `https://openrouter.ai/api/v1`                            | Required   | Many models from many labs with one key. Model ids contain a slash, such as `vendor/model-name`. FullDots sends no attribution headers.                                                                     |
| Groq                       | `https://api.groq.com/openai/v1`                          | Required   | Fast hosted open-weight models, such as `llama-3.3-70b-versatile`. Sends `max_completion_tokens`.                                                                                                           |
| Mistral                    | `https://api.mistral.ai/v1`                               | Required   | Mistral and Codestral models.                                                                                                                                                                               |
| DeepSeek                   | `https://api.deepseek.com`                                | Required   | No `/v1` in the base URL. FullDots does not turn on DeepSeek's thinking mode, which needs extra handling with tool calls.                                                                                   |
| xAI                        | `https://api.x.ai/v1`                                     | Required   | Grok models.                                                                                                                                                                                                |
| Together AI                | `https://api.together.ai/v1`                              | Required   | Model ids contain a slash. The list shows chat models only, so image and embedding models are hidden.                                                                                                       |
| Fireworks AI               | `https://api.fireworks.ai/inference/v1`                   | Required   | Ids look like `accounts/fireworks/models/<name>`. The model list may be unavailable. If it is, type the id with **Use a custom model id**.                                                                  |
| Cerebras                   | `https://api.cerebras.ai/v1`                              | Required   | Sends `max_completion_tokens`.                                                                                                                                                                              |
| Ollama                     | `http://localhost:11434/v1`                               | Not needed | Runs on this computer. Lists the models you have pulled. FullDots removes `tool_choice`, which Ollama rejects.                                                                                              |
| LM Studio                  | `http://localhost:1234/v1`                                | Not needed | Runs on this computer. Model ids are the identifiers LM Studio shows.                                                                                                                                       |
| Custom (OpenAI-compatible) | You enter it                                              | Optional   | Any server with an OpenAI-compatible chat API. Sends `max_tokens`. Needs `https://` unless the address is localhost.                                                                                        |

Some details apply to all providers:

- **Output limit.** FullDots sends the output limit under the name each provider accepts. OpenAI, OpenRouter, Groq, and Cerebras get `max_completion_tokens`. The others get `max_tokens`. You do not set this.
- **Key prefixes.** Each preset shows the usual key prefix, such as `sk-` for OpenAI or `gsk_` for Groq. This is only a hint. A key that does not match still saves.
- **Perplexity** is not listed. Its Sonar chat completions API ended support on September 27, 2026. To use Perplexity models, add OpenRouter and pick a `perplexity/` model.

## Local providers

Ollama and LM Studio run on this computer. FullDots reaches them on `localhost` only, unless you allow your own network:

1. Add `MODEL_PROVIDERS_ALLOW_LAN=true` to `.env`, and restart the server.
2. Enter the other machine's address as the base URL, with `http://` and the port.
3. Make sure the program on that machine accepts connections from your network.

Only private addresses, such as `192.168.x.x`, and local host names, such as `ollama.local`, are accepted. Public IP addresses are refused.

Other providers must use `https://`. Private addresses are refused for them.

## Security

- **Encryption.** Stored keys are encrypted with AES-256-GCM before they go into the workspace database.
- **Encryption key.** The key comes from `CONNECTOR_SECRET_KEY` in `.env`. If that is not set, FullDots uses `data/connector.key`, which it creates beside the database on first start. A database backup holds only encrypted keys. To read them after a restore, you need the same encryption key, so keep it safe too.
- **Never sent to the browser.** The page shows only the last four characters of a stored key.
- **Never in logs or errors.** Known keys are removed from error text and from anything saved, such as a provider's last error.
- **Variables stay in .env.** With **Use a variable from .env**, the key stays in `.env`. FullDots reads it when it calls the provider.
- **No attribution headers.** FullDots sends no identifying headers, such as OpenRouter's `HTTP-Referer` or `X-Title`, to any provider.
- **Fixed destination.** Requests go only to the base URL you set. Redirects are not followed.

## Troubleshooting

These are the messages you may see in Settings or in a Dot's conversation, and what to do about each one.

| Message                                                                                                                   | What to do                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `No model is configured. Add a provider in Settings → Models or set OPENAI_API_KEY.`                                      | Add a provider in **Settings → Models**. Or set `OPENAI_API_KEY` and `OPENAI_MODEL` in `.env`, then restart.              |
| `No model is configured. Set OPENAI_MODEL or choose a default model in Settings → Models.`                                | Set `OPENAI_MODEL` in `.env`, or choose a default model in **Settings → Models**.                                         |
| `No model is selected for “NAME”. Pick a model for this Dot or set a default in Settings → Models.`                       | Open the Dot's settings and pick a model. Or set a default for that provider.                                             |
| `The provider “NAME” is disabled. Enable it in Settings → Models or pick another model for this Dot.`                     | Turn the provider on in **Settings → Models**, or pick a model from another provider for the Dot.                         |
| `The provider “NAME” has no API key.`                                                                                     | Paste a key, or set the `.env` variable the provider names and restart the server.                                        |
| `The stored API key could not be decrypted. Enter it again.`                                                              | The encryption key has changed or is missing, or the saved value is damaged. Enter the key again.                         |
| `Could not connect to HOST. Is NAME running?`                                                                             | Start the local program, such as Ollama or LM Studio. Check the port in the base URL.                                     |
| `The provider did not answer within 15 seconds.`                                                                          | The provider is slow or unreachable. Check your connection and test again.                                                |
| `HTTP 401` or `HTTP 403`                                                                                                  | The key was rejected. Check the key, or the workspace ID for Anthropic.                                                   |
| `HTTP 404`                                                                                                                | The base URL is probably wrong. Check the path, such as the `/v1` at the end.                                             |
| `HTTP 429`                                                                                                                | The provider is rate-limiting you or your quota is used up. Wait, or check the provider's usage page.                     |
| `The provider returned a model list in an unknown format.`                                                                | The list cannot be read. Type the model id with **Use a custom model id**. Chat may still work.                           |
| `The provider returned a response that is not JSON.`                                                                      | The base URL points to something other than an API, such as a web page. Check the address.                                |
| `Wait a moment before testing this provider again.`                                                                       | Tests are limited to one every two seconds for each provider.                                                             |
| `The base URL must start with https:// (or http:// for localhost).`                                                       | Use `https://`. Only localhost may use `http://`.                                                                         |
| `The base URL must not point to a private network address.`                                                               | Use a public host name. Private addresses are allowed only for local providers, with `MODEL_PROVIDERS_ALLOW_LAN=true`.    |
| `NAME runs on this computer; use localhost. Set MODEL_PROVIDERS_ALLOW_LAN=true to allow another machine on your network.` | Use `localhost`, or allow your network as described in [Local providers](#local-providers).                               |
| `Refused request to ORIGIN: NAME is limited to localhost (set MODEL_PROVIDERS_ALLOW_LAN=true to allow your network)`      | A local provider points at another machine while the setting is off. Use `localhost`, or turn the setting on and restart. |
| `A provider with that name already exists.`                                                                               | Give the provider a different name. Names are not case-sensitive.                                                         |
| `NAME is still in use by DOTS, default model. Switch them to another provider first.`                                     | Move those Dots, or the default model, to another provider. Then delete.                                                  |
| `The default provider comes from the server environment (.env). Edit it there.`                                           | Edit `OPENAI_*` in `.env` and restart the server.                                                                         |
| `The API key must be at least 8 characters.` or `The API key must not contain spaces.`                                    | Paste the whole key, without spaces.                                                                                      |
| `Use an environment variable name such as GROQ_API_KEY (capital letters, digits and underscores).`                        | Use capital letters, digits, and underscores only.                                                                        |
| `That model id has unsupported characters.`                                                                               | Use letters, digits, and `. : / @ + - _` only.                                                                            |
| `The model provider request failed. Check the server configuration and try again.`                                        | The server hit an unexpected error. Check the server output, then try again.                                              |

A Dot can also show a warning in the server log: `The provider this Dot names no longer exists; it falls back to the default.` The Dot uses the default provider until you pick a provider for it again.
