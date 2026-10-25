/** Toolkit slugs the owner types, such as `gmail` or `google_calendar`. */
const TOOLKIT_SLUG = /^[a-z0-9_]{1,64}$/;
const FIELD_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** One box on a key form. Names and labels only; never a value. */
export interface ComposioConnectField {
  name: string;
  label: string;
  help: string;
  secret: boolean;
  required: boolean;
}

export function isToolkitSlug(value: unknown): value is string {
  return typeof value === 'string' && TOOLKIT_SLUG.test(value);
}

/** The fields a handoff may draw. Anything else, including a pasted value, is dropped. */
export function parseConnectFields(
  value: unknown,
): ComposioConnectField[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8)
    return undefined;
  const fields: ComposioConnectField[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      return undefined;
    const record = item as Record<string, unknown>;
    if (typeof record.name !== 'string' || !FIELD_NAME.test(record.name))
      return undefined;
    if (record.name === 'status') return undefined;
    fields.push({
      name: record.name,
      label:
        typeof record.label === 'string' && record.label.trim()
          ? record.label.slice(0, 120)
          : record.name,
      help: typeof record.help === 'string' ? record.help.slice(0, 400) : '',
      secret: record.secret === true,
      required: record.required === true,
    });
  }
  return fields;
}
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
