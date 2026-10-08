export interface CallbackPageInput {
  /** Per-response CSP nonce; the inline script, the style tag and the CSP header share it. */
  nonce: string;
  ok: boolean;
  connectorId: string;
  connectorName: string;
  /** Visible on failure and sent to the opener; never needs to be trusted (it is escaped twice). */
  message: string;
  /** The app's origin (a server value). The only postMessage target and the only link. */
  appOrigin: string;
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const STYLE = `
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 system-ui, sans-serif; background: Canvas; color: CanvasText; }
  main { max-width: 26rem; padding: 2rem 1.5rem; text-align: center; }
  h1 { font-size: 1.15rem; margin: 0 0 0.5rem; }
  p { margin: 0.5rem 0; overflow-wrap: anywhere; }
  .ok h1 { color: #15803d; }
  .fail h1 { color: #b91c1c; }
  a { color: LinkText; }
`;

// A constant: nothing from the request is interpolated into the script.
const SCRIPT = `
  const result = JSON.parse(document.getElementById('result').textContent);
  const target = document.documentElement.dataset.appOrigin;
  if (window.opener && !window.opener.closed) {
    try { window.opener.postMessage(result, target); } catch (error) {}
  }
  setTimeout(() => window.close(), 800);
`;

/** The page the OAuth provider's redirect lands on. Pure: same input, same output. */
export function renderCallbackPage(input: CallbackPageInput): string {
  const { nonce, ok, connectorId, connectorName, message, appOrigin } = input;
  // `<` becomes < so provider text can never close the script element.
  const json = JSON.stringify({
    type: 'fulldots:connector-auth',
    ok,
    connectorId,
    message: ok ? '' : message,
  }).replace(/</g, '\\u003c');
  const heading = ok
    ? connectorName
      ? `${escapeHtml(connectorName)} connected`
      : 'Connected'
    : 'Could not connect';
  const body = ok
    ? '<p>Connected. You can close this window.</p>'
    : `<p>${escapeHtml(message)}</p>
    <p><a href="${escapeHtml(appOrigin)}">Back to FullDots</a></p>`;
  return `<!doctype html>
<html lang="en" data-app-origin="${escapeHtml(appOrigin)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>FullDots connector</title>
<style nonce="${escapeHtml(nonce)}">${STYLE}</style>
</head>
<body>
<main class="${ok ? 'ok' : 'fail'}">
    <h1>${heading}</h1>
    ${body}
</main>
<script type="application/json" id="result">${json}</script>
<script nonce="${escapeHtml(nonce)}">${SCRIPT}</script>
</body>
</html>
`;
}
