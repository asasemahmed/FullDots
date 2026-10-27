// P5 on the server: the reviewer style (after every member, one send-back at most, the lead gets
// the reviewed and the raw results, direct mode too), templates, the team home Space and its
// access, the run log, the team chat's default page destination, and the migration of P4 tables.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { pageAccess } from '../src/server/page-tools.js';
import { Platform } from '../src/server/platform.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import type { NewResumeMarker } from '../src/server/resume-store.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { TeamService } from '../src/server/team-service.js';
import { readVerdict, sentBackTo } from '../src/server/teams/review.js';
import { requestFor, runLogContent } from '../src/server/teams/run-log.js';
import {
  TeamRunService,
  type TeamRunDeps,
} from '../src/server/teams/team-runs.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { freeName, TEAM_TEMPLATES } from '../src/shared/team-templates.js';
import type { Team } from '../src/shared/teams.js';
import type { Delegation, Dot } from '../src/shared/types.js';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A lead, three members (Scout, Writer, Coder) and a reviewer (Critic) outside the team. */
function rig(options: { messages?: TeamRunDeps['messages'] } = {}) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  cleanups.push(() => {
    store.close();
    workspace.close();
  });
  const space = workspace.spaces()[0].id;
  const lead = workspace.dots()[0];
  const [scout, writer, coder, critic] = [
    'Scout',
    'Writer',
    'Coder',
    'Critic',
  ].map((name) =>
    workspace.createDot(space, name, `${name} role.`, true, true),
  ) as [Dot, Dot, Dot, Dot];
  const markers: NewResumeMarker[] = [];
  const team = new TeamService({
    workspace,
    store,
    resume: (marker) => markers.push(marker),
  });
  const runs = new TeamRunService({
    workspace,
    team,
    resume: (marker) => markers.push(marker),
    cancelTask: (taskId) => void store.action(taskId, 'cancel'),
    ...(options.messages ? { messages: options.messages } : {}),
    log: () => {},
  });
  team.setRunHook((delegation) => runs.stepFinished(delegation));
  const makeTeam = (
    input: Partial<Parameters<WorkspaceStore['teams']['create']>[0]> = {},
  ) =>
    workspace.teams.create({
      name: 'Research desk',
      emoji: '🔬',
      color: 'mint',
      leadDotId: lead.id,
      style: 'review',
      reviewerDotId: critic.id,
      members: [scout, writer, coder].map((dot) => ({
        dotId: dot.id,
        role: `${dot.name} things`,
      })),
      ...input,
    });
  const teamChat = (target: Team, id = 'team-chat') => {
    workspace.bindThread(id, target.leadDotId, 'A new thought');
    workspace.teams.bindThread(id, target.id);
    return id;
  };
  /** The running delegation of a Dot in this chat. */
  const running = (threadId: string, dotId: string) =>
    workspace.team
      .forParent(threadId)
      .find((item) => item.childDotId === dotId && item.status === 'running');
  return {
    store,
    workspace,
    team,
    runs,
    markers,
    lead,
    scout,
    writer,
    coder,
    critic,
    space,
    makeTeam,
    teamChat,
    running,
  };
}

