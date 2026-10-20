// Ready-made teams: "Start from a template" in the team builder creates the Dots, the team, its
// style, mode and reviewer (and, when asked, its Space) in one go through
// POST /api/teams/from-template. Everything it creates is an ordinary Dot or team, editable after.
// The Dots start careful: web research on, note proposals off, approval mode "sensitive", no
// computer access and no connector grants.
import type { TeamMode, TeamStyle } from './teams.js';
import type { DotColor, DotGear, DotSpecies } from './types.js';

export interface TemplateDot {
  name: string;
  instructions: string;
  color: DotColor;
  species: DotSpecies;
  gear: DotGear;
}

export interface TemplateMember extends TemplateDot {
  /** Their role on the team, shown to the lead and in their briefs. */
  role: string;
}

export interface TeamTemplate {
  id: string;
  name: string;
  emoji: string;
  color: DotColor;
  description: string;
  /** One playful line for the template card. */
  blurb: string;
  style: TeamStyle;
  mode: TeamMode;
  lead: TemplateDot;
  members: TemplateMember[];
  /** Only for the review style: the Dot that checks the combined work. */
  reviewer?: TemplateDot;
}

export const TEAM_TEMPLATES: readonly TeamTemplate[] = [
  {
    id: 'launch',
    name: 'Launch crew',
    emoji: '🚀',
    color: 'coral',
    description:
      'Plans and ships a launch: the story, the words and the build.',
    blurb: 'Marketer, writer and engineer, all at once.',
    style: 'parallel',
    mode: 'lead',
    lead: {
      name: 'Launch Lead',
      color: 'coral',
      species: 'emperor',
      gear: 'none',
      instructions:
        'You lead a launch team. Turn the owner’s goal into clear briefs for the marketer, the writer and the engineer, then combine their work into one launch plan with owners and dates.',
    },
    members: [
      {
        name: 'Marketer',
        role: 'Positioning, audience and channels',
        color: 'amber',
        species: 'macaroni',
        gear: 'beanie',
        instructions:
          'You are a product marketer. Find the audience, the one-line promise and the channels that reach them. Be concrete: name channels, dates and the message per channel.',
      },
      {
        name: 'Writer',
        role: 'Announcement copy',
        color: 'lilac',
        species: 'chick',
        gear: 'scarf',
        instructions:
          'You are a launch writer. Write clear, warm announcement copy: a headline, a short post and a longer page. No hype words; show what changes for the reader.',
      },
      {
        name: 'Engineer',
        role: 'Release readiness',
        color: 'sky',
        species: 'rockhopper',
        gear: 'glasses',
        instructions:
          'You are a release engineer. List what must be true before shipping: checks, risks, rollback and monitoring. Short checklists over prose.',
      },
    ],
  },
  {
    id: 'research',
    name: 'Research desk',
    emoji: '🔬',
    color: 'mint',
    description:
      'Digs into a question from two sides, then a critic checks it.',
    blurb: 'Two researchers dig, a critic checks.',
    style: 'review',
    mode: 'lead',
    lead: {
      name: 'Research Lead',
      color: 'mint',
      species: 'emperor',
      gear: 'none',
      instructions:
        'You lead a research desk. Split the owner’s question into two angles for the researchers, then turn the reviewed findings into a clear answer with sources.',
    },
    members: [
      {
        name: 'Scout',
        role: 'Finds sources and facts',
        color: 'moss',
        species: 'adelie',
        gear: 'headphones',
        instructions:
          'You are a researcher who finds sources. Search the web, read the best sources and report facts with their source URLs. Say what you could not confirm.',
      },
      {
        name: 'Analyst',
        role: 'Weighs evidence and numbers',
        color: 'sky',
        species: 'rockhopper',
        gear: 'glasses',
        instructions:
          'You are a researcher who weighs evidence. Compare claims, check numbers and point out where sources disagree. Cite source URLs.',
      },
    ],
    reviewer: {
      name: 'Critic',
      color: 'rose',
      species: 'macaroni',
      gear: 'bow',
      instructions:
        'You are a careful critic. Check work for unsupported claims, gaps and errors, fix what you can, and say plainly what still needs work.',
    },
  },
  {
    id: 'content',
    name: 'Content studio',
    emoji: '✍️',
    color: 'lilac',
    description: 'Drafts a piece, then an editor polishes it.',
    blurb: 'Writer drafts, editor polishes, step by step.',
    style: 'sequential',
    mode: 'lead',
    lead: {
      name: 'Content Lead',
      color: 'lilac',
      species: 'emperor',
      gear: 'none',
      instructions:
        'You lead a content studio. Brief the writer on the piece the owner wants (audience, length, tone), then hand the editor’s final version back to the owner.',
    },
    members: [
      {
        name: 'Writer',
        role: 'Writes the first draft',
        color: 'amber',
        species: 'chick',
        gear: 'scarf',
        instructions:
          'You are a writer. Write a complete first draft that fits the brief’s audience, length and tone. Plain words, short paragraphs.',
      },
      {
        name: 'Editor',
        role: 'Edits and polishes',
        color: 'indigo',
        species: 'adelie',
        gear: 'glasses',
        instructions:
          'You are an editor. Tighten the draft you get, fix errors and unclear sentences, and keep the writer’s voice. Return the finished piece.',
      },
    ],
  },
  {
    id: 'support',
    name: 'Support desk',
    emoji: '💬',
    color: 'sky',
    description: 'Sorts a customer message and drafts a reply.',
    blurb: 'Triage sorts, responder replies.',
    style: 'parallel',
    mode: 'lead',
    lead: {
      name: 'Support Lead',
      color: 'sky',
      species: 'emperor',
      gear: 'none',
      instructions:
        'You lead a support desk. Share the customer’s message with triage and the responder, then give the owner the category, the urgency and a reply ready to send. Never send anything yourself.',
    },
    members: [
      {
        name: 'Triage',
        role: 'Sorts and sets urgency',
        color: 'amber',
        species: 'rockhopper',
        gear: 'headphones',
        instructions:
          'You triage support messages. Name the category, the urgency (low, normal, urgent) and what information is missing. One short paragraph.',
      },
      {
        name: 'Responder',
        role: 'Drafts the reply',
        color: 'mint',
        species: 'chick',
        gear: 'headphones',
        instructions:
          'You draft support replies. Write a kind, specific reply that solves the problem or asks for exactly what is missing. Do not promise refunds or dates.',
      },
    ],
  },
];

export const teamTemplate = (id: string): TeamTemplate | undefined =>
  TEAM_TEMPLATES.find((template) => template.id === id);

/** The Dots a template creates, in order: lead, members, reviewer. */
export const templateDots = (template: TeamTemplate): TemplateDot[] => [
  template.lead,
  ...template.members,
  ...(template.reviewer ? [template.reviewer] : []),
];

/**
 * `wanted`, or `wanted 2`, `wanted 3`, ... : the first that no name in `taken` uses (ignoring case
 * and surrounding spaces). Templates use it for Dot and team names.
 */
export function freeName(
  wanted: string,
  taken: Iterable<string>,
  max = 60,
): string {
  const used = new Set([...taken].map((name) => name.trim().toLowerCase()));
  const base = wanted.trim();
  if (!used.has(base.toLowerCase())) return base;
  for (let index = 2; ; index++) {
    const suffix = ` ${index}`;
    const name = `${base.slice(0, max - suffix.length)}${suffix}`;
    if (!used.has(name.toLowerCase())) return name;
  }
}
