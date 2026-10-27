import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function once(source, before, after) {
  if (source.split(before).length !== 2)
    throw new Error(
      'Pinned desktop computer contract changed; review before building.',
    );
  return source.replace(before, () => after);
}
export function desktopServer(source) {
  let result = once(
    source,
    '  port: PORT,',
    '  unix: "/tmp/fulldots-desktop.sock",',
  );
  result = once(
    result,
    '    const session = sessions.for(botId);',
    '    const session = sessions.for(botId);\n    bindDesktopControl(session.control);',
  );
  result = once(
    result,
    '      if (url.pathname === "/stream") {',
    `      if (url.pathname.startsWith("/desktop/") || HUMAN_INPUT.has(url.pathname)) {
        return await desktopRequest(request, session.control);
      }
      if (url.pathname === "/stream") {`,
  );
  result = once(
    result,
    '            ws.send(JSON.stringify(frame));',
    '            if (ws.getBufferedAmount() < 2 * 1024 * 1024) ws.send(JSON.stringify(frame));',
  );
  return `import { bindDesktopControl, desktopRequest } from "./desktop/service.mjs";\n${result}`;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const dir = process.argv[2];
  await copyFile(
    join(dir, 'screencast.ts'),
    join(dir, 'browser-screencast.ts'),
  );
  await writeFile(
    join(dir, 'index.ts'),
    desktopServer(await readFile(join(dir, 'index.ts'), 'utf8')),
  );
  await writeFile(
    join(dir, 'screencast.ts'),
    'export type { InputMessage } from "./browser-screencast";\nexport { startScreencast } from "./desktop/service.mjs";\n',
  );
}
