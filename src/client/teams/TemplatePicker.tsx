// "Start from a template" in the team builder: a row of playful cards (the template's characters
// in their colours). Choosing one shows what it creates, a name and "Create a team space", and
// POST /api/teams/from-template makes the Dots and the team in one go.
import { useState } from 'react';
import {
  TEAM_TEMPLATES,
  freeName,
  templateDots,
  type TeamTemplate,
} from '../../shared/team-templates';
import {
  TEAM_NAME_MAX,
  TEAM_STYLE_LABELS,
  type Team,
} from '../../shared/teams';
import { api } from '../api';
import { Mascot, dotLook } from '../Mascot';
import { Switch } from './controls';

export function TemplatePicker({
  teams,
  onCreated,
  initial,
}: {
  teams: Pick<Team, 'name' | 'archivedAt'>[];
  onCreated: (team: Team) => void;
  /** The chosen template (tests). */
  initial?: string;
}) {
  const [chosen, setChosen] = useState<TeamTemplate | undefined>(() =>
    TEAM_TEMPLATES.find((template) => template.id === initial),
  );
  const [name, setName] = useState('');
  const [space, setSpace] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = teams.filter((team) => !team.archivedAt).map((t) => t.name);
  const choose = (template: TeamTemplate) => {
    setChosen(template.id === chosen?.id ? undefined : template);
    setName(freeName(template.name, active, TEAM_NAME_MAX));
    setError('');
  };
  const create = async () => {
    if (!chosen) return;
    setBusy(true);
    setError('');
    try {
      const made = await api<{ team: Team }>('/teams/from-template', 'POST', {
        templateId: chosen.id,
        ...(name.trim() ? { name: name.trim() } : {}),
        space,
      });
      onCreated(made.team);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the team.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="tb-templates" aria-labelledby="tb-templates-title">
      <header className="tb-section-head">
        <span className="tb-eyebrow">Quick start</span>
        <h3 id="tb-templates-title">Start from a template</h3>
        <p>Ready-made Dots and roles. You can change everything later.</p>
      </header>
      <ul className="tb-template-row">
        {TEAM_TEMPLATES.map((template) => (
          <li key={template.id}>
            <button
              type="button"
              className={`tb-template${chosen?.id === template.id ? ' chosen' : ''}`}
              aria-pressed={chosen?.id === template.id}
              onClick={() => choose(template)}
            >
              <span className="tb-template-cast" aria-hidden>
                {templateDots(template).map((dot) => (
                  <span key={dot.name} className="tb-template-face">
                    <Mascot
                      identity={`template-${template.id}-${dot.name}`}
                      {...dotLook(dot)}
                      name={dot.name}
                      small
                      decorative
                    />
                  </span>
                ))}
              </span>
              <strong>
                <span aria-hidden>{template.emoji}</span> {template.name}
              </strong>
              <small>{template.blurb}</small>
            </button>
          </li>
        ))}
      </ul>
      {chosen && (
        <div
          className="tb-template-panel"
          role="group"
          aria-label={chosen.name}
        >
          <p>
            Creates {templateDots(chosen).length} new Dots (
            {templateDots(chosen)
              .map((dot) => dot.name)
              .join(', ')}
            ) and the team: {TEAM_STYLE_LABELS[chosen.style].toLowerCase()}
            {chosen.reviewer ? `, ${chosen.reviewer.name} reviews` : ''}. They
            start careful: web research on, no computer, no connectors, and they
            ask before sensitive actions. You can change everything later.
          </p>
          <label className="tb-field">
            <span>Team name</span>
            <input
              className="dlg-input"
              value={name}
              maxLength={TEAM_NAME_MAX}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <Switch
            checked={space}
            onChange={setSpace}
            label="Create a team space"
            hint="A Space named after the team: its Dots can use it, team chats save pages there, and each run leaves a log page."
          />
          {error && (
            <p className="tb-invalid" role="alert">
              {error}
            </p>
          )}
          <div className="tb-template-actions">
            <button
              type="button"
              className="dlg-btn"
              onClick={() => setChosen(undefined)}
            >
              Not this one
            </button>
            <button
              type="button"
              className="dlg-btn dlg-primary"
              disabled={busy}
              onClick={() => void create()}
            >
              {busy ? 'Creating…' : `Create ${name.trim() || chosen.name}`}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
