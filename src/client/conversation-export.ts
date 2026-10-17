// Downloads one conversation as Markdown.
//
// The export route sits behind the owner check, so this cannot be a plain <a href>: the request
// needs the session token in an Authorization header. The response is therefore fetched and
// handed to the browser as a Blob, the same way the page editor downloads a page.
import { ApiError, authHeaders } from './api';

/**
 * The file name out of a Content-Disposition header. The UTF-8 form is preferred, because the
 * bare `filename` is an ASCII approximation of it.
 */
export function filenameFrom(header: string | null): string | undefined {
  if (!header) return undefined;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (encoded)
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      // A malformed escape: fall back to the ASCII form below.
    }
  return /filename="([^"]+)"/i.exec(header)?.[1];
}

/** Fetches the conversation's Markdown and starts the browser's download. */
export async function downloadConversationMarkdown(id: string): Promise<void> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(id)}/export.md`,
    { headers: authHeaders() },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new ApiError(
      body.error ?? `Export failed (${response.status}).`,
      response.status,
    );
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download =
    filenameFrom(response.headers.get('Content-Disposition')) ??
    'conversation.md';
  link.click();
  URL.revokeObjectURL(url);
}
