// The `@` popover of the chat composer: lists Dots (character in its colour, name, role line) and
// inserts `@Name`. Focus stays in the textarea; the highlighted option is announced through
// aria-activedescendant.
import { useState, type KeyboardEvent } from 'react';
import type { Dot } from '../../shared/types';
import type {
  ComposerTrigger,
  ComposerTriggerContext,
} from '../composer/Composer';
import { Mascot, dotLook } from '../Mascot';
import {
  filterMentionDots,
  mentionKey,
  mentionOptionId,
  mentionText,
  roleLine,
} from './mentions';
import './room.css';

export function MentionList({
  dots,
  active,
  listId,
  query,
  hostId,
  participantIds,
  onPick,
  onHover,
}: {
  dots: readonly Dot[];
  active: number;
  listId: string;
  query: string;
  hostId: string;
  participantIds: readonly string[];
  onPick(dot: Dot): void;
  onHover?(index: number): void;
}) {
  const status = (dot: Dot) =>
    dot.id === hostId
      ? 'Host'
      : participantIds.includes(dot.id)
        ? 'In this chat'
        : 'Asks to add';
  return (
    <div className="fd-mention">
      <div
        id={listId}
        role="listbox"
        aria-label="Dots to mention"
        className="fd-mention-list"
      >
        {dots.map((dot, index) => (
          <div
            key={dot.id}
            id={mentionOptionId(listId, dot.id)}
            role="option"
            aria-selected={index === active}
            className={`fd-mention-option${index === active ? ' active' : ''}`}
            // Keep the focus in the textarea so typing and the keyboard keep working.
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={() => {
              if (index !== active) onHover?.(index);
            }}
            onClick={() => onPick(dot)}
          >
            <Mascot
              identity={dot.id}
              {...dotLook(dot)}
              name={dot.name}
              small
              decorative
            />
            <span className="fd-mention-text">
              <span className="fd-mention-name">{dot.name}</span>
              <span className="fd-mention-role">
                {roleLine(dot.instructions)}
              </span>
            </span>
            <span className="fd-mention-status">{status(dot)}</span>
          </div>
        ))}
      </div>
      {!dots.length && (
        <p className="fd-mention-empty" role="status">
          No Dot is called “{query}”.
        </p>
      )}
    </div>
  );
}

/** The composer trigger for `@`: holds which option is highlighted for the token being typed. */
export function useMentionTrigger({
  dots,
  hostId,
  participantIds,
}: {
  dots: readonly Dot[];
  hostId: string;
  participantIds: readonly string[];
}): ComposerTrigger {
  // The highlight belongs to one query; typing more starts again at the top.
  const [highlight, setHighlight] = useState({ query: '', active: 0 });
  const listFor = (context: ComposerTriggerContext) =>
    filterMentionDots(dots, context.query);
  const activeFor = (context: ComposerTriggerContext, count: number) =>
    highlight.query === context.query && highlight.active < count
      ? highlight.active
      : 0;
  const pick = (context: ComposerTriggerContext, dot: Dot) => {
    context.replace(mentionText(dot));
    setHighlight({ query: '', active: 0 });
  };
  return {
    char: '@',
    render(context) {
      const list = listFor(context);
      return (
        <MentionList
          dots={list}
          active={activeFor(context, list.length)}
          listId={context.listId}
          query={context.query}
          hostId={hostId}
          participantIds={participantIds}
          onPick={(dot) => pick(context, dot)}
          onHover={(index) =>
            setHighlight({ query: context.query, active: index })
          }
        />
      );
    },
    onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>, context) {
      if (event.nativeEvent.isComposing) return false;
      const list = listFor(context);
      const result = mentionKey(event.key, {
        count: list.length,
        active: activeFor(context, list.length),
      });
      if (!result.handled) return false;
      event.preventDefault();
      if ('close' in result) context.close();
      else if ('choose' in result) pick(context, list[result.choose]);
      else setHighlight({ query: context.query, active: result.active });
      return true;
    },
    activeDescendant(context) {
      const list = listFor(context);
      const dot = list[activeFor(context, list.length)];
      return dot ? mentionOptionId(context.listId, dot.id) : undefined;
    },
  };
}
