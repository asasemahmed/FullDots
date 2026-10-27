function once(source, before, after) {
  if (source.split(before).length !== 2)
    throw new Error(
      'Pinned desktop supervisor contract changed; review before building.',
    );
  return source.replace(before, () => after);
}

export function desktopSupervisorIndex(source) {
  let result = `import { DEFAULT_DESKTOP_IMAGE, memoryForKind, requestedComputerKind } from "./computer-desktop";\n${source}`;
  result = once(
    result,
    '  ComputerNotAnsweringError,',
    '  ComputerNotAnsweringError,\n  reconcileDesktopWorkers,',
  );
  result = once(
    result,
    'const network = process.env.COMPUTER_NETWORK?.trim() || undefined;',
    'const desktopImage = process.env.COMPUTER_DESKTOP_IMAGE?.trim() || DEFAULT_DESKTOP_IMAGE;\nconst network = process.env.COMPUTER_NETWORK?.trim() || undefined;',
  );
  result = once(
    result,
    '    const identity = await registerEntry(parsed.names);',
    `    const kind = await requestedComputerKind(context.req.raw);
    if (!kind) return context.json({ error: "Choose browser or desktop; no other options are accepted." }, 400);
    const memory = memoryForKind(kind, process.env.COMPUTER_MEMORY_BYTES, memoryBytes);
    const identity = await registerEntry(parsed.names);`,
  );
  result = once(
    result,
    '      image,\n      environment:',
    '      image: kind === "desktop" ? desktopImage : image,\n      kind,\n      environment:',
  );
  result = once(
    result,
    '      ...(memoryBytes ? { memoryBytes } : {}),',
    '      ...(memory !== undefined ? { memoryBytes: memory } : {}),',
  );
  return `${result}\nlet desktopSweep = false;
setInterval(async () => {
  if (desktopSweep) return;
  desktopSweep = true;
  try { await reconcileDesktopWorkers(); }
  catch { /* Docker health already reports an unavailable engine. */ }
  finally { desktopSweep = false; }
}, 3000);\n`;
}

export function desktopSupervisorDocker(source) {
  let result = once(
    source,
    '  image: string;',
    '  image: string;\n  kind?: "browser" | "desktop";',
  );
  result = once(
    result,
    '          Labels: labelsFor(names),\n          Env:',
    '          Labels: { ...labelsFor(names), "fulldots.computer.kind": options.kind ?? "browser" },\n          Env:',
  );
  result = once(
    result,
    '    await waitUntilAnswering(names.container, options.readyTimeoutMs);',
    '    if (options.kind === "desktop") await startDesktopWorker(names.container);\n    await waitUntilAnswering(names.container, options.readyTimeoutMs);',
  );
  return `${result}
async function startDesktopWorker(name: string) {
  const container = docker.getContainer(name);
  const info = await container.inspect();
  if (!ours(info.Config?.Labels) || info.Config?.Labels?.["fulldots.computer.kind"] !== "desktop")
    throw new Error("Desktop worker ownership was not confirmed.");
  const worker = await container.exec({
    User: "1001", Cmd: ["/opt/fulldots-desktop/worker.sh"],
    Env: ["COMPUTER_TOKEN=desktop-internal-transport-only-0000", "HOME=/home/desktop", "DISPLAY=:0"],
    AttachStdin: false, AttachStdout: false, AttachStderr: false, Tty: false,
  });
  await worker.start({ Detach: true, Tty: false });
}

export async function reconcileDesktopWorkers() {
  const containers = await docker.listContainers({ filters: { label: [OWNER_LABEL + "=true", "fulldots.computer.kind=desktop"] } });
  for (const entry of containers) {
    if (!ours(entry.Labels)) continue;
    const info = await docker.getContainer(entry.Id).inspect();
    if (info.State?.Running && info.State?.Health?.Status !== "healthy")
      await startDesktopWorker(entry.Id);
  }
}\n`;
}
