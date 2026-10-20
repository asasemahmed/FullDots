// Attribution in a group chat: a Dot's reply carries its character, name and colour accent, and an
// owner message shows which Dot it was addressed to.
import type { CSSProperties, ReactNode } from 'react';
import type { Dot } from '../../shared/types';
import { Mascot, dotPalette, dotLook } from '../Mascot';
import './room.css';

type Author = Pick<Dot, 'id' | 'name' | 'color'>;

export function AuthoredBubble({
  author,
  children,
}: {
  author: Author;
  children: ReactNode;
}) {
  const palette = dotPalette(author);
  return (
    <div
      className="fd-authored"
      data-author={author.id}
      style={
        {
          '--fd-author': palette.base,
          '--fd-author-light': palette.light,
        } as CSSProperties
      }
    >
      <div className="fd-authored-head">
        <Mascot
          identity={author.id}
          {...dotLook(author)}
          name={author.name}
          small
          decorative
        />
        <span className="fd-authored-name">{author.name}</span>
      </div>
      {children}
    </div>
  );
}

/** "To Writer" above an owner message addressed with @Writer; "Also to Writer" for the repeat. */
export function AddressedLine({
  to,
  repeat = false,
}: {
  to: Author;
  repeat?: boolean;
}) {
  const palette = dotPalette(to);
  return (
    <div
      className={`fd-addressed${repeat ? ' fd-addressed--repeat' : ''}`}
      style={{ '--fd-author': palette.base } as CSSProperties}
    >
      <Mascot
        identity={to.id}
        {...dotLook(to)}
        name={to.name}
        small
        decorative
      />
      <span>
        {repeat ? 'Also to' : 'To'} {to.name}
      </span>
    </div>
  );
}
