let token = '';
let loaded = false;

/** Read once, on the first call. Importing this module must not need a browser. */
function currentToken(): string {
  if (!loaded) {
    loaded = true;
    try {
      token = sessionStorage.getItem('opendots-token') ?? '';
    } catch {
      token = '';
    }
  }
  return token;
}

export function setToken(value: string) {
  loaded = true;
  token = value;
  if (value) sessionStorage.setItem('opendots-token', value);
  else sessionStorage.removeItem('opendots-token');
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    signal,
    headers: {
      ...(currentToken() ? { Authorization: `Bearer ${currentToken()}` } : {}),
      ...(['GET', 'HEAD'].includes(method)
        ? {}
        : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response
    .json()
    .catch(() => ({ error: 'Server returned an unreadable response.' }))) as {
    error?: string;
  };
  if (!response.ok)
    throw new ApiError(
      data.error ?? `Request failed (${response.status}).`,
      response.status,
    );
  return data as T;
}
export function authHeaders(): Record<string, string> {
  return currentToken() ? { Authorization: `Bearer ${currentToken()}` } : {};
}
