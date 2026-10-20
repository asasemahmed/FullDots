// The Dot colour palettes, shared by the character, the design tokens and the brand art script.
import type { DotColor } from '../shared/types';

export const DOT_PALETTES = {
  indigo: {
    base: '#6e7ff3',
    light: '#b8c1ff',
    dark: '#4b58cf',
    cheek: '#ff7aa8',
    cheekOpacity: 0.38,
  },
  mint: {
    base: '#33c49f',
    light: '#a0f0da',
    dark: '#1b9374',
    cheek: '#ffa6bf',
    cheekOpacity: 0.78,
  },
  coral: {
    base: '#ff8a66',
    light: '#ffcab6',
    dark: '#de5f3c',
    cheek: '#ff4d73',
    cheekOpacity: 0.38,
  },
  lilac: {
    base: '#a98bf3',
    light: '#dccfff',
    dark: '#8063d4',
    cheek: '#ff7ab8',
    cheekOpacity: 0.38,
  },
  amber: {
    base: '#f2ab2e',
    light: '#ffe0a0',
    dark: '#c27d0a',
    cheek: '#ff7a5c',
    cheekOpacity: 0.5,
  },
  sky: {
    base: '#4aaee8',
    light: '#b4e2ff',
    dark: '#2380bd',
    cheek: '#ff8fb0',
    cheekOpacity: 0.55,
  },
  rose: {
    base: '#ee6a98',
    light: '#ffc4d9',
    dark: '#c93f72',
    cheek: '#ff5a82',
    cheekOpacity: 0.4,
  },
  moss: {
    base: '#7bab55',
    light: '#cfe9b6',
    dark: '#568736',
    cheek: '#ff9a8a',
    cheekOpacity: 0.5,
  },
  ink: {
    base: '#2b3040',
    light: '#c3c8d6',
    dark: '#1a1d28',
    cheek: '#ff86a8',
    cheekOpacity: 0.5,
  },
} as const;
export type DotPalette = keyof typeof DOT_PALETTES;
export const DOT_PALETTE_NAMES = Object.keys(DOT_PALETTES) as DotPalette[];
// Fails to compile if the shared colour list and the palettes drift apart.
const _palettesMatchColors: Record<DotColor, unknown> = DOT_PALETTES;
void _palettesMatchColors;
