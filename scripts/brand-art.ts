// Draws the brand files from the same penguin the app uses: the mark and favicon in public/, and
// the logos, characters and their PNG copies in docs/brand/. Run `npm run brand` after changing
// src/client/penguin/engine.ts or the palettes, and commit what it writes.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { DOT_PALETTES } from '../src/client/dot-palettes';
import {
  penguinMarkup,
  penguinSvg,
  restPose,
  viewBox,
  type PenguinLook,
} from '../src/client/penguin/engine';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const brand = join(root, 'docs', 'brand');
const mark: PenguinLook = {
  palette: DOT_PALETTES.indigo,
  species: 'emperor',
  gear: 'none',
};
const characters: { file: string; title: string; look: PenguinLook }[] = [
  { file: 'dot-indigo', title: 'Dot (indigo emperor)', look: mark },
  {
    file: 'dot-mint',
    title: 'Dot (mint Adélie with headphones)',
    look: { palette: DOT_PALETTES.mint, species: 'adelie', gear: 'headphones' },
  },
  {
    file: 'dot-coral',
    title: 'Dot (coral rockhopper with glasses)',
    look: {
      palette: DOT_PALETTES.coral,
      species: 'rockhopper',
      gear: 'glasses',
    },
  },
  {
    file: 'dot-amber',
    title: 'Dot (amber chick in a scarf)',
    look: { palette: DOT_PALETTES.amber, species: 'chick', gear: 'scarf' },
  },
  {
    file: 'dot-lilac',
    title: 'Dot (lilac macaroni in a beanie)',
    look: { palette: DOT_PALETTES.lilac, species: 'macaroni', gear: 'beanie' },
  },
];

/** The wordmark from the current logo, so its type stays exactly as designed. */
function wordmark(file: string) {
  const svg = readFileSync(join(brand, file), 'utf8');
  const text = /<text[\s\S]*?<\/text>/.exec(svg)?.[0];
  if (!text) throw new Error(`No wordmark text in ${file}.`);
  return text;
}
const logo = (file: string, title: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 72" width="600" height="144"><title>${title}</title><svg x="0" y="4" width="64" height="64" viewBox="${viewBox('icon')}">${penguinMarkup(mark, restPose('idle'), 'icon', { id: 'm' })}</svg>${wordmark(file)}</svg>\n`;

const files: { path: string; svg: string; png?: [number, number] }[] = [
  {
    path: join(root, 'public', 'logo.svg'),
    svg: penguinSvg(mark, 'idle', 'icon', { size: 64, title: 'FullDots' }),
  },
  {
    path: join(root, 'public', 'favicon.svg'),
    svg: penguinSvg(mark, 'idle', 'icon', { size: 64, title: 'FullDots' }),
  },
  {
    path: join(brand, 'fulldots-mark.svg'),
    svg: penguinSvg(mark, 'idle', 'icon', { size: 256, title: 'FullDots' }),
    png: [512, 512],
  },
  {
    path: join(brand, 'fulldots-logo.svg'),
    svg: logo('fulldots-logo.svg', 'FullDots'),
    png: [1200, 288],
  },
  {
    path: join(brand, 'fulldots-logo-light.svg'),
    svg: logo('fulldots-logo-light.svg', 'FullDots'),
    png: [1200, 288],
  },
  ...characters.map(({ file, title, look }) => ({
    path: join(brand, `${file}.svg`),
    svg: penguinSvg(look, 'idle', 'mascot', { size: 512, title }),
    png: [512, 512] as [number, number],
  })),
];

for (const file of files) {
  mkdirSync(dirname(file.path), { recursive: true });
  writeFileSync(
    file.path,
    file.svg.endsWith('\n') ? file.svg : file.svg + '\n',
  );
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const file of files) {
    if (!file.png) continue;
    const [width, height] = file.png;
    await page.setViewportSize({ width, height });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${width}px;height:${height}px}</style>${file.svg}`,
    );
    const name = file.path
      .split(/[\\/]/)
      .pop()!
      .replace(/\.svg$/, '.png');
    await page.screenshot({
      path: join(brand, 'png', name),
      omitBackground: true,
      clip: { x: 0, y: 0, width, height },
    });
  }
} finally {
  await browser.close();
}
console.log(`Wrote ${files.length} SVG files and their PNG copies.`);
