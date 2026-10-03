import { z } from 'zod';
export const computerPermissionsSchema = z
  .object({
    enabled: z.boolean(),
    browser: z.boolean(),
    files: z.boolean(),
    shell: z.boolean(),
  })
  .strict();
export type ComputerPermissions = z.infer<typeof computerPermissionsSchema>;
export interface ComputerAudit {
  id: string;
  action: string;
  actor: 'owner' | 'agent';
  outcome: 'pending' | 'succeeded' | 'failed';
  createdAt: number;
}
export interface ComputerControl {
  holder: 'bot' | 'human';
  requested: boolean;
  transitioning: boolean;
  resumeSnapshotRequired: boolean;
  request?: { id: string; status: string };
}
export interface ComputerStatus {
  configured: boolean;
  state: 'not_configured' | 'stopped' | 'running' | 'unavailable';
  permissions: ComputerPermissions;
  audit: ComputerAudit[];
  control?: ComputerControl;
  error?: string;
  limits?: ComputerInputLimits;
}
const path = z
  .string()
  .max(1024)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.includes('\\') &&
      !p.includes('\0') &&
      !p.split('/').some((s) => s === '..'),
    'Use a relative workspace path without traversal.',
  );
const empty = z.object({}).strict();
const ref = {
  ref: z.string().min(1).max(100),
  snapshotId: z.number().int().nonnegative(),
};
export interface ComputerInputLimits {
  execMaxMs: number;
  commandChars: number;
  fileChars: number;
  typeChars: number;
}
export const defaultComputerInputLimits: ComputerInputLimits = {
  execMaxMs: 60_000,
  commandChars: 8000,
  fileChars: 100_000,
  typeChars: 16_000,
};
export const computerInputSchemas = (limits: ComputerInputLimits) => ({
  navigate: z
    .object({
      url: z
        .string()
        .url()
        .max(2048)
        .refine(
          (s) =>
            ['http:', 'https:'].includes(new URL(s).protocol) &&
            !new URL(s).username &&
            !new URL(s).password,
        ),
    })
    .strict(),
  read: empty,
  snapshot: empty,
  screenshot: empty,
  click: z.object(ref).strict(),
  type: z
    .object({
      ...ref,
      text: z.string().max(limits.typeChars),
      submit: z.boolean().optional(),
    })
    .strict(),
  key: z.object({ key: z.string().min(1).max(100) }).strict(),
  scroll: z
    .object({ deltaY: z.number().finite().min(-10000).max(10000) })
    .strict(),
  files_list: z.object({ path: path.default('') }).strict(),
  files_read: z.object({ path: path.refine((p) => p.length > 0) }).strict(),
  files_write: z
    .object({
      path: path.refine((p) => p.length > 0),
      contents: z.string().max(limits.fileChars),
      append: z.boolean().optional(),
    })
    .strict(),
  exec: z
    .object({
      command: z.string().trim().min(1).max(limits.commandChars),
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(limits.execMaxMs)
        .default(Math.min(30_000, limits.execMaxMs)),
    })
    .strict(),
  human_click: z
    .object({
      x: z.number().finite().min(0).max(16000),
      y: z.number().finite().min(0).max(16000),
    })
    .strict(),
  human_type: z.object({ text: z.string().max(limits.typeChars) }).strict(),
  human_key: z.object({ key: z.string().min(1).max(100) }).strict(),
  human_scroll: z
    .object({ deltaY: z.number().finite().min(-10000).max(10000) })
    .strict(),
});
export type ComputerInputs = ReturnType<typeof computerInputSchemas>;
export const computerInputs = computerInputSchemas(defaultComputerInputLimits);
export type ComputerAction = keyof ComputerInputs;

/**
 * Live screen. The server keeps one WebSocket per viewer and relays Chrome's screencast frames and
 * the owner's input. The owner asks for a one-time ticket over the authenticated API, then opens the
 * socket with it, because a browser cannot attach an Authorization header to a WebSocket upgrade.
 */
export const computerStreamPath = (id: string) =>
  `/api/dots/${encodeURIComponent(id)}/computer/stream`;

export interface ComputerStreamTicket {
  ticket: string;
  expiresInMs: number;
}

/** Why a live screen ended. Every reason except `superseded` can be retried by opening it again. */
export type ComputerStreamEndReason =
  'superseded' | 'stopped' | 'unavailable' | 'permission' | 'shutdown';

/** What the server sends. Frames are base64 JPEG exactly as Chrome produced them. */
export type ComputerStreamMessage =
  | { type: 'frame'; data: string; width: number; height: number }
  | { type: 'error'; error: string }
  | { type: 'ended'; reason: ComputerStreamEndReason; message: string };

const coordinate = z.number().finite().min(0).max(16000);
const delta = z.number().finite().min(-10000).max(10000);
/** Chrome's modifier bit mask: Alt 1, Control 2, Meta 4, Shift 8. */
const modifiers = z.number().int().min(0).max(15).optional();

/** What the owner sends. Checked here before it reaches the computer, which checks it again. */
export const computerStreamInputSchema = (
  limits: Pick<ComputerInputLimits, 'typeChars'>,
) =>
  z.discriminatedUnion('type', [
    z
      .object({
        type: z.literal('mouse'),
        event: z.enum(['pressed', 'released', 'moved']),
        x: coordinate,
        y: coordinate,
        button: z.enum(['left', 'right', 'middle']).optional(),
        clickCount: z.number().int().min(1).max(3).optional(),
        modifiers,
      })
      .strict(),
    z
      .object({
        type: z.literal('wheel'),
        x: coordinate,
        y: coordinate,
        deltaX: delta,
        deltaY: delta,
        modifiers,
      })
      .strict(),
    z
      .object({
        type: z.literal('key'),
        event: z.enum(['down', 'up']),
        key: z.string().min(1).max(100),
        code: z.string().min(1).max(100),
        text: z.string().min(1).max(16).optional(),
        windowsVirtualKeyCode: z.number().int().min(1).max(255).optional(),
        modifiers,
      })
      .strict(),
    z
      .object({
        type: z.literal('text'),
        text: z.string().min(1).max(limits.typeChars),
      })
      .strict(),
  ]);
export type ComputerStreamInput = z.infer<
  ReturnType<typeof computerStreamInputSchema>
>;
