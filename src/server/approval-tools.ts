// The two tools a Dot uses to ask the owner for something: `request_approval` before an action the
// owner should confirm, `request_handoff` when a page needs a person. Both are handled by the approval
// gate (src/server/approval-gate.ts), because only the gate hook sees the tool call id that makes the
// request idempotent. The executors below are never reached while the gate is installed.
import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import type { ApprovalMode } from '../shared/types.js';

export const requestApprovalInput = z
  .object({
    summary: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe(
        'One or two sentences the owner reads: what you want to do and why.',
      ),
    intent: z
      .object({
        tool: z
          .string()
          .min(1)
          .max(200)
          .describe(
            'The tool you will call after approval, for example computer_exec or computer_click.',
          ),
        args: z
          .record(z.string(), z.unknown())
          .describe(
            'The exact arguments of that call. For a computer_click, computer_type or computer_select call pass the ref and snapshotId from the latest page.',
          ),
      })
      .optional()
      .describe(
        'The exact call you will make once approved. When given, the approval covers that call and is used up by it. Leave it out for a general question to the owner.',
      ),
  })
  .strict();
export type RequestApprovalInput = z.infer<typeof requestApprovalInput>;

export const requestHandoffInput = z
  .object({
    reason: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .describe(
        'What the owner has to do on the computer, in one sentence. Never include a secret.',
      ),
  })
  .strict();
export type RequestHandoffInput = z.infer<typeof requestHandoffInput>;

/** What the placeholder executors return; the gate answers these tools before they run. */
const HANDLED_BY_GATE = {
  error: 'This tool is handled by the approval system.',
};

export function requestApprovalTool() {
  return defineTool({
    name: 'request_approval',
    description:
      'Ask the owner to approve an action before you do it. Use it for an action the owner should confirm that the system might not catch on its own (sending something to other people, publishing, paying, deleting, anything hard to undo). Pass `intent` with the exact tool call you will make, so the approval covers exactly that call; without `intent` the owner is only asked a question and the approval does not unlock any tool. After calling it, stop using tools and explain that you are waiting: you will be resumed when the owner decides.',
    parameters: requestApprovalInput,
    execute: async () => HANDLED_BY_GATE,
  });
}

export function requestHandoffTool() {
  return defineTool({
    name: 'request_handoff',
    description:
      'Ask the owner to take over the computer for a step you must not do yourself: a password, a verification code or a human check, in particular in a field that is not clearly labelled. Never type or ask for the secret yourself. After calling it, stop using tools: you will be resumed when the owner hands the computer back.',
    parameters: requestHandoffInput,
    execute: async () => HANDLED_BY_GATE,
  });
}

/** The text the orchestrator adds to the Dot's system prompt for its approval mode. */
export const approvalPrompt = (mode: ApprovalMode): string =>
  mode === 'off'
    ? 'Actions run without asking the owner first. Passwords, verification codes and human checks still need the owner: use `request_handoff({ reason })` when a page needs one in a field that is not clearly labelled, and never ask the owner to paste a secret into the chat or try to solve a verification challenge.'
    : "Some actions (sending, publishing, paying, deleting, destructive shell commands, connector tools that change data) pause for the owner's approval. When a tool returns `pending_approval`, stop using tools and summarize; you will be resumed when the owner decides. Use `request_approval({ summary, intent })` before an action the owner should confirm that the system might not catch; use `request_handoff({ reason })` when a page needs a password, a code or a human check in a field that is not clearly labelled. Never ask the owner to paste passwords or codes into the chat and never try to solve a verification challenge.";
