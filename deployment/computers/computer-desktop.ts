export const DEFAULT_DESKTOP_IMAGE = 'opendots-computer-desktop:b6932d3-desk1';
export type ComputerKind = 'browser' | 'desktop';

export function memoryForKind(
  kind: ComputerKind,
  raw: string | undefined,
  resolved: number | undefined,
) {
  return raw?.trim()
    ? resolved
    : kind === 'desktop'
      ? 4_294_967_296
      : 2_147_483_648;
}

export async function requestedComputerKind(
  request: Request,
): Promise<ComputerKind | undefined> {
  const reader = request.body?.getReader();
  let text = '';
  if (reader) {
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        if (bytes > 1024) {
          await reader.cancel();
          return undefined;
        }
        text += decoder.decode(next.value, { stream: true });
      }
      text += decoder.decode();
    } catch {
      return undefined;
    } finally {
      reader.releaseLock();
    }
  }
  try {
    const value: unknown = text.trim() ? JSON.parse(text) : {};
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => key !== 'kind')
    )
      return undefined;
    const kind = (value as { kind?: unknown }).kind ?? 'browser';
    return kind === 'browser' || kind === 'desktop' ? kind : undefined;
  } catch {
    return undefined;
  }
}
