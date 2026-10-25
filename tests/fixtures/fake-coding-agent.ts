import {
  agent,
  methods,
  PROTOCOL_VERSION,
  RequestError,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk';

export function fakeCodingAgent(
  options: {
    authAt?: 'new' | 'prompt';
    permission?: boolean;
    waitForCancel?: boolean;
    wrongPermissionSession?: boolean;
  } = {},
) {
  const state = {
    initialized: false,
    mode: '',
    cancelled: 0,
    prompted: false,
    outcome: undefined as RequestPermissionResponse | undefined,
  };
  let finish = () => {};
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const app = agent({ name: 'fake-coding-agent' })
    .onRequest(methods.agent.initialize, ({ params }) => {
      state.initialized = true;
      if (params.clientCapabilities?.terminal)
        throw new Error('Host terminal must never be offered.');
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {},
        agentInfo: { name: 'fixture', version: '1' },
      };
    })
    .onRequest(methods.agent.session.new, ({ params }) => {
      if (params.cwd !== '/workspace' || params.mcpServers.length)
        throw new Error('Unexpected session scope.');
      if (options.authAt === 'new') throw RequestError.authRequired();
      return {
        sessionId: 'fixture-session',
        modes: {
          currentModeId: 'default',
          availableModes: [{ id: 'default', name: 'Manual' }],
        },
      };
    })
    .onRequest(methods.agent.session.setMode, ({ params }) => {
      state.mode = params.modeId;
      return {};
    })
    .onRequest(methods.agent.session.prompt, async ({ client, signal }) => {
      state.prompted = true;
      if (options.authAt === 'prompt') throw RequestError.authRequired();
      await client.notify(methods.client.session.update, {
        sessionId: 'fixture-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Working on the change.\n' },
        },
      });
      if (options.permission)
        state.outcome = await client.request(
          methods.client.session.requestPermission,
          {
            sessionId: options.wrongPermissionSession
              ? 'another-session'
              : 'fixture-session',
            toolCall: {
              toolCallId: 'write-1',
              title: 'Write the requested file',
              rawInput: {
                command: 'write result.txt',
                apiKey: 'fixture-sensitive-value',
              },
              locations: [{ path: '/workspace/result.txt' }],
            },
            options: [
              { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
              {
                optionId: 'always',
                name: 'Always allow',
                kind: 'allow_always',
              },
              { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
            ],
          },
        );
      if (options.waitForCancel) {
        signal.addEventListener('abort', finish, { once: true });
        await waiting;
      }
      return { stopReason: state.cancelled ? 'cancelled' : 'end_turn' };
    })
    .onNotification(methods.agent.session.cancel, () => {
      state.cancelled++;
      finish();
    });
  return { app, state };
}
