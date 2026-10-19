// The approval gate: a chat middleware that stands between the model and every server tool.
//
// Before a tool runs it decides one of three things: let it run, answer for it with a stored result
// (a gated action waits for the owner, a secret field needs the owner, the owner denied the tool), or,
// once the turn is paused, answer "paused" for every other tool of the same reply. Pausing also asks the
// turn budget for a tool-less summary, so the model explains what it waits for and the turn ends. The
// owner's decision later starts a new turn in the same thread (ApprovalService -> ResumeQueue).
//
// IMPORTANT: TanStack may run the hooks of the tool calls of one reply concurrently. Everything in
// `onBeforeToolCall` up to the moment a decision is made is therefore synchronous, and `gate.pause`
// runs before the first `await`, so a sibling call sees the pause.
import { defineChatMiddleware, type ChatMiddleware } from '@tanstack/ai';
import { z } from 'zod';
import {
  computerInputs,
  type ComputerInputs,
} from '../shared/computer-types.js';
import type {
  ApprovalMode,
  Handoff,
  HandoffKind,
  HandoffResult,
  PausedResult,
  PendingApprovalResult,
  TurnSource,
} from '../shared/types.js';
import { RULE_LABELS, type DotRules } from '../shared/rules.js';
import type { ApprovalService } from './approval-service.js';
import { requestApprovalInput, requestHandoffInput } from './approval-tools.js';
import {
  dockerSetupInput,
  type DockerStep,
} from '../shared/docker-setup-types.js';
import {
  classify,
  intentHash,
  pickIntentArgs,
  redactArgs,
  type Classification,
  type ElementIdentity,
  type McpToolMeta,
} from './approvals.js';
import { selectInputSchema, type GateComputer } from './computer-agent.js';
import { detectChallenge, detectTypeHandoff } from './handoff-detect.js';
import type { TurnBudget } from './turn-budget.js';
import { askOwnerInput, type QuestionResult } from './inbox-tools.js';
import type { InboxService } from './inbox-service.js';

export type { GateComputer };

// handoff hooks (E2 adjusts this region: the starter contract and the pieces below that use it)
/** What the gate needs from the handoff service. `HandoffService` implements it. */
export interface HandoffStarter {
  start(input: {
    dotId: string;
    threadId: string;
    kind: HandoffKind;
    reason: string;
  }): Promise<Handoff>;
}
const HANDOFF_FAILED =
  'The owner could not be asked to take over just now. Do not retry; tell the user what is blocking you.';
// end handoff hooks

export interface GateDeps {
  dotId: string;
  /** The Dot's name, used in the owner-facing summary: "<name> wants to ...". */
  dotName: string;
  threadId: string;
  source: TurnSource | 'chat';
  /** The approval id when this is an approval resume turn: only that approval can be used. */
  ref?: string;
  mode: ApprovalMode;
  budget: TurnBudget;
  approvals: Pick<ApprovalService, 'request' | 'consume'>;
  handoffs: HandoffStarter;
  computer?: GateComputer;
  mcpInfo: (toolName: string) => McpToolMeta | undefined;
  /** The Dot's rules per category, read on every call so a change applies at once. */
  rules?: () => Partial<DotRules>;
  /** Zod parse for computer tools (defaults applied), the raw object for the others. See {@link gateParse}. */
  parse: (toolName: string, args: unknown) => Record<string, unknown>;
  /** The commands a Docker setup step runs, shown to the owner as the exact action to approve. */
  dockerCommands?: (step: DockerStep) => string[];
  /** Stores `ask_owner` questions; given only on turns that offer the tool. */
  questions?: Pick<InboxService, 'ask'>;
}

