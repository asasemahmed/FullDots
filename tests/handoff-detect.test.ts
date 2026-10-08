import { expect, it } from 'vitest';
import {
  detectChallenge,
  detectTypeHandoff,
} from '../src/server/handoff-detect.js';

const textbox = (name: string) => ({ role: 'textbox', name });
const button = (name: string) => ({ role: 'button', name });

it('a password field needs a credential', () => {
  expect(detectTypeHandoff(textbox('Password'), [])).toMatchObject({
    kind: 'credential',
    reason: 'the "Password" field needs a secret',
  });
});

it('verification and one-time codes are two-factor steps', () => {
  expect(detectTypeHandoff(textbox('Verification code'), [])?.kind).toBe(
    'two_factor',
  );
  expect(detectTypeHandoff(textbox('One-time passcode'), [])?.kind).toBe(
    'two_factor',
  );
});

it('a PIN or card number is a credential, not a code', () => {
  expect(detectTypeHandoff(textbox('PIN'), [])?.kind).toBe('credential');
  expect(detectTypeHandoff(textbox('Card number'), [])?.kind).toBe(
    'credential',
  );
  expect(detectTypeHandoff(textbox('CVV'), [])?.kind).toBe('credential');
});

it('an identifier field next to a sign-in button is a sign-in form', () => {
  expect(
    detectTypeHandoff(textbox('Email'), [textbox('Email'), button('Log in')]),
  ).toEqual({ kind: 'credential', reason: 'a sign-in form' });
  expect(
    detectTypeHandoff(textbox('Username or phone'), [button(' Sign  In ')])
      ?.kind,
  ).toBe('credential');
});

it('a sign-in link alone does not make a field a sign-in form', () => {
  expect(
    detectTypeHandoff(textbox('Email'), [{ role: 'link', name: ' Sign  In ' }]),
  ).toBeUndefined();
});

it('other fields on a page with a sign-in button are left to the Dot', () => {
  expect(
    detectTypeHandoff(textbox('Comment'), [button('Log in')]),
  ).toBeUndefined();
  expect(
    detectTypeHandoff(textbox('Street address'), [button('Sign in')]),
  ).toBeUndefined();
});

it('never triggers for a search box or a page without a sign-in button', () => {
  expect(
    detectTypeHandoff(textbox('Search'), [button('Search')]),
  ).toBeUndefined();
  expect(
    detectTypeHandoff(textbox('Search'), [button('Sign in')]),
  ).toBeUndefined();
  expect(
    detectTypeHandoff(textbox('Email'), [button('Subscribe')]),
  ).toBeUndefined();
  expect(
    detectTypeHandoff({ role: 'combobox', name: 'Country' }, [
      button('Sign in'),
    ]),
  ).toBeUndefined();
  expect(detectTypeHandoff(undefined, [button('Sign in')])).toBeUndefined();
});

it('reads a challenge from the result or from the page inside it', () => {
  const expected = { kind: 'captcha', reason: 'A CAPTCHA is showing' };
  expect(
    detectChallenge({ challenge: { reason: 'A CAPTCHA is showing' } }),
  ).toEqual(expected);
  expect(
    detectChallenge({
      page: { challenge: { reason: 'A CAPTCHA is showing' } },
    }),
  ).toEqual(expected);
});

it('finds no challenge in anything else', () => {
  expect(detectChallenge({ page: { elements: [] } })).toBeUndefined();
  expect(detectChallenge({ challenge: { kind: 'x' } })).toBeUndefined();
  expect(detectChallenge({ challenge: { reason: 5 } })).toBeUndefined();
  expect(detectChallenge('captcha')).toBeUndefined();
  expect(detectChallenge(null)).toBeUndefined();
  expect(detectChallenge(undefined)).toBeUndefined();
  expect(detectChallenge([{ challenge: { reason: 'x' } }])).toBeUndefined();
});
