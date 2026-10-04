import { pageRoutes } from './page-routes.js';
import { Hono } from 'hono';
import { z } from 'zod';
import { Platform } from './platform.js';
import { VoiceService } from './voice.js';
import { ThreadRunningError } from './sqlite-runner.js';
import {
  MAX_CONVERSATION_TITLE_LENGTH,
  deriveTitle,
  hasDefaultTitle,
} from '../shared/conversation-title.js';
import type { ConversationSummary } from '../shared/types.js';
import {
  learningContainerIdSchema,
  validateLearningSettings,
} from '../shared/learning.js';
const dotSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    instructions: z.string().trim().min(3).max(2000),
    researchAllowed: z.boolean(),
    memoryAllowed: z.boolean(),
    learningContainerId: learningContainerIdSchema.optional(),
    skillDeliveryEnabled: z.boolean().optional(),
    spaceIds: z.array(z.string().min(1)).min(1).max(100).optional(),
    spaceId: z.string().min(1).optional(),
    model: z
      .string()
      .trim()
      .max(200)
      .regex(/^[\w.:/@+-]*$/, 'Use a model identifier such as vendor/model.')
      .transform((value) => value || null)
      .nullable()
      .optional(),
  })
  .strict();
const conversationPatch = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(MAX_CONVERSATION_TITLE_LENGTH)
      .transform((title) => title.replace(/\s+/g, ' ')),
  })
  .strict();
function ownedConversation(platform: Platform, id: string) {
  try {
    return platform.workspace.requireThread(id);
  } catch {
    return undefined;
  }
}
/** Conversations plus the activity facts the sidebar needs to order and tidy them. */
async function conversationSummaries(
  platform: Platform,
): Promise<ConversationSummary[]> {
  const activity = new Map(
    platform.runner
      .listThreads()
      .map((thread) => [thread.id, Date.parse(thread.updatedAt)]),
  );
  const linked = platform.workspace.linkedThreadIds();
  return Promise.all(
    platform.workspace.conversations().map(async (conversation) => {
      const updatedAt = activity.get(conversation.id) ?? null;
      // A reply that is still streaming is not stored until it finishes.
      const empty =
        updatedAt === null &&
        !linked.has(conversation.id) &&
        !(await platform.runner.isRunning({ threadId: conversation.id }));
      return { ...conversation, updatedAt, empty };
    }),
  );
}
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part) =>
      part && typeof part === 'object' && typeof part.text === 'string'
        ? [part.text]
        : [],
    )
    .join('\n');
}
/**
 * Names a still-untitled conversation after the first message sent in it.
 * Done here, where every chat turn passes, so no client path can leave a
 * conversation with the placeholder title. Best effort: never blocks the turn.
 */
