// A team drawn with its Dots' own characters: a small overlapping stack for rows, and an orbit
// (the lead in the centre ring, members circling it) for the builder stage and the team page.
import type { CSSProperties, ReactNode } from 'react';
import { Crown } from 'lucide-react';
import type { Dot } from '../../shared/types';
import { Mascot, dotLook } from '../Mascot';
import { orbitAngles } from './builder-model';
import './teams.css';

const byId = (dots: Dot[], id: string) => dots.find((dot) => dot.id === id);

/** Lead first and a little larger, then up to `max - 1` members, then "+n". */
export function TeamStack({
  leadDotId,
  memberIds,
  dots,
  max = 4,
  working = false,
}: {
  leadDotId: string;
  memberIds: string[];
  dots: Dot[];
  max?: number;
  /** Someone on the team holds a turn: the faces look busy. */
  working?: boolean;
}) {
  const ids = [leadDotId, ...memberIds];
  const shown = ids.slice(0, max);
  const extra = ids.length - shown.length;
  return (
    <span className="team-stack" aria-hidden>
      {shown.map((id, index) => {
        const dot = byId(dots, id);
        return (
          <span
            key={id}
            className={`team-stack-face ${index === 0 ? 'lead' : ''}`}
            style={{ zIndex: shown.length - index } as CSSProperties}
          >
            <Mascot
              identity={id}
              {...dotLook(dot)}
              name={dot?.name ?? 'Dot'}
              small
              decorative
              state={
                dot?.paused
                  ? 'paused'
                  : working && index === 0
                    ? 'working'
                    : 'idle'
              }
            />
          </span>
        );
      })}
      {extra > 0 && <span className="team-stack-more">+{extra}</span>}
    </span>
  );
}

/**
 * The lead in the centre, members evenly around it in member order (the first at the top). The
 * ring turns slowly while each face stays upright and bobs; under reduced motion it stands still.
 */
export function TeamOrbit({
  leadDotId,
  memberIds,
  dots,
  size = 'md',
  label,
  renderMember,
  center,
  working,
}: {
  leadDotId: string | null;
  memberIds: string[];
  dots: Dot[];
  size?: 'sm' | 'md' | 'lg';
  /** Accessible name of the picture, e.g. "Launch crew: Lead with Scout and Writer". */
  label: string;
  /** Extra content under a member's face (the builder adds its name). */
  renderMember?: (dot: Dot | undefined, id: string, index: number) => ReactNode;
  /** Shown in the centre when there is no lead yet. */
  center?: ReactNode;
  working?: ReadonlySet<string>;
}) {
  const angles = orbitAngles(memberIds.length);
  const lead = leadDotId ? byId(dots, leadDotId) : undefined;
  return (
    <div
      className={`team-orbit team-orbit-${size}`}
      role="img"
      aria-label={label}
      style={{ '--orbit-count': memberIds.length } as CSSProperties}
    >
      <span className="team-orbit-track" aria-hidden />
      <div className="team-orbit-ring" aria-hidden>
        {memberIds.map((id, index) => {
          const dot = byId(dots, id);
          return (
            <span
              key={id}
              className="team-orbit-slot"
              style={{ '--angle': `${angles[index]}deg` } as CSSProperties}
            >
              <span className="team-orbit-upright">
                <span
                  className="team-orbit-face"
                  style={{ animationDelay: `${index * -0.45}s` }}
                >
                  <Mascot
                    identity={id}
                    {...dotLook(dot)}
                    name={dot?.name ?? 'Dot'}
                    small
                    decorative
                    state={
                      dot?.paused
                        ? 'paused'
                        : working?.has(id)
                          ? 'working'
                          : 'idle'
                    }
                  />
                </span>
                {renderMember?.(dot, id, index)}
              </span>
            </span>
          );
        })}
      </div>
      <div className="team-orbit-center" aria-hidden>
        {leadDotId ? (
          <>
            <span className="team-orbit-crown">
              <Crown size={12} strokeWidth={2.25} />
            </span>
            <Mascot
              identity={leadDotId}
              {...dotLook(lead)}
              name={lead?.name ?? 'Lead'}
              decorative
              state={
                lead?.paused
                  ? 'paused'
                  : working?.has(leadDotId)
                    ? 'working'
                    : 'idle'
              }
            />
            {renderMember?.(lead, leadDotId, -1)}
          </>
        ) : (
          center
        )}
      </div>
    </div>
  );
}