describe('the reviewer', () => {
  it('starts only after every member has finished, with their combined results', () => {
    const f = rig();
    const team = f.makeTeam();
    const thread = f.teamChat(team);
    const run = f.runs.startFromBriefs(team, thread, {
      shared: 'Compare three note apps.',
    });
    const steps = f.workspace.teams.steps(run.id);
    expect(steps.map((step) => [step.dotId, step.role, step.status])).toEqual([
      [f.scout.id, 'worker', 'running'],
      [f.writer.id, 'worker', 'running'],
      [f.coder.id, 'worker', 'running'],
      [f.critic.id, 'reviewer', 'queued'],
    ]);
    expect(run.reviewerDotId).toBe(f.critic.id);
    f.team.completed(
      f.running(thread, f.scout.id)!.taskId,
      'Scout: Notion is big.',
    );
    f.team.completed(
      f.running(thread, f.writer.id)!.taskId,
      'Writer: a draft.',
    );
    // Two of three done: no reviewer yet, and the lead has heard nothing.
    expect(f.running(thread, f.critic.id)).toBeUndefined();
    f.team.failed(f.running(thread, f.coder.id)!.taskId, 'Model offline.');
    const review = f.running(thread, f.critic.id)!;
    expect(review).toBeDefined();
    const prompt = f.store.task(review.taskId)!.prompt;
    expect(prompt).toContain(
      'Check and improve the combined work of Scout, Writer',
    );
    expect(prompt).toContain('APPROVED or CHANGES');
    expect(prompt).toContain('Scout: Notion is big.');
    expect(prompt).toContain('Writer: a draft.');
    expect(prompt).not.toContain('Model offline.');
    expect(review.origin).toBe('team');
    expect(f.markers).toEqual([]);
    f.team.completed(
      review.taskId,
      'The combined comparison, improved.\n\nAPPROVED: solid and sourced.',
    );
    expect(f.workspace.teams.run(run.id)).toMatchObject({
      status: 'done',
      verdict: 'approved',
      sentBack: false,
    });
    expect(f.markers).toHaveLength(1);
    const back = f.markers[0]!.prompt;
    expect(back).toContain('# Reviewed result (Checked by Critic)');
    expect(back).toContain('The combined comparison, improved.');
    expect(back).toContain('# Raw results from the members');
    expect(back).toContain('Scout: Notion is big.');
    expect(back).toContain('could not finish');
  });

  it('sends the work back at most once, to the members it names, then the lead gets both', () => {
    const f = rig();
    const team = f.makeTeam();
    const thread = f.teamChat(team);
    const run = f.runs.startFromBriefs(team, thread, {
      shared: 'Compare three note apps.',
    });
    for (const dot of [f.scout, f.writer, f.coder])
      f.team.completed(f.running(thread, dot.id)!.taskId, `${dot.name} v1.`);
    const first = f.running(thread, f.critic.id)!;
    f.team.completed(
      first.taskId,
      'Draft.\n\n**CHANGES**: Writer must cite sources; the rest is fine.',
    );
    expect(f.workspace.teams.run(run.id)).toMatchObject({
      status: 'running',
      verdict: 'changes',
      sentBack: true,
    });
    // Only Writer was named: only Writer revises, with the notes and its first version.
    const revising = f.workspace.team
      .forParent(thread)
      .filter((item) => item.status === 'running');
    expect(revising.map((item) => item.childDotId)).toEqual([f.writer.id]);
    const revisionPrompt = f.store.task(revising[0]!.taskId)!.prompt;
    expect(revisionPrompt).toContain('Writer v1.');
    expect(revisionPrompt).toContain('Writer must cite sources');
    const writerStep = f.workspace.teams
      .steps(run.id)
      .find((step) => step.dotId === f.writer.id)!;
    expect(writerStep.firstDelegationId).toBeTruthy();
    expect(writerStep.delegationId).toBe(revising[0]!.id);
    expect(
      f.workspace.teams.steps(run.id).find((step) => step.role === 'reviewer')!
        .status,
    ).toBe('queued');
    f.team.completed(revising[0]!.taskId, 'Writer v2 with sources.');
    const second = f.running(thread, f.critic.id)!;
    expect(second.id).not.toBe(first.id);
    const secondPrompt = f.store.task(second.taskId)!.prompt;
    expect(secondPrompt).toContain('This is the last check');
    expect(secondPrompt).toContain('Writer v2 with sources.');
    // CHANGES again: nothing is sent back a second time; the run ends.
    f.team.completed(
      second.taskId,
      'Better.\n\nCHANGES: Scout could be shorter.',
    );
    expect(
      f.workspace.team
        .forParent(thread)
        .filter((item) => item.status === 'running'),
    ).toEqual([]);
    expect(f.workspace.teams.run(run.id)).toMatchObject({
      status: 'done',
      verdict: 'changes',
      sentBack: true,
    });
    expect(f.workspace.team.forParent(thread)).toHaveLength(6);
    expect(f.markers).toHaveLength(1);
    const back = f.markers[0]!.prompt;
    expect(back).toContain('Critic still asks for changes after one send-back');
    expect(back).toContain('Better.');
    expect(back).toContain('Writer v2 with sources.');
    expect(back).toContain('(revised after the review)');
    expect(back).toContain('Scout v1.');
    // A late report from the first round changes nothing.
    expect(f.runs.stepFinished(first)).toBe(true);
    expect(f.markers).toHaveLength(1);
  });

  it('sends back to every member when the notes name nobody, and skips a review of nothing', () => {
    expect(
      sentBackTo('CHANGES: tighten it all.', [
        { name: 'Scout' },
        { name: 'Writer' },
      ]),
    ).toHaveLength(2);
    expect(
      sentBackTo('CHANGES: Scoutish is not a name.', [
        { name: 'Scout' },
        { name: 'Writer' },
      ]),
    ).toHaveLength(2);
    expect(
      readVerdict('All good.\n\n> **Verdict: approved** – ship it'),
    ).toEqual({
      verdict: 'approved',
      notes: '> **Verdict: approved** – ship it',
    });
    expect(readVerdict('No verdict here.').verdict).toBe('unclear');
    const f = rig();
    const team = f.makeTeam({ members: [{ dotId: f.scout.id }] });
    const thread = f.teamChat(team);
    const run = f.runs.startFromBriefs(team, thread, { shared: 'Do it.' });
    f.team.failed(f.running(thread, f.scout.id)!.taskId, 'Offline.');
    expect(f.workspace.teams.steps(run.id).map((step) => step.status)).toEqual([
      'failed',
      'skipped',
    ]);
    expect(f.workspace.teams.run(run.id)?.status).toBe('failed');
    expect(f.markers).toHaveLength(1);
  });

  it('runs like all at once when the review team has no reviewer', () => {
    const f = rig();
    const team = f.makeTeam({ reviewerDotId: null });
    const thread = f.teamChat(team);
    const run = f.runs.startFromBriefs(team, thread, { shared: 'Do it.' });
    expect(f.workspace.teams.steps(run.id)).toHaveLength(3);
    expect(run.reviewerDotId).toBeNull();
  });

  it('a stopped member lets the review go on; Stop everything cancels the run', () => {
    const f = rig();
    const team = f.makeTeam();
    const thread = f.teamChat(team);
    const run = f.runs.startFromBriefs(team, thread, { shared: 'Do it.' });
    f.team.completed(f.running(thread, f.scout.id)!.taskId, 'Scout part.');
    f.team.completed(f.running(thread, f.writer.id)!.taskId, 'Writer part.');
    const coder = f.running(thread, f.coder.id)!;
    f.workspace.team.finish(coder.id, 'stopped', 'Stopped by you.');
    f.team.stopped(f.workspace.team.get(coder.id)!);
    expect(
      f.workspace.teams.steps(run.id).find((step) => step.dotId === f.coder.id)!
        .status,
    ).toBe('cancelled');
    expect(f.running(thread, f.critic.id)).toBeDefined();
    expect(f.runs.cancelThread(thread)).toBe(1);
    expect(f.workspace.teams.run(run.id)?.status).toBe('cancelled');
    expect(f.markers).toEqual([]);
  });
});