export async function titleFromFirstMessage(
  platform: Platform,
  request: Request,
) {
  try {
    if (
      request.method !== 'POST' ||
      !/\/agent\/[^/]+\/run$/.test(new URL(request.url).pathname)
    )
      return;
    const body = (await request.clone().json()) as {
      threadId?: unknown;
      messages?: unknown;
    };
    if (typeof body.threadId !== 'string' || !Array.isArray(body.messages))
      return;
    const thread = platform.workspace
      .conversations()
      .find((item) => item.id === body.threadId);
    if (!thread || !hasDefaultTitle(thread.title)) return;
    const first = body.messages.find((message) => message?.role === 'user');
    const title = deriveTitle(messageText(first?.content), '');
    if (title) platform.workspace.renameThread(thread.id, title);
  } catch {
    // The title is a convenience; the turn itself must still run.
  }
}
export function workspaceRoutes(platform: Platform, voice: VoiceService) {
  const app = new Hono();
  app.route('/', pageRoutes(platform));
  app.get('/workspace', async (c) =>
    c.json({
      spaces: platform.workspace.spaces(),
      dots: platform.workspace.dots(),
      conversations: await conversationSummaries(platform),
      setup: platform.setup(),
      calls: platform.workspace.calls(),
    }),
  );
  // Model identifiers offered by the configured OpenAI-compatible provider,
  // used as suggestions for per-Dot model selection. Cached for ten minutes.
  let models: { at: number; ids: string[] } | undefined;
  app.get('/models', async (c) => {
    const config = platform.config;
    if (!models || Date.now() - models.at > 600_000) {
      try {
        const response = await fetch(
          `${config.baseUrl.replace(/\/$/, '')}/models`,
          {
            headers: config.apiKey
              ? { Authorization: `Bearer ${config.apiKey}` }
              : {},
            signal: AbortSignal.timeout(10_000),
          },
        );
        const parsed = z
          .object({ data: z.array(z.object({ id: z.string() })) })
          .safeParse(response.ok ? await response.json() : null);
        models = {
          at: Date.now(),
          ids: parsed.success
            ? [...new Set(parsed.data.data.map((item) => item.id))].sort()
            : [],
        };
      } catch {
        models = { at: Date.now() - 540_000, ids: [] };
      }
    }
    return c.json({ default: config.model ?? null, models: models.ids });
  });
  app.post('/spaces', async (c) => {
    const data = z
      .object({
        name: z.string().trim().min(1).max(60),
        description: z.string().max(500).default(''),
      })
      .strict()
      .safeParse(await c.req.json());
    if (!data.success)
      return c.json(
        { error: 'Enter a Space name (up to 60 characters).' },
        400,
      );
    return c.json(
      platform.workspace.createSpace(data.data.name, data.data.description),
      201,
    );
  });
  app.post('/dots', async (c) => {
    const data = dotSchema
      .extend({ spaceId: z.string() })
      .safeParse(await c.req.json());
    if (!data.success)
      return c.json(
        {
          error:
            'Provide a name, role instructions, and explicit tool permissions.',
        },
        400,
      );
    try {
      validateLearningSettings(
        data.data.learningContainerId ?? null,
        data.data.skillDeliveryEnabled ?? false,
      );
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Invalid Learning settings.',
        },
        400,
      );
    }
    return c.json(
      platform.workspace.createDot(
        data.data.spaceId,
        data.data.name,
        data.data.instructions,
        data.data.researchAllowed,
        data.data.memoryAllowed,
        data.data.spaceIds,
        data.data.learningContainerId,
        data.data.skillDeliveryEnabled,
        data.data.model ?? null,
      ),
      201,
    );
  });
  app.put('/dots/:id', async (c) => {
    const data = dotSchema.safeParse(await c.req.json());
    if (!data.success)
      return c.json({ error: 'Invalid specialist settings.' }, 400);
    const current = platform.workspace.dot(c.req.param('id'));
    if (!current) return c.json({ error: 'Dot not found.' }, 404);
    try {
      validateLearningSettings(
        data.data.learningContainerId === undefined
          ? (current.learningContainerId ?? null)
          : data.data.learningContainerId,
        data.data.skillDeliveryEnabled ?? current.skillDeliveryEnabled ?? false,
      );
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Invalid Learning settings.',
        },
        400,
      );
    }
    return c.json(platform.workspace.updateDot(c.req.param('id'), data.data));
  });
  app.post('/conversations', async (c) => {
    const data = z
      .object({
        dotId: z.string(),
        title: z.string().trim().min(1).max(120).default('A new thought'),
      })
      .strict()
      .safeParse(await c.req.json());
    if (!data.success)
      return c.json({ error: 'Select a Dot and a conversation title.' }, 400);
    if (platform.setup().missing.length)
      return c.json(
        { error: `Setup required: ${platform.setup().missing.join(', ')}.` },
        503,
      );
    return c.json(
      await platform.createConversation(data.data.dotId, data.data.title),
      201,
    );
  });
  app.patch('/conversations/:id', async (c) => {
    const id = c.req.param('id');
    if (!ownedConversation(platform, id))
      return c.json({ error: 'Conversation not found.' }, 404);
    const data = conversationPatch.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!data.success)
      return c.json(
        {
          error: `Enter a title (1 to ${MAX_CONVERSATION_TITLE_LENGTH} characters).`,
        },
        400,
      );
    return c.json(platform.workspace.renameThread(id, data.data.title));
  });
  app.delete('/conversations/:id', (c) => {
    const id = c.req.param('id');
    if (!ownedConversation(platform, id))
      return c.json({ error: 'Conversation not found.' }, 404);
    if (platform.workspace.hasLiveCall(id))
      return c.json(
        { error: 'A call is in progress. End it before deleting.' },
        409,
      );
    try {
      // Chat history first: it refuses while a reply is streaming, and nothing
      // has been removed from the workspace database by then.
      platform.runner.deleteThread(id);
    } catch (error) {
      if (error instanceof ThreadRunningError)
        return c.json({ error: error.message }, 409);
      throw error;
    }
    platform.workspace.deleteThread(id);
    return c.json({ deleted: id });
  });
  app.get('/conversations/:id/capture', (c) =>
    c.json(platform.workspace.capture(c.req.param('id'))),
  );
  app.post('/voice/calls', async (c) => {
    const data = z
      .object({ threadId: z.string(), sdp: z.string().max(100000) })
      .strict()
      .safeParse(await c.req.json());
    if (!data.success)
      return c.json(
        { error: 'A conversation and audio SDP offer are required.' },
        400,
      );
    return c.json(
      await voice.begin(data.data.threadId, data.data.sdp, c.req.raw.signal),
      201,
    );
  });
  app.get('/voice/calls/:id', (c) =>
    c.json(platform.workspace.call(c.req.param('id'))),
  );
  app.post('/voice/calls/:id/active', (c) =>
    c.json(voice.activate(c.req.param('id'))),
  );
  app.post('/voice/calls/:id/compute', async (c) => {
    const data = z
      .object({
        toolCallId: z.string().min(1).max(200),
        request: z.string().trim().min(1).max(4000),
        transcript: z.string().max(12000).default(''),
      })
      .strict()
      .safeParse(await c.req.json());
    if (!data.success)
      return c.json(
        { error: 'A bounded compute request and tool call ID are required.' },
        400,
      );
    return c.json({
      text: await voice.compute(
        c.req.param('id'),
        data.data.toolCallId,
        `${data.data.request}\n\nUntrusted current-call transcript for context:\n${data.data.transcript}`,
      ),
    });
  });
  app.post('/voice/calls/:id/end', async (c) => {
    const data = z
      .object({
        transcript: z.string().max(20000),
        anchorMessageId: z.string().max(200).optional(),
      })
      .strict()
      .safeParse(await c.req.json());
    if (!data.success)
      return c.json(
        { error: 'Transcript exceeds the 20,000 character limit.' },
        400,
      );
    platform.workspace.anchorCall(c.req.param('id'), data.data.anchorMessageId);
    return c.json(await voice.end(c.req.param('id'), data.data.transcript));
  });
  app.all('/copilotkit/*', async (c) => {
    await titleFromFirstMessage(platform, c.req.raw);
    return platform.handle(c.req.raw);
  });
  app.onError((error, c) => {
    const text = error.message;
    const known =
      /^(Setup|Voice setup|Dot |Space |Specialist |Conversation |Call |This call|End the current|Voice provider|An audio)/.test(
        text,
      );
    return c.json(
      {
        error: known
          ? text
          : 'The service request failed. Check the server configuration and try again.',
      },
      503,
    );
  });
  return app;
}
