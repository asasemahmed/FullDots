import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function addCodingBridge(source) {
  const start = 'serve<StreamData>({';
  const end = '  },\n});\n\ntype ActionBody = {';
  for (const marker of [start, end])
    if (source.split(marker).length !== 2)
      throw new Error(
        'Pinned computer server changed; review the coding bridge patch.',
      );
  return `import { withAcpBridge } from "../acp-bridge/bridge.mjs";\nimport { prepareCodingStorage } from "../acp-bridge/storage.mjs";\nawait prepareCodingStorage();\n${source.replace(start, 'serve<StreamData>(withAcpBridge({').replace(end, '  },\n}));\n\ntype ActionBody = {')}`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const path = process.argv[2];
  if (!path) throw new Error('Pass the pinned computer index.ts path.');
  await writeFile(path, addCodingBridge(await readFile(path, 'utf8')));
}