const config: PlatformConfig = {
  apiKey: 'fixture',
  model: 'custom-model',
  baseUrl: 'https://unused.invalid/v1',
  voiceName: 'marin',
};

function platformRig() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const platform = new Platform(store, workspace, config);
  const research = { mode: 'sample' as const, baseUrl: '' };
  cleanups.push(async () => {
    await platform.stop();
    store.close();
    workspace.close();
  });
  const app = createApp({
    store,
    runner: new Runner(store, research),
    config: research,
    platform,
  });
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const response = await app.request(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  const space = workspace.spaces()[0].id;
  const lead = workspace.dots()[0];
  const dots = ['Scout', 'Writer', 'Critic'].map((name) =>
    workspace.createDot(space, name, `${name} role.`, true, true),
  );
  return { store, workspace, platform, call, lead, dots, space };
}

/** Waits for a condition the server reaches on its own (a post, a resume). */
async function until(check: () => boolean) {
  for (let i = 0; i < 50 && !check(); i++) await flush();
  expect(check()).toBe(true);
}

describe('review in a direct team chat', () => {
  it('reviews before the Results message, which shows the check first, and logs the run', async () => {
    const p = platformRig();
    const [scout, writer, critic] = p.dots as [Dot, Dot, Dot];
    const created = await p.call('/teams', 'POST', {
      name: 'Desk',
      emoji: '🔬',
      color: 'mint',
      leadDotId: p.lead.id,
      mode: 'direct',
      style: 'review',
      reviewerDotId: critic.id,
      space: true,
      members: [{ dotId: scout.id }, { dotId: writer.id }],
    });
    expect(created.status).toBe(201);
    const teamId = String(created.body.id);
    const spaceId = String(created.body.spaceId);
    expect(spaceId).not.toBe('null');
    const chat = await p.call(`/teams/${teamId}/conversations`, 'POST', {});
    const threadId = String(chat.body.id);
    const sent = await p.call(`/teams/${teamId}/dispatch`, 'POST', {
      threadId,
      text: 'Which note app should I pick?',
    });
    expect(sent.status).toBe(201);
    const runId = String(sent.body.id);
    // The "Sent to ..." line carries the run, so the chat draws its band there.
    const messages = p.platform.runner.getThreadMessages(threadId);
    const line = messages.find((message) => message.role === 'assistant')!;
    expect(String(line.content)).toContain('Critic reviews their work');
    expect(
      line.role === 'assistant' && line.toolCalls?.[0]?.function.name,
    ).toBe('team_dispatch');
    const result = messages.find((message) => message.role === 'tool');
    expect(JSON.parse(String(result?.content))).toMatchObject({
      started: true,
      runId,
    });
    const work = (dotId: string) =>
      p.workspace.team
        .forParent(threadId)
        .find(
          (item) => item.childDotId === dotId && item.status === 'running',
        ) as Delegation | undefined;
    p.platform.team.completed(work(scout.id)!.taskId, 'Pick Obsidian.');
    p.platform.team.completed(work(writer.id)!.taskId, 'Pick Notion.');
    const review = work(critic.id)!;
    expect(review.origin).toBe('owner');
    p.platform.team.completed(
      review.taskId,
      'Obsidian for local notes, Notion for teams.\n\nAPPROVED: both are right for different needs.',
    );
    await until(
      () =>
        p.workspace.teams.run(runId)?.status === 'done' &&
        p.workspace.teams.run(runId)?.log !== null,
    );
    await until(() =>
      p.platform.runner
        .getThreadMessages(threadId)
        .some((message) =>
          String(message.content).startsWith('**Results from'),
        ),
    );
    const posted = p.platform.runner
      .getThreadMessages(threadId)
      .find((message) => String(message.content).startsWith('**Results from'))!;
    const text = String(posted.content);
    expect(text).toContain('2 of 2 done');
    expect(text.indexOf('Checked by Critic')).toBeLessThan(
      text.indexOf('Pick Obsidian.'),
    );
    expect(text).toContain('Obsidian for local notes');
    // The band data for the chat: both members, then the reviewer.
    const progress = await p.call(
      `/conversations/${threadId}/delegations/progress`,
    );
    const runs = progress.body.runs as {
      id: string;
      steps: { role: string }[];
    }[];
    expect(runs[0]!.id).toBe(runId);
    expect(runs[0]!.steps.map((step) => step.role)).toEqual([
      'worker',
      'worker',
      'reviewer',
    ]);
    // The run log is in the team's Space, with the request, every deliverable and the chats.
    const log = p.workspace.teams.run(runId)!.log!;
    expect(log.spaceId).toBe(spaceId);
    const page = p.workspace.pages.get(spaceId, log.pageId);
    expect(page.title).toMatch(/^Desk run — \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(page.content).toMatch(/started \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    expect(page.content).toContain('> Which note app should I pick?');
    expect(page.content).toContain('Pick Obsidian.');
    expect(page.content).toContain('Pick Notion.');
    expect(page.content).toContain('Checked by Critic: approved');
    expect(page.content).toContain(
      `[Open the team chat](/#/dots/${p.lead.id}/threads/${threadId})`,
    );
    const scoutChat = p.workspace.team
      .forParent(threadId)
      .find((item) => item.childDotId === scout.id)!.childThreadId;
    expect(page.content).toContain(`/#/dots/${scout.id}/threads/${scoutChat}`);
    // Nothing else was written anywhere: only the team's Space has pages.
    for (const space of p.workspace.spaces())
      expect(p.workspace.pages.list(space.id).length).toBe(
        space.id === spaceId ? 1 : 0,
      );
    // The team page lists the run with its log.
    const detail = await p.call(`/teams/${teamId}`);
    expect((detail.body.runs as { log: unknown }[])[0]!.log).toEqual(log);
  });
});

describe('templates', () => {
  it('creates careful Dots, the team, its reviewer and its Space; names never clash', async () => {
    const p = platformRig();
    const before = p.workspace.dots().length;
    const made = await p.call('/teams/from-template', 'POST', {
      templateId: 'research',
      space: true,
    });
    expect(made.status).toBe(201);
    const team = made.body.team as Team;
    const dots = made.body.dots as Dot[];
    const template = TEAM_TEMPLATES.find((item) => item.id === 'research')!;
    expect(dots.map((dot) => dot.name)).toEqual([
      'Research Lead',
      'Scout 2', // "Scout" was taken already
      'Analyst',
      'Critic 2',
    ]);
    expect(p.workspace.dots()).toHaveLength(before + 4);
    for (const dot of dots) {
      const stored = p.workspace.dot(dot.id)!;
      expect(stored).toMatchObject({
        researchAllowed: true,
        notesProposals: false,
        approvalMode: 'sensitive',
        paused: false,
      });
      expect(p.workspace.computers.permissions(dot.id)).toEqual({
        kind: 'browser',
        desktop: false,
        enabled: false,
        browser: false,
        files: false,
        shell: false,
      });
      expect(p.workspace.connectors.grants(dot.id)).toEqual([]);
      expect(stored.instructions).toBe(
        [template.lead, ...template.members, template.reviewer!].find((spec) =>
          dot.name.startsWith(spec.name),
        )!.instructions,
      );
    }
    expect(team).toMatchObject({
      name: 'Research desk',
      style: 'review',
      mode: 'lead',
      leadDotId: dots[0]!.id,
      reviewerDotId: dots[3]!.id,
      runLog: true,
    });
    expect(team.members.map((member) => member.role)).toEqual([
      'Finds sources and facts',
      'Weighs evidence and numbers',
    ]);
    expect(team.spaceId).toBeTruthy();
    const space = p.workspace
      .spaces()
      .find((item) => item.id === team.spaceId)!;
    expect(space.name).toBe('Research desk');
    for (const dot of dots)
      expect(p.workspace.canAccessSpace(dot.id, space.id)).toBe(true);
    // Again: every name gets the next free number, and no Space unless asked.
    const again = await p.call('/teams/from-template', 'POST', {
      templateId: 'research',
    });
    expect((again.body.team as Team).name).toBe('Research desk 2');
    expect((again.body.team as Team).spaceId).toBeNull();
    expect((again.body.dots as Dot[]).map((dot) => dot.name)).toEqual([
      'Research Lead 2',
      'Scout 3',
      'Analyst 2',
      'Critic 3',
    ]);
    // Named by the owner; unknown templates are refused.
    const named = await p.call('/teams/from-template', 'POST', {
      templateId: 'content',
      name: 'Blog studio',
    });
    expect(named.body.team as Team).toMatchObject({
      name: 'Blog studio',
      style: 'sequential',
      reviewerDotId: null,
    });
    expect(
      (await p.call('/teams/from-template', 'POST', { templateId: 'nope' }))
        .status,
    ).toBe(404);
    expect(freeName('Writer', ['writer', 'Writer 2'])).toBe('Writer 3');
  });

  it('every template is a valid team', () => {
    for (const template of TEAM_TEMPLATES) {
      expect(template.members.length).toBeGreaterThan(0);
      expect(!!template.reviewer).toBe(template.style === 'review');
    }
    expect(TEAM_TEMPLATES.map((template) => template.id)).toEqual([
      'launch',
      'research',
      'content',
      'support',
    ]);
  });
});

describe('team routes for the reviewer', () => {
  it('refuses a reviewer that is the lead or a member', async () => {
    const p = platformRig();
    const [scout, writer] = p.dots as [Dot, Dot];
    const base = {
      name: 'Desk',
      emoji: '🔬',
      color: 'mint',
      leadDotId: p.lead.id,
      style: 'review',
      members: [{ dotId: scout.id }],
    };
    expect(
      (await p.call('/teams', 'POST', { ...base, reviewerDotId: p.lead.id }))
        .body.error,
    ).toContain('lead cannot also review');
    expect(
      (await p.call('/teams', 'POST', { ...base, reviewerDotId: scout.id }))
        .body.error,
    ).toContain('cannot also be a member');
    const ok = await p.call('/teams', 'POST', {
      ...base,
      reviewerDotId: writer.id,
    });
    expect(ok.status).toBe(201);
    const moved = await p.call(`/teams/${ok.body.id}/members`, 'PUT', {
      members: [{ dotId: writer.id }],
    });
    expect(moved.status).toBe(400);
  });
});

describe('the team space', () => {
  it('follows membership and takes back only the access the team gave', async () => {
    const p = platformRig();
    const [scout, writer, critic] = p.dots as [Dot, Dot, Dot];
    const home = p.workspace.createSpace('Shared notes', '');
    // Writer had access by hand before the team existed.
    const writerDot = p.workspace.dot(writer.id)!;
    p.workspace.updateDot(writer.id, {
      ...writerDot,
      spaceIds: [...writerDot.spaceIds, home.id],
    });
    const team = p.workspace.teams.create({
      name: 'Desk',
      emoji: '🔬',
      color: 'mint',
      leadDotId: p.lead.id,
      members: [{ dotId: scout.id }, { dotId: writer.id }],
    });
    p.workspace.teams.setSpace(team.id, home.id);
    const can = (dotId: string) => p.workspace.canAccessSpace(dotId, home.id);
    expect([p.lead.id, scout.id, writer.id].map(can)).toEqual([
      true,
      true,
      true,
    ]);
    expect(can(critic.id)).toBe(false);
    expect(
      p.workspace.teams.spaces
        .granted(team.id)
        .map((grant) => grant.dotId)
        .sort(),
    ).toEqual([p.lead.id, scout.id].sort());
    // Critic joins (through the route), Scout and Writer leave.
    const patched = await p.call(`/teams/${team.id}`, 'PATCH', {
      members: [{ dotId: critic.id }],
    });
    expect(patched.status).toBe(200);
    expect(can(critic.id)).toBe(true);
    expect(can(scout.id)).toBe(false);
    // Writer's own access stays: the team never gave it.
    expect(can(writer.id)).toBe(true);
    // The owner takes Critic's access away by hand: a later sync does not give it back.
    const criticDot = p.workspace.dot(critic.id)!;
    p.workspace.updateDot(critic.id, {
      ...criticDot,
      spaceIds: criticDot.spaceIds.filter((id) => id !== home.id),
    });
    p.workspace.teams.syncSpace(team.id);
    expect(can(critic.id)).toBe(false);
    // A reviewer gets access too.
    p.workspace.teams.update(team.id, {
      style: 'review',
      reviewerDotId: scout.id,
    });
    expect(can(scout.id)).toBe(true);
  });

  it('is where team chats save pages by default', async () => {
    const p = platformRig();
    const [scout] = p.dots as [Dot];
    const created = await p.call('/teams', 'POST', {
      name: 'Desk',
      emoji: '🔬',
      color: 'mint',
      leadDotId: p.lead.id,
      members: [{ dotId: scout.id }],
    });
    const teamId = String(created.body.id);
    expect(created.body.spaceId).toBeNull();
    const chat = await p.call(`/teams/${teamId}/conversations`, 'POST', {});
    const threadId = String(chat.body.id);
    expect(
      pageAccess(p.workspace, p.lead.spaceId, threadId, () => {}).destination,
    ).toBe(p.lead.spaceId);
    const space = await p.call(`/teams/${teamId}/space`, 'POST', {});
    expect(space.status).toBe(201);
    const spaceId = String(space.body.spaceId);
    const access = pageAccess(p.workspace, p.lead.spaceId, threadId, () => {});
    expect(access.destination).toBe(spaceId);
    const page = access.create({ title: 'Plan', content: 'Steps.' });
    expect(page.spaceId).toBe(spaceId);
    // Asking again keeps the one Space.
    const again = await p.call(`/teams/${teamId}/space`, 'POST', {});
    expect(again.body.spaceId).toBe(spaceId);
    // An ordinary chat of the lead still saves to its own default.
    p.workspace.bindThread('plain', p.lead.id, 'Plain');
    expect(
      pageAccess(p.workspace, p.lead.spaceId, 'plain', () => {}).destination,
    ).toBe(p.lead.spaceId);
  });
});

describe('the run log', () => {
  it('is written once into the team space only, with the request and links', () => {
    const f = rig({
      messages: () => [
        { id: 'u1', role: 'user', content: 'Compare note apps for me.' },
        {
          id: 'a1',
          role: 'assistant',
          content: 'On it.',
          toolCalls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'start_team_run', arguments: '{}' },
            },
          ],
        },
        // The tool result names the run; filled in below once the run id is known.
        {
          id: 't1',
          role: 'tool',
          toolCallId: 'call-1',
          content: runIdHolder.value,
        },
      ],
    });
    const runIdHolder = { value: '' };
    const home = f.workspace.createSpace('Desk', '');
    const team = f.makeTeam({ style: 'parallel', reviewerDotId: null });
    f.workspace.teams.setSpace(team.id, home.id);
    const thread = f.teamChat(team);
    const run = f.runs.startFromBriefs(team, thread, { shared: 'Compare.' });
    runIdHolder.value = JSON.stringify({ started: true, runId: run.id });
    for (const dot of [f.scout, f.writer, f.coder])
      f.team.completed(
        f.running(thread, dot.id)!.taskId,
        `${dot.name} found things.`,
      );
    const stored = f.workspace.teams.run(run.id)!;
    expect(stored.log?.spaceId).toBe(home.id);
    const page = f.workspace.pages.get(home.id, stored.log!.pageId);
    expect(page.content).toContain('> Compare note apps for me.');
    expect(page.content).toContain('### Scout — Scout things');
    expect(page.content).toContain('Coder found things.');
    expect(page.content).toContain(`/#/dots/${f.lead.id}/threads/${thread}`);
    expect(page.sourceThreadId).toBe(thread);
    expect(f.workspace.pages.list(f.space)).toEqual([]);
    expect(f.workspace.pages.list(home.id)).toHaveLength(1);
  });

  it('is not written without a team space, or with the run log off', () => {
    const f = rig();
    const team = f.makeTeam({ style: 'parallel', reviewerDotId: null });
    const thread = f.teamChat(team);
    const run = f.runs.startFromBriefs(team, thread, { shared: 'Go.' });
    for (const dot of [f.scout, f.writer, f.coder])
      f.team.completed(f.running(thread, dot.id)!.taskId, 'Done.');
    expect(f.workspace.teams.run(run.id)?.log).toBeNull();
    const home = f.workspace.createSpace('Desk', '');
    f.workspace.teams.setSpace(team.id, home.id);
    f.workspace.teams.update(team.id, { runLog: false });
    const second = f.runs.startFromBriefs(team, thread, { shared: 'Again.' });
    for (const dot of [f.scout, f.writer, f.coder])
      f.team.completed(f.running(thread, dot.id)!.taskId, 'Done.');
    expect(f.workspace.teams.run(second.id)?.status).toBe('done');
    expect(f.workspace.teams.run(second.id)?.log).toBeNull();
    expect(f.workspace.pages.list(home.id)).toEqual([]);
  });

  it('builds its Markdown from the steps and finds the request', () => {
    const content = runLogContent({
      team: { name: 'Desk', emoji: '🔬' },
      run: {
        threadId: 'chat',
        style: 'review',
        mode: 'lead',
        status: 'done',
        createdAt: 0,
        finishedAt: 120_000,
        verdict: 'approved',
        sentBack: true,
      },
      hostDotId: 'lead',
      request: 'Pick one.',
      workers: [
        {
          name: 'Scout',
          dotId: 'scout',
          role: 'Finds',
          status: 'done',
          result: 'Obsidian.',
          childThreadId: 'c2',
          firstChildThreadId: 'c1',
        },
      ],
      reviewer: {
        name: 'Critic',
        dotId: 'critic',
        role: '',
        status: 'done',
        result: 'Obsidian it is.\n\nAPPROVED.',
        childThreadId: 'c3',
        firstChildThreadId: null,
      },
    });
    expect(content).toContain(
      'Checked by Critic: approved, after one send-back.',
    );
    expect(content).toContain('[first version](/#/dots/scout/threads/c1)');
    expect(content).toContain('[Open Scout’s chat](/#/dots/scout/threads/c2)');
    expect(content).toContain('2 min');
    expect(
      requestFor(
        [
          { id: 'u0', role: 'user', content: 'Earlier.' },
          { id: 'u1', role: 'user', content: 'The real ask.' },
          {
            id: 'e',
            role: 'user',
            content: 'Approved.',
            metadata: { source: 'approval' },
          } as never,
          {
            id: 'a',
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'c',
                type: 'function',
                function: { name: 'start_team_run', arguments: '{}' },
              },
            ],
          },
          {
            id: 't',
            role: 'tool',
            toolCallId: 'c',
            content: '{"runId":"run-9"}',
          },
        ],
        'run-9',
      ),
    ).toBe('The real ask.');
  });
});

