// One short line for what a Dot is doing with a tool: the computer activity block and the work
// lanes both describe steps with it ("Opening website", "Using github").
import type { TurnSource } from './types.js';

export const COMPUTER_STEP_LABELS: Record<string, string> = {
  navigate: 'Opening website',
  search: 'Searching the web',
  snapshot: 'Inspecting browser',
  read: 'Reading page',
  screenshot: 'Viewing browser',
  click: 'Clicking in browser',
  type: 'Typing in browser',
  select: 'Choosing an option',
  key: 'Using keyboard',
  scroll: 'Scrolling page',
  files_write: 'Saving file',
  files_read: 'Reading file',
  files_list: 'Listing files',
  exec: 'Running terminal command',
};

/** Steps of the Dot's own tools that are not computer or connector calls. */
const OTHER_STEP_LABELS: Record<string, string> = {
  search_web: 'Searching the web',
  read_public_page: 'Reading a web page',
  delegate_to_dot: 'Handing work on',
  check_delegation: 'Checking on a teammate',
  hand_to_dot: 'Passing the chat on',
  read_space_page: 'Reading a page',
  list_space_pages: 'Looking through pages',
  list_authorized_spaces: 'Looking through Spaces',
  create_space_page: 'Writing a page',
  edit_space_page: 'Editing a page',
  save_space_file: 'Saving a file',
  update_space_file: 'Updating a file',
  copy_computer_file_to_space: 'Moving a file to a Space',
  list_space_files: 'Looking through files',
  read_space_file: 'Reading a file',
  review_space_page: 'Preparing a page for review',
  request_approval: 'Asking for approval',
  request_handoff: 'Asking you to take over',
  ask_owner: 'Asking you a question',
  remember_preference: 'Noting a preference',
  mark_goal_done: 'Wrapping up the goal',
};

/** The connector and tool of an `mcp__<connector>__<tool>` name. */
export function mcpToolName(
  toolName: string,
): { connector: string; tool: string } | undefined {
  const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return match ? { connector: match[1], tool: match[2] } : undefined;
}

/** What a computer or connector call does, in a few words. */
export function computerStepText(toolName: string): string {
  const mcp = mcpToolName(toolName);
  if (mcp) return `Using ${mcp.connector}`;
  return (
    COMPUTER_STEP_LABELS[toolName.replace(/^computer_/, '')] ?? 'Using computer'
  );
}

/** What any tool call does, in a few words. */
export function toolStepLabel(toolName: string): string {
  if (toolName.startsWith('computer_') || toolName.startsWith('mcp__'))
    return computerStepText(toolName);
  return OTHER_STEP_LABELS[toolName] ?? 'Using a tool';
}

/** What started a server-side turn, worded as the transcript and the export label it. */
export const TURN_SOURCE_LABELS: Record<TurnSource, string> = {
  task: 'Scheduled task',
  approval: 'Approval decision',
  handoff: 'Owner handoff',
  trigger: 'Trigger',
  channel: 'Message from channel',
  delegation: 'Delegated work',
  relay: 'Handed over',
  question: 'Your answer',
};
