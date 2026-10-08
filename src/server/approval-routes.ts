import { Hono } from 'hono';
import { z } from 'zod';
import type { Handoff } from '../shared/types.js';
import type { ApprovalService } from './approval-service.js';
import type { ApprovalStore } from './approval-store.js';
import type { HandoffStore } from './handoff-store.js';

export interface ApprovalRoutesDeps {
  approvals: Pick<ApprovalService, 'decide'>;
  approvalStore: ApprovalStore;
  /** The HandoffService; typed structurally. Throws `Handoff not found.` / `Handoff is not waiting.` */
  handoffs: { dismiss(id: string): Promise<Handoff> };
  handoffStore: HandoffStore;
}

// Query values: an empty string counts as absent.
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (value === '' ? undefined : value),
    schema.optional(),
  );
const id = z.string().min(1).max(200);

const approvalQuery = z.object({
  status: optional(
    z.enum(['pending', 'approved', 'denied', 'consumed', 'expired']),
  ),
  threadId: optional(id),
  dotId: optional(id),
});
const handoffQuery = z.object({
  status: optional(z.enum(['waiting', 'done', 'dismissed'])),
  dotId: optional(id),
});
const decisionBody = z
  .object({
    decision: z.enum(['approve', 'deny']),
    note: z.string().max(1000).optional(),
  })
  .strict();

const invalidMessage = (error: z.ZodError) =>
  `Invalid request: ${error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ')}`.slice(0, 400);

export function approvalRoutes(deps: ApprovalRoutesDeps) {
  const { approvals, approvalStore, handoffs, handoffStore } = deps;
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof z.ZodError)
      return c.json({ error: invalidMessage(error) }, 400);
    return c.json(
      {
        error:
          'The approval request failed. Check the server configuration and try again.',
      },
      503,
    );
  });

  app.get('/approvals', (c) => {
    const query = approvalQuery.safeParse(c.req.query());
    if (!query.success)
      return c.json({ error: invalidMessage(query.error) }, 400);
    return c.json({ approvals: approvalStore.list(query.data) });
  });

  app.get('/approvals/:id', (c) => {
    const approval = approvalStore.get(c.req.param('id'));
    if (!approval) return c.json({ error: 'Approval not found.' }, 404);
    return c.json(approval);
  });

  app.post('/approvals/:id', async (c) => {
    const body = decisionBody.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!body.success)
      return c.json({ error: invalidMessage(body.error) }, 400);
    try {
      return c.json(
        approvals.decide(c.req.param('id'), body.data.decision, body.data.note),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message === 'Approval not found.')
        return c.json({ error: message }, 404);
      if (message === 'Approval is not pending.')
        return c.json({ error: message }, 409);
      throw error;
    }
  });

  app.get('/handoffs', (c) => {
    const query = handoffQuery.safeParse(c.req.query());
    if (!query.success)
      return c.json({ error: invalidMessage(query.error) }, 400);
    return c.json({ handoffs: handoffStore.list(query.data) });
  });

  app.post('/handoffs/:id/dismiss', async (c) => {
    try {
      return c.json(await handoffs.dismiss(c.req.param('id')));
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message === 'Handoff not found.')
        return c.json({ error: message }, 404);
      if (message === 'Handoff is not waiting.')
        return c.json({ error: message }, 409);
      throw error;
    }
  });

  return app;
}
