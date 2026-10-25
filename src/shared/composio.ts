/** Toolkit slugs the owner types, such as `gmail` or `google_calendar`. */
const TOOLKIT_SLUG = /^[a-z0-9_]{1,64}$/;
export const MAX_COMPOSIO_TOOLKITS = 40;

/**
 * Comma-separated toolkit slugs from the Dot form. A blank field is an empty
 * list, which means every toolkit in the Composio project.
 */
export function parseToolkitField(text: string): string[] {
  const slugs = text
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (slugs.some((slug) => !TOOLKIT_SLUG.test(slug)))
    throw new Error(
      'Toolkit slugs use lowercase letters, digits and underscores, separated by commas.',
    );
  if (slugs.length > MAX_COMPOSIO_TOOLKITS)
    throw new Error(`List at most ${MAX_COMPOSIO_TOOLKITS} toolkit slugs.`);
  return [...new Set(slugs)].sort();
}

/** Composio's own hosts. A Connect link anywhere else is ignored, so app data that happens to hold a URL cannot pose as one. */
const isComposioHost = (hostname: string) =>
  hostname === 'composio.dev' || hostname.endsWith('.composio.dev');

/** An https address on a Composio host, with no embedded username or password. */
export function httpsConnectUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2000)
    return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !isComposioHost(url.hostname)
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