describe('migrations', () => {
  it('opens P4 team tables and keeps every row with P5 defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fulldots-p5-'));
    cleanups.push(() =>
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 }),
    );
    const path = join(dir, 'p4.sqlite');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE teams(id TEXT PRIMARY KEY, name TEXT NOT NULL, emoji TEXT NOT NULL,
      color TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', leadDotId TEXT NOT NULL, style TEXT NOT NULL,
      mode TEXT NOT NULL, summarize INTEGER NOT NULL DEFAULT 0, reviewerDotId TEXT, spaceId TEXT,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, archivedAt INTEGER);
      CREATE TABLE team_runs(id TEXT PRIMARY KEY, teamId TEXT NOT NULL, threadId TEXT NOT NULL,
      style TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL,
      finishedAt INTEGER, cancelledAt INTEGER, postedAt INTEGER);
      CREATE TABLE team_run_steps(runId TEXT NOT NULL, delegationId TEXT, dotId TEXT NOT NULL,
      position INTEGER NOT NULL, status TEXT NOT NULL, brief TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(runId, dotId));
      INSERT INTO teams VALUES ('t1', 'Crew', '🐝', 'amber', '', 'lead', 'review', 'lead', 0, NULL, NULL, 1, 1, NULL);
      INSERT INTO team_runs VALUES ('r1', 't1', 'chat', 'review', 'lead', 'done', 1, 2, NULL, NULL);
      INSERT INTO team_run_steps VALUES ('r1', 'd1', 'scout', 0, 'done', 'Dig.');`);
    old.close();
    const workspace = new WorkspaceStore(path, 'owner');
    cleanups.push(() => workspace.close());
    expect(workspace.teams.get('t1')).toMatchObject({
      name: 'Crew',
      runLog: true,
    });
    expect(workspace.teams.run('r1')).toMatchObject({
      status: 'done',
      reviewerDotId: null,
      verdict: null,
      sentBack: false,
      log: null,
    });
    expect(workspace.teams.steps('r1')).toEqual([
      {
        runId: 'r1',
        delegationId: 'd1',
        dotId: 'scout',
        position: 0,
        status: 'done',
        role: 'worker',
        firstDelegationId: null,
        brief: 'Dig.',
      },
    ]);
  });
});
