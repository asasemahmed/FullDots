// A Dot pack is a small JSON file that holds a Dot's role, look, approval mode, rules and saved
// prompts. It never holds ids, conversations, notes, memories, connector grants, Composio settings,
// computer access, model keys or tokens: a pack describes how a Dot works, not what it has access to.
import { z } from 'zod';
import { PROMPT_BODY_MAX, PROMPT_TITLE_MAX } from './prompts.js';
import { RULE_CATEGORIES, RULES } from './rules.js';
import { DOT_COLORS, DOT_GEAR, DOT_SPECIES } from './types.js';

export const DOT_PACK_KIND = 'fulldots-dot-pack';
export const DOT_PACK_VERSION = 1;
/** Largest pack file accepted, in characters. Well above any valid pack; it bounds the work done. */
export const DOT_PACK_MAX_CHARS = 200_000;
export const DOT_PACK_MAX_PROMPTS = 20;

const approvalModes = ['sensitive', 'writes', 'off'] as const;

export const dotPackSchema = z
  .object({
    kind: z.literal(DOT_PACK_KIND, {
      error: 'This file is not a FullDots Dot pack.',
    }),
    version: z.literal(DOT_PACK_VERSION, {
      error: `This pack version is not supported. This FullDots reads version ${DOT_PACK_VERSION}.`,
    }),
    name: z
      .string()
      .trim()
      .min(1, 'The pack needs a name of 1 to 40 characters.')
      .max(40, 'The name is at most 40 characters.'),
    instructions: z
      .string()
      .trim()
      .min(3, 'The role needs at least 3 characters.')
      .max(2000, 'The role is at most 2,000 characters.'),
    color: z.enum(DOT_COLORS).nullish(),
    species: z.enum(DOT_SPECIES).nullish(),
    gear: z.enum(DOT_GEAR).default('none'),
    approvalMode: z.enum(approvalModes).default('sensitive'),
    researchAllowed: z.boolean().default(true),
    memoryAllowed: z.boolean().default(true),
    rules: z.partialRecord(z.enum(RULE_CATEGORIES), z.enum(RULES)).default({}),
    prompts: z
      .array(
        z
          .object({
            title: z
              .string()
              .trim()
              .min(1, 'Each prompt needs a title.')
              .max(
                PROMPT_TITLE_MAX,
                `Prompt titles are at most ${PROMPT_TITLE_MAX} characters.`,
              ),
            body: z
              .string()
              .trim()
              .min(1, 'Each prompt needs text.')
              .max(
                PROMPT_BODY_MAX,
                `Prompts are at most ${PROMPT_BODY_MAX} characters.`,
              ),
          })
          .strict(),
      )
      .max(
        DOT_PACK_MAX_PROMPTS,
        `A pack holds at most ${DOT_PACK_MAX_PROMPTS} prompts.`,
      )
      .default([]),
  })
  .strict();

export type DotPack = z.output<typeof dotPackSchema>;

/** The first problem with a pack, in words the owner can act on. */
export function dotPackProblem(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'This file is not a valid Dot pack.';
  if (issue.code === 'unrecognized_keys') {
    const field = String(issue.keys[0] ?? '').slice(0, 40);
    return `The pack has a field FullDots does not know: ${field}.`;
  }
  const where = issue.path.map(String).join('.');
  // kind and version messages already say what is wrong with the whole file.
  if (!where || where === 'kind' || where === 'version') return issue.message;
  return `${where}: ${issue.message}`;
}
