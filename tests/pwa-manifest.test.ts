import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const manifestPath = join(root, 'public', 'manifest.webmanifest');
const htmlPath = join(root, 'index.html');

function readPngDimensions(buffer: Buffer): { width: number; height: number } {
  // PNG signature: 8 bytes. IHDR chunk starts at byte 8 (length: 4 bytes, chunk type: 4 bytes "IHDR").
  // Width is 4 bytes at offset 16, height is 4 bytes at offset 20, big-endian.
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height };
}

describe('PWA web app manifest and icons', () => {
  it('defines the required manifest fields and icons', () => {
    expect(existsSync(manifestPath)).toBe(true);
    const content = readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(content);

    expect(manifest.name).toBe('FullDots');
    expect(manifest.short_name).toBe('FullDots');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.background_color).toBe('#f8f7f4');
    expect(manifest.theme_color).toBe('#f8f7f4');

    expect(manifest.icons).toEqual([
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512-maskable.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ]);
  });

  it('provides existing PNG icon files with header dimensions matching manifest sizes', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

    for (const icon of manifest.icons) {
      const relativePath = icon.src.replace(/^\//, '');
      const filePath = join(root, 'public', relativePath);
      expect(existsSync(filePath), `Icon file exists: ${icon.src}`).toBe(true);

      const buf = readFileSync(filePath);
      const { width, height } = readPngDimensions(buf);
      expect(`${width}x${height}`).toBe(icon.sizes);
      expect(icon.type).toBe('image/png');
    }
  });

  it('provides apple-touch-icon.png with dimensions 180x180', () => {
    const iconPath = join(root, 'public', 'icons', 'apple-touch-icon.png');
    expect(existsSync(iconPath)).toBe(true);

    const buf = readFileSync(iconPath);
    const { width, height } = readPngDimensions(buf);
    expect(width).toBe(180);
    expect(height).toBe(180);
  });

  it('links the manifest and apple-touch-icon in index.html', () => {
    const html = readFileSync(htmlPath, 'utf8');
    expect(html).toMatch(
      /<link\s+[^>]*rel=["']manifest["'][^>]*href=["']\/manifest\.webmanifest["']/,
    );
    expect(html).toMatch(
      /<link\s+[^>]*rel=["']apple-touch-icon["'][^>]*href=["']\/icons\/apple-touch-icon\.png["']/,
    );
  });
});
