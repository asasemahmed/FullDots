// "Start from a template": creates a template's Dots, the team (style, mode, reviewer) and, when
// asked, its home Space. Names never clash: a taken one gets " 2", " 3", ... The Dots start careful:
// web research on, note proposals off, approval mode "sensitive", no computer access (no
// computer_permissions row) and no connector grants. Everything created is ordinary and editable.
import {
  freeName,
  templateDots,
  type TeamTemplate,
} from '../../shared/team-templates.js';
import { TEAM_NAME_MAX, type Team } from '../../shared/teams.js';
import type { Dot } from '../../shared/types.js';
import type { WorkspaceStore } from '../workspace.js';

export function createFromTemplate(
  workspace: WorkspaceStore,
  template: TeamTemplate,
  options: { name?: string; space?: boolean } = {},
): { team: Team; dots: Dot[] } {
  const home = workspace.spaces()[0];
  if (!home) throw new Error('Create a Space first.');
  const taken = workspace.dots().map((dot) => dot.name);
  const made = new Map<string, Dot>();
  for (const spec of templateDots(template)) {
    const name = freeName(spec.name, taken);
    taken.push(name);
    made.set(
      spec.name,
      workspace.createDot(
        home.id,
        name,
        spec.instructions,
        true,
        true,
        [home.id],
        null,
        'sensitive',
        null,
        { color: spec.color, species: spec.species, gear: spec.gear },
      ),
    );
  }
  const teamName = freeName(
    options.name?.trim() || template.name,
    workspace.teams.list().map((team) => team.name),
    TEAM_NAME_MAX,
  );
  let team = workspace.teams.create({
    name: teamName,
    emoji: template.emoji,
    color: template.color,
    description: template.description,
    leadDotId: made.get(template.lead.name)!.id,
    style: template.style,
    mode: template.mode,
    reviewerDotId: template.reviewer
      ? made.get(template.reviewer.name)!.id
      : null,
    members: template.members.map((member) => ({
      dotId: made.get(member.name)!.id,
      role: member.role,
    })),
  });
  if (options.space) team = createTeamSpace(workspace, team);
  return { team, dots: [...made.values()] };
}

/** Gives a team its home Space (named after it), unless it has one; its Dots get access. */
export function createTeamSpace(workspace: WorkspaceStore, team: Team): Team {
  if (
    team.spaceId &&
    workspace.spaces().some((space) => space.id === team.spaceId)
  )
    return team;
  const space = workspace.createSpace(
    freeName(
      team.name,
      workspace.spaces().map((item) => item.name),
    ),
    `Home of the ${team.emoji} ${team.name} team: its pages and run logs.`,
  );
  return workspace.teams.setSpace(team.id, space.id) ?? team;
}