export interface TurnGate {
  paused?: { kind: 'approval' | 'handoff' | 'question'; ref: string };
  pause(kind: 'approval' | 'handoff' | 'question', ref: string): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Parses the arguments of computer tools with the same schemas the tools use (defaults applied), and
 * passes every other tool's arguments through as a plain object. Throws a ZodError for invalid
 * computer arguments. `inputs` defaults to the default limits; pass `ComputerService.inputs` to use
 * the configured ones.
 */
export function gateParse(
  toolName: string,
  args: unknown,
  inputs: ComputerInputs = computerInputs,
): Record<string, unknown> {
  const object = isRecord(args) ? args : {};
  if (toolName === 'docker_setup') return dockerSetupInput.parse(object);
  if (toolName.startsWith('computer_')) {
    const action = toolName.slice('computer_'.length);
    if (action === 'select')
      return { ...selectInputSchema.parse(object) } as Record<string, unknown>;
    if (!action.startsWith('human_') && Object.hasOwn(inputs, action))
      return inputs[action as keyof ComputerInputs].parse(object) as Record<
        string,
        unknown
      >;
  }
  return object;
}

/** Tools that act on an element of the page the agent saw in this turn. */
const REF_TOOLS = new Set([
  'computer_click',
  'computer_type',
  'computer_select',
]);
/** Tools whose meaning depends on which page is open, so the page address is part of the approved intent. */
const PAGE_TOOLS = new Set([...REF_TOOLS, 'computer_key']);

const UNKNOWN_REF =
  'That ref is not from this turn. Take a fresh snapshot and call request_approval again.';
const DENIED = 'The owner denied this tool for this Dot.';
/** A rule set to Never: the same refusal as a `deny` override, naming the rule. */
const ruleDenied = (classification: Classification) =>
  `The owner does not allow this Dot to do this (rule: ${
    classification.category ? RULE_LABELS[classification.category] : 'unknown'
  }: Never). Do not try another way; tell the owner what you could not do.`;

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
};
const label = (element: ElementIdentity) =>
  `${element.role} "${clip(element.name, 80)}"`;

/** A short description of the action for the owner: what comes after "<Dot> wants to". */
const DOCKER_ACTIONS: Record<string, string> = {
  check: 'check whether Docker is installed and running',
  'start-docker': 'open Docker Desktop and wait for it to start',
  'install-docker': 'install Docker Desktop on this machine',
  'create-computers':
    'build and start the Dot computers with Docker (adds computer settings to .env)',
};
function describeAction(
  tool: string,
  args: Record<string, unknown>,
  element: ElementIdentity | undefined,
  focus: ElementIdentity | undefined,
): string {
  const target = element ? label(element) : 'an element on the page';
  switch (tool) {
    case 'computer_exec':
      return 'run a shell command';
    case 'computer_files_write':
      return 'write a file';
    case 'save_space_file':
      return `save ${clip(String(args.name ?? 'a file'), 60)} in a Space`;
    case 'copy_computer_file_to_space':
      return `copy ${clip(String(args.path ?? 'a file'), 60)} into a Space`;
    case 'create_space_page':
      return 'create a page';
    case 'edit_space_page':
      return 'edit a page';
    case 'delegate_to_dot':
      return `hand work to ${clip(String(args.dot ?? 'a teammate'), 40)}`;
    case 'hand_to_dot':
      return `hand this chat to ${clip(String(args.dot ?? 'another Dot'), 40)}`;
    case 'start_team_run': {
      const names = Object.keys((args.briefs ?? {}) as object);
      return names.length
        ? `start a team run with ${clip(names.join(', '), 60)}`
        : 'start a team run with every member';
    }
    case 'docker_setup':
      return (
        DOCKER_ACTIONS[String(args.step)] ?? 'change Docker on this machine'
      );
    case 'computer_click':
      return `click the ${target}`;
    case 'computer_select':
      return `choose an option in the ${target}`;
    case 'computer_type':
      return `type into the ${target}${args.submit === true ? ' and press Enter' : ''}`;
    case 'computer_key':
      return `press ${clip(String(args.key ?? 'a key'), 40)}${
        focus ? ` in the ${label(focus)}` : ''
      }`;
    default:
      return `use ${tool}`;
  }
}

const zodText = (error: unknown): string =>
  error instanceof z.ZodError
    ? error.issues
        .map((issue) =>
          issue.path.length
            ? `${issue.path.join('.')}: ${issue.message}`
            : issue.message,
        )
        .join('; ')
    : error instanceof Error
      ? error.message
      : 'The arguments are not valid.';

const skip = (result: unknown) => ({ type: 'skip' as const, result });

