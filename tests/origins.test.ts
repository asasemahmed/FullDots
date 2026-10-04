import { expect, it } from 'vitest';
import { originAllowed } from '../src/server/origins.js';

const app = 'http://127.0.0.1:5173';

it('accepts the app origin under any loopback name on the same port', () => {
  expect(originAllowed(app, app)).toBe(true);
  expect(originAllowed('http://localhost:5173', app)).toBe(true);
  expect(originAllowed('http://[::1]:5173', app)).toBe(true);
});

it('rejects other sites, ports, and schemes', () => {
  expect(originAllowed('https://evil.example', app)).toBe(false);
  expect(originAllowed('http://localhost:3000', app)).toBe(false);
  expect(originAllowed('https://localhost:5173', app)).toBe(false);
  expect(originAllowed('http://127.0.0.1.evil.example:5173', app)).toBe(false);
  expect(originAllowed('null', app)).toBe(false);
});

it('keeps a non-loopback app origin exact', () => {
  const site = 'https://dots.example.com';
  expect(originAllowed(site, site)).toBe(true);
  expect(originAllowed('http://localhost', site)).toBe(false);
});
