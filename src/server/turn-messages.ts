// Gives each stretch of assistant text in one agent run its own message.
//
// The runtime streams a whole run into a single assistant message: every piece of text is appended to
// it and every tool call is attached to it. A short line said before acting ("Let me open the page.")
// and the answer given after the work then run together in one bubble, and the transcript cannot tell
// which came first. Here, text that resumes after tool calls starts a new message, and a tool call is
// attached to the message that is current when it starts, so the transcript reads in the order things
// happened.
import { randomUUID } from 'node:crypto';
import { EventType, type BaseEvent } from '@ag-ui/core';

type Chunk = BaseEvent & {
  messageId?: string;
  parentMessageId?: string;
  delta?: string;
};

export class TurnMessages {
  /** The id the runtime uses for the whole run. Learned from the first event that carries it. */
  private base?: string;
  /** The id of the message text and tool calls currently belong to. */
  private segment?: string;
  private count = 0;
  /** A tool call has started since the last text, so the next text is a new message. */
  private afterTools = false;
  /** The current message already has text. */
  private shown = false;

  /** Rewrites one runtime event. It returns nothing for text that would only add blank space. */
  map(event: BaseEvent): BaseEvent[] {
    const chunk = event as Chunk;
    if (event.type === EventType.TEXT_MESSAGE_CHUNK) return this.text(chunk);
    if (event.type === EventType.TOOL_CALL_START) {
      this.base ??= chunk.parentMessageId;
      this.segment ??= this.base;
      if (chunk.parentMessageId !== this.base || !this.segment) return [event];
      this.afterTools = true;
      return [{ ...chunk, parentMessageId: this.segment } as BaseEvent];
    }
    return [event];
  }

  /** Text of our own, always in a message of its own, for example why a turn was cut short. */
  notice(text: string): BaseEvent[] {
    this.base ??= randomUUID();
    if (this.shown || this.afterTools) this.afterTools = true;
    return this.text({
      type: EventType.TEXT_MESSAGE_CHUNK,
      role: 'assistant',
      messageId: this.base,
      delta: text,
    } as Chunk);
  }

  private text(chunk: Chunk): BaseEvent[] {
    this.base ??= chunk.messageId;
    this.segment ??= this.base;
    if (chunk.messageId !== this.base || typeof chunk.delta !== 'string')
      return [chunk];
    const startsMessage = !this.shown || this.afterTools;
    if (!startsMessage)
      return [{ ...chunk, messageId: this.segment } as BaseEvent];
    // Leading blank space would make an empty-looking bubble, or one that starts with a gap.
    const delta = chunk.delta.trimStart();
    if (!delta) return [];
    if (this.afterTools) {
      this.segment = `${this.base}-${++this.count}`;
      this.afterTools = false;
    }
    this.shown = true;
    return [{ ...chunk, messageId: this.segment, delta } as BaseEvent];
  }
}