export function approvalGate(deps: GateDeps): {
  middleware: ChatMiddleware;
  gate: TurnGate;
} {
  const gate: TurnGate = {
    paused: undefined,
    pause(kind, ref) {
      this.paused = { kind, ref };
    },
  };
  /** One handoff per turn is enough: the turn ends with the first one. */
  let handoffStarted = false;

  const pausedResult = (): PausedResult => ({
    paused: `${gate.paused?.kind ?? 'approval'} pending`,
    ref: gate.paused?.ref ?? '',
  });

  /** What identifies an action: the hash the approval is matched by, and the text the owner reads. */
  function fingerprint(
    tool: string,
    parsed: Record<string, unknown>,
    element: ElementIdentity | undefined,
    focus: ElementIdentity | undefined,
  ) {
    const url = PAGE_TOOLS.has(tool) ? deps.computer?.latestUrl() : undefined;
    return {
      hash: intentHash({
        tool,
        url,
        element,
        args: pickIntentArgs(tool, parsed),
      }),
      redacted:
        tool === 'docker_setup' && deps.dockerCommands
          ? deps.dockerCommands(parsed.step as DockerStep).join('\n')
          : redactArgs(tool, parsed, element, focus),
    };
  }

  function elementOf(
    tool: string,
    parsed: Record<string, unknown>,
  ): ElementIdentity | undefined {
    if (!REF_TOOLS.has(tool)) return undefined;
    return deps.computer?.identityInTurn(
      String(parsed.ref),
      Number(parsed.snapshotId),
    );
  }

  function pendApproval(input: {
    toolCallId: string;
    tool: string;
    argsHash: string | null;
    summary: string;
    argsRedacted: string;
  }) {
    const approval = deps.approvals.request({
      threadId: deps.threadId,
      dotId: deps.dotId,
      ...input,
    });
    gate.pause('approval', approval.id);
    deps.budget.wrapUp = 'approval';
    const result: PendingApprovalResult = {
      status: 'pending_approval',
      approvalId: approval.id,
      summary: approval.summary,
      exact: approval.argsRedacted,
      ...(approval.argsHash === null ? { advisory: true as const } : {}),
    };
    return skip(result);
  }

  // handoff hooks
  /**
   * Pauses the turn for a handoff. The pause is set before the first await, so sibling calls that
   * the engine starts meanwhile see it; the placeholder ref is replaced once the handoff exists.
   */
  async function beginHandoff(detection: {
    kind: HandoffKind;
    reason: string;
  }) {
    const placeholder = 'pending';
    handoffStarted = true;
    gate.pause('handoff', placeholder);
    deps.budget.wrapUp = 'handoff';
    try {
      const handoff = await deps.handoffs.start({
        dotId: deps.dotId,
        threadId: deps.threadId,
        kind: detection.kind,
        reason: detection.reason,
      });
      if (gate.paused?.ref === placeholder) gate.pause('handoff', handoff.id);
      const result: HandoffResult = {
        status: 'handoff',
        handoffId: handoff.id,
        kind: handoff.kind,
        reason: handoff.reason,
        note: 'Nothing was typed: the owner enters this on the live screen.',
      };
      return skip(result);
    } catch (error) {
      // No handoff exists, so nobody would ever be asked: do not leave the turn paused.
      if (gate.paused?.ref === placeholder) gate.paused = undefined;
      if (deps.budget.wrapUp === 'handoff') deps.budget.wrapUp = undefined;
      handoffStarted = false;
      console.error(
        `Handoff could not be started: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return skip({ error: HANDOFF_FAILED });
    }
  }

  function requestHandoff(args: unknown) {
    const input = requestHandoffInput.safeParse(args);
    if (!input.success) return skip({ error: zodText(input.error) });
    return beginHandoff({ kind: 'other', reason: input.data.reason });
  }

  /** A verification challenge in a computer result: the page needs the owner, whatever the model does next. */
  async function challengeHandoff(result: unknown) {
    const detection = detectChallenge(result);
    if (!detection || handoffStarted) return;
    // Synchronous up to here, then the same pause-before-await rule as for typing into a secret field.
    handoffStarted = true;
    const placeholder = 'pending';
    const alreadyPaused = !!gate.paused;
    if (!alreadyPaused) gate.pause('handoff', placeholder);
    const hadWrapUp = !!deps.budget.wrapUp;
    if (!hadWrapUp) deps.budget.wrapUp = 'handoff';
    try {
      const handoff = await deps.handoffs.start({
        dotId: deps.dotId,
        threadId: deps.threadId,
        kind: detection.kind,
        reason: detection.reason,
      });
      if (gate.paused?.ref === placeholder) gate.pause('handoff', handoff.id);
    } catch (error) {
      if (gate.paused?.ref === placeholder) gate.paused = undefined;
      if (!hadWrapUp && deps.budget.wrapUp === 'handoff')
        deps.budget.wrapUp = undefined;
      handoffStarted = false;
      console.error(
        `Handoff could not be started: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
  // end handoff hooks

  function requestApproval(toolCallId: string, args: unknown) {
    const input = requestApprovalInput.safeParse(args);
    if (!input.success) return skip({ error: zodText(input.error) });
    const { summary, intent } = input.data;
    if (!intent)
      return pendApproval({
        toolCallId,
        tool: 'request_approval',
        argsHash: null,
        summary,
        argsRedacted: '(no specific action: advisory)',
      });
    let parsed: Record<string, unknown>;
    try {
      parsed = deps.parse(intent.tool, intent.args);
    } catch (error) {
      return skip({ error: zodText(error) });
    }
    if (deps.mcpInfo(intent.tool)?.override === 'deny')
      return skip({ error: DENIED });
    const element = elementOf(intent.tool, parsed);
    if (REF_TOOLS.has(intent.tool) && !element)
      return skip({ error: UNKNOWN_REF });
    const focus =
      intent.tool === 'computer_key'
        ? deps.computer?.presumedFocus()
        : undefined;
    const ruled = classify(
      {
        tool: intent.tool,
        args: parsed,
        element,
        focus,
        latestElements: deps.computer?.latestElements(),
        mcp: deps.mcpInfo(intent.tool),
      },
      deps.mode,
      deps.rules?.(),
    );
    if (ruled.denied) return skip({ error: ruleDenied(ruled) });
    const { hash, redacted } = fingerprint(intent.tool, parsed, element, focus);
    return pendApproval({
      toolCallId,
      tool: intent.tool,
      argsHash: hash,
      summary,
      argsRedacted: redacted,
    });
  }

  /** A question for the owner: stored, and the turn wraps up. It unlocks nothing. */
  function askOwner(args: unknown) {
    const questions = deps.questions;
    if (!questions) return undefined;
    const input = askOwnerInput.safeParse(args);
    if (!input.success) return skip({ error: zodText(input.error) });
    const item = questions.ask({
      dotId: deps.dotId,
      threadId: deps.threadId,
      question: input.data.question,
    });
    gate.pause('question', item.id);
    deps.budget.wrapUp = 'question';
    const result: QuestionResult = {
      status: 'question',
      questionId: item.id,
      note: "The question is in the owner's inbox. You will be resumed in this conversation with the answer.",
    };
    return skip(result);
  }

  const middleware = defineChatMiddleware({
    name: 'approval-gate',
    onBeforeToolCall(_ctx, { toolName, toolCallId, args }) {
      // Once the turn is paused nothing else may act: siblings of the paused call get a stored answer.
      if (gate.paused) return skip(pausedResult());
      if (toolName === 'request_approval')
        return requestApproval(toolCallId, args);
      if (toolName === 'request_handoff') return requestHandoff(args);
      if (toolName === 'ask_owner' && deps.questions) return askOwner(args);

      let parsed: Record<string, unknown>;
      try {
        parsed = deps.parse(toolName, args);
      } catch {
        // Invalid arguments: the tool's own validation reports them, and nothing runs.
        return undefined;
      }
      const computer = deps.computer;
      const element = elementOf(toolName, parsed);
      // An element that is not from this turn: AgentComputer refuses to act blind and hands back a fresh page.
      if (REF_TOOLS.has(toolName) && !element) return undefined;

      if (toolName === 'computer_type') {
        const detection = detectTypeHandoff(
          element,
          computer?.latestElements() ?? [],
        );
        if (detection) return beginHandoff(detection);
      }

      const mcp = deps.mcpInfo(toolName);
      if (mcp?.override === 'deny') return skip({ error: DENIED });
      const focus =
        toolName === 'computer_key' ? computer?.presumedFocus() : undefined;
      const classification = classify(
        {
          tool: toolName,
          args: parsed,
          element,
          focus,
          latestElements: computer?.latestElements(),
          mcp,
        },
        deps.mode,
        deps.rules?.(),
      );
      // Never: refused before anything runs, and no approval can unlock it.
      if (classification.denied)
        return skip({ error: ruleDenied(classification) });
      if (!classification.gated) return undefined;

      const { hash, redacted } = fingerprint(toolName, parsed, element, focus);
      // The owner approved exactly this action: it runs now, once, and only on the turn the
      // approval resumed. A later turn of the thread asks again.
      if (
        deps.source === 'approval' &&
        deps.ref &&
        deps.approvals.consume(deps.threadId, hash, deps.ref)
      )
        return undefined;
      return pendApproval({
        toolCallId,
        tool: toolName,
        argsHash: hash,
        summary: `${deps.dotName} wants to ${describeAction(toolName, parsed, element, focus)}`,
        argsRedacted: redacted,
      });
    },
    async onAfterToolCall(_ctx, info) {
      if (!info.ok || !info.toolName.startsWith('computer_')) return;
      await challengeHandoff(info.result);
    },
  });

  return { middleware, gate };
}
