// Removes secrets from text before it is stored as a Dot note or a saved memory. The chat
// transcript is not passed through here: it shows what was actually said.
//
// Most Dot code masks one known value (a model key or connector token it holds); this one has to
// recognise secrets it has never seen, so it works on shapes: provider prefixes, credentials in
// headers and URLs, PEM and JWT blocks, and finally long random-looking strings. It is built to
// miss a secret before it mangles ordinary text, so URLs, file paths, git hashes, UUIDs and code
// identifiers are left alone. Every pattern is bounded and has no nested quantifiers.

export const REDACTED = '[redacted]';

// Keeps a prefixed pattern from matching inside a longer word, such as "task-" or "risk-".
const START = String.raw`(?<![A-Za-z0-9_-])`;

/** Whole matches replaced outright: keys and tokens whose prefix says what they are. */
const SHAPES: RegExp[] = [
  // PEM private key blocks, including a truncated one that has no END line.
  /-----BEGIN [A-Z0-9 ]{0,30}PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,16384}?(?:-----END [A-Z0-9 ]{0,30}PRIVATE KEY(?: BLOCK)?-----|$)/g,
  // JWTs: a header and a payload that both start with base64url for `{"`.
  new RegExp(
    String.raw`${START}eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*`,
    'g',
  ),
  // OpenAI, Anthropic, OpenRouter and other `sk-` keys.
  new RegExp(String.raw`${START}sk-[A-Za-z0-9_-]{20,}`, 'g'),
  // Stripe.
  new RegExp(String.raw`${START}(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}`, 'g'),
  new RegExp(String.raw`${START}whsec_[A-Za-z0-9]{16,}`, 'g'),
  // GitHub and GitLab.
  new RegExp(String.raw`${START}gh[pousr]_[A-Za-z0-9]{30,}`, 'g'),
  new RegExp(String.raw`${START}github_pat_[A-Za-z0-9_]{22,}`, 'g'),
  new RegExp(String.raw`${START}glpat-[A-Za-z0-9_-]{20,}`, 'g'),
  // Slack tokens and incoming webhooks.
  new RegExp(String.raw`${START}xox[abeoprs]-[A-Za-z0-9-]{10,}`, 'g'),
  new RegExp(String.raw`${START}xapp-\d-[A-Za-z0-9-]{10,}`, 'g'),
  /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{16,}/g,
  // Google.
  new RegExp(String.raw`${START}AIza[0-9A-Za-z_-]{35}`, 'g'),
  new RegExp(String.raw`${START}ya29\.[0-9A-Za-z_-]{20,}`, 'g'),
  new RegExp(String.raw`${START}GOCSPX-[0-9A-Za-z_-]{20,}`, 'g'),
  // AWS access key ids.
  new RegExp(
    String.raw`${START}(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}(?![A-Za-z0-9])`,
    'g',
  ),
  // Other common providers.
  new RegExp(
    String.raw`${START}SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}`,
    'g',
  ),
  new RegExp(String.raw`${START}npm_[A-Za-z0-9]{30,}`, 'g'),
  new RegExp(String.raw`${START}hf_[A-Za-z0-9]{30,}`, 'g'),
  new RegExp(String.raw`${START}gsk_[A-Za-z0-9]{40,}`, 'g'),
  new RegExp(String.raw`${START}pplx-[A-Za-z0-9]{30,}`, 'g'),
  new RegExp(String.raw`${START}r8_[A-Za-z0-9]{30,}`, 'g'),
  new RegExp(String.raw`${START}dop_v1_[a-f0-9]{40,}`, 'g'),
  new RegExp(String.raw`${START}shp(?:at|ca|pa|ss)_[a-f0-9]{32}`, 'g'),
  new RegExp(String.raw`${START}SK[0-9a-f]{32}(?![A-Za-z0-9])`, 'g'),
  new RegExp(
    String.raw`${START}\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])`,
    'g',
  ),
];

/** A value worth hiding after a label like "Bearer": not a plain word. */
const looksRandom = (value: string) => /\d|[a-z][A-Z]/.test(value);

/** Patterns whose first group is a label to keep; the value after it is replaced. */
const LABELLED: { pattern: RegExp; needsRandomValue: boolean }[] = [
  // The password inside scheme://user:password@host.
  {
    pattern:
      /(\b[A-Za-z][A-Za-z0-9+.-]{1,20}:\/\/[^\s/:@]{1,64}:)[^\s/@]{1,200}(?=@)/g,
    needsRandomValue: false,
  },
  // Secret-named query parameters in a URL.
  {
    pattern:
      /([?&](?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|client[_-]?secret|secret|signature|password|passwd|key)=)[A-Za-z0-9%._~+/-]{12,}/gi,
    needsRandomValue: false,
  },
  // "Bearer abc..." and "Basic abc...", anywhere.
  {
    pattern: /(\b(?:bearer|basic)\s+)([A-Za-z0-9._~+/-]{16,}={0,2})/gi,
    needsRandomValue: true,
  },
  // "Authorization: abc..." and "x-api-key: abc..." headers with any scheme or none.
  {
    pattern:
      /(\b(?:authorization|x-api-key|api-key|x-auth-token)["']?\s*[:=]\s*["']?)([A-Za-z0-9._~+/-]{20,}={0,2})/gi,
    needsRandomValue: true,
  },
];

// Long runs of base64 or base64url characters. A run only counts when it starts after something
// that is not part of a URL, path or word, so a long segment of a link or file path is never a
// candidate.
const LONG_RUN = /(?<![A-Za-z0-9+/_.:-])[A-Za-z0-9+/_-]{32,}={0,2}/g;
const MIN_RUN_ENTROPY = 4.3;

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * True for a long string that reads as random: a digit and a letter, no hex-only hash (git and
 * checksum values, UUIDs), no subresource-integrity hash, and the spread of characters of a key
 * rather than of words, paths or identifiers.
 */
function looksLikeKey(run: string): boolean {
  if (!/\d/.test(run) || !/[A-Za-z]/.test(run)) return false;
  if (/^[0-9a-f]+$/i.test(run.replace(/[-_]/g, ''))) return false;
  if (/^sha(?:256|384|512)-/.test(run)) return false;
  return entropy(run) >= MIN_RUN_ENTROPY;
}

/**
 * The text with secrets replaced by `[redacted]`. `onRedacted` is told how many were replaced
 * (only when at least one was), never what they were.
 */
export function redactForStorage(
  text: string,
  onRedacted?: (count: number) => void,
): string {
  let count = 0;
  let out = text;
  const hide = () => {
    count += 1;
    return REDACTED;
  };
  for (const shape of SHAPES) out = out.replace(shape, hide);
  for (const { pattern, needsRandomValue } of LABELLED)
    out = out.replace(pattern, (...args: unknown[]) => {
      const label = args[1] as string;
      // With a second group the value is it; without one the value is the rest of the match.
      const value =
        typeof args[2] === 'string'
          ? args[2]
          : (args[0] as string).slice(label.length);
      if (needsRandomValue && !looksRandom(value)) return args[0] as string;
      count += 1;
      return `${label}${REDACTED}`;
    });
  out = out.replace(LONG_RUN, (run) => (looksLikeKey(run) ? hide() : run));
  if (count > 0) onRedacted?.(count);
  return out;
}
