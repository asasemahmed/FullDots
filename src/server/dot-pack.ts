// Export and import of Dot packs. A pack is built only from the fields in src/shared/dot-pack.ts.
// Every text field goes through redactForStorage on the way out and again on the way in, so a
// secret pasted into a role never leaves in a file, and a file that carries one never lands in
// the database.
import type { Dot } from '../shared/types.js';
import {
  DOT_PACK_KIND,
  DOT_PACK_MAX_CHARS,
  DOT_PACK_VERSION,
  dotPackProblem,
  dotPackSchema,
  type DotPack,
} from '../shared/dot-pack.js';
import { isLocked, isRuleCategory, RULE_LABELS } from '../shared/rules.js';
import { redactForStorage } from './redaction.js';
import type { WorkspaceStore } from './workspace.js';

/** A pack that cannot be imported, with the reason to show the owner. */
export class DotPackError extends Error {
  constructor(
    message: string,
    public status: 400 | 413 = 400,
  ) {
    super(message);
  }
}

/** The file a Dot is exported to: its name in lower case, with dashes. */
export function dotPackFileName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${slug || 'dot'}.dot-pack.json`;
}

/** The pack for a Dot. Only the listed fields; secrets in the text are replaced. */
export function exportDotPack(workspace: WorkspaceStore, dot: Dot): DotPack {
  const clean = (text: string) => redactForStorage(text);
  const rules = Object.fromEntries(
    Object.entries(workspace.rules.get(dot.id)).filter(
      ([, rule]) => rule !== 'inherit',
    ),
  ) as DotPack['rules'];
  const prompts = workspace.prompts
    .list(dot.id)
    .filter((prompt) => prompt.scope === 'dot' && prompt.dotId === dot.id)
    .map((prompt) => ({
      title: clean(prompt.title),
      body: clean(prompt.body),
    }));
  return {
    kind: DOT_PACK_KIND,
    version: DOT_PACK_VERSION,
    name: clean(dot.name),
    instructions: clean(dot.instructions),
    color: dot.color ?? null,
    species: dot.species ?? null,
    gear: dot.gear ?? 'none',
    approvalMode: dot.approvalMode ?? 'sensitive',
    researchAllowed: dot.researchAllowed,
    memoryAllowed: dot.memoryAllowed,
    rules,
    prompts,
  };
}

/** Reads a pack file's text. The size check comes first, so an oversize file is never parsed. */
export function parseDotPack(text: string): DotPack {
  if (text.length > DOT_PACK_MAX_CHARS)
    throw new DotPackError(
      'This pack is too large. A Dot pack is at most 200 KB.',
      413,
    );
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DotPackError('This file is not valid JSON.');
  }
  const parsed = dotPackSchema.safeParse(raw);
  if (!parsed.success) throw new DotPackError(dotPackProblem(parsed.error));
  return parsed.data;
}

export interface ImportedDot {
  dot: Dot;
  /** How many secret-looking values were replaced on the way in. */
  hidden: number;
}

/**
 * Creates a new Dot from a pack. It never overwrites a Dot. The Dot starts with no connector
 * grants, no Composio access and no computer access, and it uses the default model.
 */
export function importDotPack(
  workspace: WorkspaceStore,
  pack: DotPack,
): ImportedDot {
  for (const [category, rule] of Object.entries(pack.rules)) {
    if (isRuleCategory(category) && isLocked(category) && rule === 'allow')
      throw new DotPackError(
        `${RULE_LABELS[category]} can only be Inherit, Ask me first or Never.`,
      );
  }
  const space = workspace.spaces()[0];
  if (!space) throw new DotPackError('Create a Space before importing a Dot.');

  let hidden = 0;
  const clean = (text: string) =>
    redactForStorage(text, (count) => {
      hidden += count;
    });
  // A pack may ask for more caution, never for less: "off" means sensitive.
  const approvalMode =
    pack.approvalMode === 'off' ? 'sensitive' : pack.approvalMode;
  const dot = workspace.createDot(
    space.id,
    clean(pack.name),
    clean(pack.instructions),
    pack.researchAllowed,
    pack.memoryAllowed,
    [space.id],
    null,
    approvalMode,
    null,
    {
      color: pack.color ?? null,
      species: pack.species ?? null,
      gear: pack.gear,
    },
  );
  workspace.rules.set(dot.id, pack.rules);
  for (const prompt of pack.prompts)
    workspace.prompts.create({
      title: clean(prompt.title),
      body: clean(prompt.body),
      scope: 'dot',
      dotId: dot.id,
      teamId: null,
    });
  return { dot: workspace.dot(dot.id)!, hidden };
}
