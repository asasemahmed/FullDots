// Notification-only webhook for approvals and handoffs; it carries no secrets.
export type Notify = (event: {
  title: string;
  text: string;
  url: string;
}) => Promise<void>;

export function createNotify(
  url: string | undefined,
  transport: typeof fetch = fetch,
  log: (line: string) => void = console.error,
  /** The app's public origin: links in notifications are made absolute so a phone can open them. */
  origin?: string,
): Notify {
  if (!url) return async () => {};
  const link = (path: string) => {
    if (!origin) return path;
    try {
      return new URL(path, origin).toString();
    } catch {
      return path;
    }
  };
  return async (event) => {
    try {
      const response = await transport(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: event.title,
          text: event.text.slice(0, 500),
          url: link(event.url),
        }),
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      if (!response.ok) log(`Notification failed: ${response.status}`);
    } catch (error) {
      log(
        `Notification failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  };
}
