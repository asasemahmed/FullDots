// Makes a Dot that runs out of steps or time end its turn with a summary instead of mid-sentence.
//
// The agent loop counts model turns. Stopping it when the count is reached leaves the last turn's tool
// results unanswered: the person gets no reply at all, or one that was cut off. Instead the last turn
// the budget allows is spent without tools, with an instruction to say where things stand.
import { defineChatMiddleware } from '@tanstack/ai';

/** Shared between the timers that notice a budget running out and the loop that acts on it. */
export interface TurnBudget {
  /** Set when the turn has run out of something; the next model turn becomes the summary. */
  wrapUp?: 'steps' | 'time';
  /** True once that summary turn has been started. */
  summarizing?: boolean;
}

export const wrapUpInstruction = (reason: 'steps' | 'time') =>
  `${
    reason === 'steps'
      ? 'You have used all the steps allowed for this turn'
      : 'The time allowed for this turn has run out'
  }, so you cannot use any more tools now. Reply to the user with a short final message in the language they are using: what you did, what is still left to do, and anything you need from them to continue. Do not claim anything succeeded without tool evidence, do not start new work, and do not promise to do more in this reply.`;

/**
 * Spends the last allowed model turn on a summary.
 *
 * With a limit of one step there is no turn to spare, so tools stay available. The summary turn is
 * also used when `budget.wrapUp` is set from outside, which is how the turn timeout asks for it.
 */
export function turnBudget(maxSteps: number, budget: TurnBudget) {
  return defineChatMiddleware({
    name: 'turn-budget',
    onConfig(ctx, config) {
      if (ctx.phase !== 'beforeModel') return;
      if (!budget.wrapUp && maxSteps > 1 && ctx.iteration >= maxSteps - 1)
        budget.wrapUp = 'steps';
      if (!budget.wrapUp) return;
      budget.summarizing = true;
      return {
        tools: [],
        systemPrompts: [
          ...config.systemPrompts,
          wrapUpInstruction(budget.wrapUp),
        ],
      };
    },
    onShouldContinue() {
      if (budget.summarizing) return false;
    },
  });
}
