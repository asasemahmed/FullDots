// Pure checks for the moments a person has to take over the computer: a field that needs a secret and
// a page that shows a verification challenge. The agent never types a secret or solves a challenge.
import type { HandoffKind } from '../shared/types.js';
import type { ElementIdentity } from './computer-agent.js';

/** Field names that ask for a secret: passwords, codes and card details. */
export const HANDOFF_FIELD =
  /pass(word|code)|verification|authenticat|\b2fa\b|\bmfa\b|\botp\b|one[- ]time|security code|digit code|\bpin\b|\bcvv\b|card number/i;
/** A button that submits a login form, once its name is normalized. */
export const SIGN_IN_BUTTON = /^(sign|log)[ -]?in$/i;
const CODE_FIELD =
  /verification|authenticat|2fa|mfa|otp|one[- ]time|security code|digit code/i;
const SEARCH_FIELD = /\bsearch\b/i;
/** A field that plausibly holds a login identifier. */
const LOGIN_FIELD = /e-?mail|user(name)?|login|account|phone|identifier/i;

export interface HandoffDetection {
  kind: HandoffKind;
  reason: string;
}

const normalize = (text: string) =>
  text.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Whether typing into this field needs the owner: a field that is named like a secret, or a login
 * identifier field (email, username, phone) on a page that offers a sign-in button. A sign-in link
 * alone does not count: it sits in the header of every logged-out page.
 */
export function detectTypeHandoff(
  target: ElementIdentity | undefined,
  latestElements: ElementIdentity[],
): HandoffDetection | undefined {
  if (!target) return undefined;
  if (HANDOFF_FIELD.test(target.name))
    return {
      kind: CODE_FIELD.test(target.name) ? 'two_factor' : 'credential',
      reason: `the "${target.name.replace(/\s+/g, ' ').trim().slice(0, 80)}" field needs a secret`,
    };
  if (
    target.role === 'textbox' &&
    !SEARCH_FIELD.test(target.name) &&
    LOGIN_FIELD.test(target.name) &&
    latestElements.some(
      (element) =>
        element.role === 'button' &&
        SIGN_IN_BUTTON.test(normalize(element.name)),
    )
  )
    return { kind: 'credential', reason: 'a sign-in form' };
  return undefined;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const challengeReason = (value: unknown): string | undefined => {
  const reason = asRecord(asRecord(value)?.challenge)?.reason;
  return typeof reason === 'string' && reason.trim() ? reason : undefined;
};

/** A verification challenge the page is showing, in a tool result or the page inside it. */
export function detectChallenge(result: unknown): HandoffDetection | undefined {
  const reason =
    challengeReason(result) ?? challengeReason(asRecord(result)?.page);
  return reason ? { kind: 'captcha', reason } : undefined;
}
