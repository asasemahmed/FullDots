import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({
  api: vi.fn(),
  authHeaders: () => ({ Authorization: 'Bearer owner-token' }),
}));
import {
  ModelProviderGallery,
  ModelProviderRequestError,
  defaultModelLabel,
  filterPresets,
  filterProviders,
  hostPath,
  presetCaption,
  providerRequest,
  providerStatus,
  providerSubtitle,
} from '../src/client/ModelProviderGallery';
import {
  ModelProviderPage,
  baseUrlProblem,
  createBody,
  draftFor,
  draftProblems,
  envNameProblem,
  keyHintWarning,
  keyValueProblem,
  matchModels,
  patchBody,
  problemList,
  suggestEnvName,
  testSummary,
  usedByMessage,
} from '../src/client/ModelProviderPage';
import {
  GROUP_LIMIT,
  ModelPicker,
  choiceLabel,
  formatContext,
  modelFields,
  modelIdProblem,
  pickerGroups,
  pickerOptions,
  type ModelsData,
  type PickerProvider,
} from '../src/client/ModelPicker';
import { ModelProvidersSettings } from '../src/client/ModelProvidersSettings';
import { ModelLogo, modelMark } from '../src/client/model-logos';
import { WorkspaceDialog } from '../src/client/WorkspaceDialog';
import {
  modelPreset,
  modelPresets,
  type ModelPreset,
  type ModelProviderView,
} from '../src/shared/model-presets';
import type { Dot, State, WorkspaceState } from '../src/shared/types';

const SECRET = 'gsk_PLANTEDSECRETKEY1234567890abcdefwxyz';

const preset = (id: string): ModelPreset => modelPreset(id)!;

function provider(
  id: string,
  presetId: ModelProviderView['presetId'],
  extra: Partial<ModelProviderView> = {},
): ModelProviderView {
  return {
    id,
    presetId,
    name: modelPreset(presetId)!.name,
    baseUrl: modelPreset(presetId)!.baseUrl ?? 'https://llm.example.com/v1',
    key: { kind: 'stored', set: true, last4: 'wxyz' },
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    lastTestedAt: 1000,
    lastError: null,
    builtIn: false,
    ...extra,
  };
}

const envProvider = provider('env', 'openrouter', {
  name: 'Default (from .env)',
  key: { kind: 'env', set: true, envName: 'OPENAI_API_KEY' },
  builtIn: true,
  lastTestedAt: null,
});
const groq = provider('p-groq', 'groq');
const ollama = provider('p-ollama', 'ollama', {
  key: { kind: 'none', set: false },
  baseUrl: 'http://localhost:11434/v1',
});

const noop = () => {};

describe('provider status', () => {
  const view = (extra: Partial<ModelProviderView>) => ({ ...groq, ...extra });

  it('says Ready with the model count, or without it until known', () => {
    expect(providerStatus(groq, preset('groq'), 42)).toMatchObject({
      tone: 'ok',
      label: 'Ready · 42 models',
    });
    expect(providerStatus(groq, preset('groq'), 1).label).toBe(
      'Ready · 1 model',
    );
    expect(providerStatus(groq, preset('groq')).label).toBe('Ready');
    expect(
      providerStatus(view({ lastTestedAt: null }), preset('groq')).label,
    ).toBe('Not tested yet');
    expect(providerStatus(envProvider, preset('openrouter')).label).toBe(
      'Ready',
    );
  });

  it('flags a missing key, with where to fix it', () => {
    const stored = providerStatus(
      view({ key: { kind: 'stored', set: false } }),
      preset('groq'),
    );
    expect(stored).toMatchObject({ tone: 'warn', label: 'Key missing' });
    expect(stored.detail).toContain('Paste it again');
    const env = providerStatus(
      view({ key: { kind: 'env', set: false, envName: 'GROQ_API_KEY' } }),
      preset('groq'),
    );
    expect(env.label).toBe('Key missing');
    expect(env.detail).toContain('GROQ_API_KEY');
  });

  it('shows errors, and "Not running" for a local program that did not answer', () => {
    expect(
      providerStatus(view({ lastError: '401 Unauthorized' }), preset('groq')),
    ).toEqual({ tone: 'bad', label: 'Error', detail: '401 Unauthorized' });
    const local = providerStatus(
      { ...ollama, lastError: 'connect ECONNREFUSED' },
      preset('ollama'),
    );
    expect(local).toMatchObject({ tone: 'warn', label: 'Not running' });
    expect(local.detail).toContain('Ollama');
  });

  it('puts Disabled before every other state', () => {
    expect(
      providerStatus(
        view({
          enabled: false,
          lastError: 'boom',
          key: { kind: 'stored', set: false },
        }),
        preset('groq'),
      ),
    ).toEqual({ tone: 'neutral', label: 'Disabled' });
  });

  it('needs no key for a provider whose key kind is none', () => {
    expect(providerStatus(ollama, preset('ollama'), 3).label).toBe(
      'Ready · 3 models',
    );
  });
});

describe('names, captions and filters', () => {
  it('writes the address without its scheme and drops a repeated name', () => {
    expect(hostPath('https://api.groq.com/openai/v1/')).toBe(
      'api.groq.com/openai/v1',
    );
    expect(providerSubtitle(groq, preset('groq'))).toBe(
      'api.groq.com/openai/v1',
    );
    expect(
      providerSubtitle({ ...groq, name: 'Work Groq' }, preset('groq')),
    ).toBe('Groq · api.groq.com/openai/v1');
  });

  it('captions presets by how they run', () => {
    expect(presetCaption(preset('groq')).label).toBe('API key');
    expect(presetCaption(preset('ollama')).label).toBe('Runs on this computer');
    expect(presetCaption(preset('lmstudio')).label).toBe(
      'Runs on this computer',
    );
    expect(presetCaption(preset('custom')).label).toBe('Any compatible server');
  });

  it('filters providers and presets by name, address and description', () => {
    const all = [envProvider, groq, ollama];
    expect(filterProviders(all, modelPresets, '').length).toBe(3);
    expect(filterProviders(all, modelPresets, 'GROQ').map((v) => v.id)).toEqual(
      ['p-groq'],
    );
    expect(
      filterProviders(all, modelPresets, '11434').map((v) => v.id),
    ).toEqual(['p-ollama']);
    expect(filterPresets(modelPresets, 'fast').map((p) => p.id)).toContain(
      'groq',
    );
    expect(filterPresets(modelPresets, 'zzz')).toEqual([]);
  });

  it('labels the default model with its provider', () => {
    expect(
      defaultModelLabel({ providerId: 'p-groq', model: 'llama-3.3' }, [groq]),
    ).toBe('Groq · llama-3.3');
    expect(defaultModelLabel(null, [groq])).toBe('');
  });
});

describe('model logos', () => {
  it('has a mark for every preset, and a generic one for the unknown', () => {
    for (const item of modelPresets) {
      const html = renderToStaticMarkup(
        <ModelLogo presetId={item.id} size={56} />,
      );
      expect(html).toContain(`data-preset="${item.id}"`);
      expect(html).toContain('width:56px');
    }
    expect(modelMark('anthropic').kind).toBe('brand');
    expect(modelMark('groq').kind).toBe('glyph');
    expect(modelMark('nope')).toBe(modelMark('custom'));
    expect(renderToStaticMarkup(<ModelLogo size={20} />)).toContain(
      'data-preset="custom"',
    );
  });
});

describe('Models gallery', () => {
  const render = (
    props: Partial<Parameters<typeof ModelProviderGallery>[0]> = {},
  ) =>
    renderToStaticMarkup(
      <ModelProviderGallery
        providers={[envProvider, groq, ollama]}
        presets={modelPresets}
        defaultModel={{ providerId: 'env', model: 'deepseek/deepseek-v4' }}
        counts={{ 'p-groq': 42 }}
        onOpenProvider={noop}
        onOpenPreset={noop}
        onChangeDefault={noop}
        {...props}
      />,
    );

  it('introduces the tab and shows the default model with a Change button', () => {
    const html = render();
    expect(html).toContain('>Models</h3>');
    expect(html).toContain(
      'Bring your own keys. Keys are encrypted on this computer and never shown again.',
    );
    expect(html).toContain('Default model');
    expect(html).toContain('Default (from .env) · deepseek/deepseek-v4');
    expect(html).toContain('>Change</button>');
    expect(html).toContain('Search providers');
  });

  it('lists your providers with a status pill each', () => {
    const html = render({
      providers: [
        envProvider,
        groq,
        { ...ollama, lastError: 'connect ECONNREFUSED' },
        provider('p-gem', 'gemini', {
          key: { kind: 'stored', set: false },
        }),
        provider('p-mis', 'mistral', { lastError: '401 Unauthorized' }),
        provider('p-xai', 'xai', { enabled: false }),
      ],
    });
    expect(html).toContain('Your providers');
    expect(html).toContain('Ready · 42 models');
    expect(html).toContain('Key missing');
    expect(html).toContain('Not running');
    expect(html).toContain('>Error<');
    expect(html).toContain('401 Unauthorized');
    expect(html).toContain('>Disabled<');
    expect(html).toContain('cn-pill-ok');
    expect(html).toContain('cn-pill-warn');
    expect(html).toContain('cn-pill-bad');
    expect(html).toContain('cn-pill-neutral');
  });

  it('marks the .env provider "From .env" and the default provider "Default"', () => {
    const html = render();
    expect(html.match(/From \.env/g)).toHaveLength(1);
    expect(html).toContain('mp-badge-default');
    // The .env card's name is its button, and it is the default.
    expect(html).toMatch(/data-provider="env"[\s\S]*?Default \(from \.env\)/);
  });

  it('offers every preset once, with the right caption and a logo', () => {
    const html = render();
    expect(html).toContain('Add a provider');
    for (const item of modelPresets) {
      expect(html).toContain(`data-preset="${item.id}"`);
      expect(html).toContain(item.description);
    }
    expect(html.match(/class="cg-card cg-card-preset"/g)?.length).toBe(
      modelPresets.length,
    );
    expect(html.match(/API key</g)?.length).toBe(
      modelPresets.filter((p) => !p.local && p.id !== 'custom').length,
    );
    expect(html.match(/Runs on this computer</g)).toHaveLength(2);
    expect(html.match(/Any compatible server</g)).toHaveLength(1);
    // The Groq preset says one is added; the .env provider does not count.
    expect(html).toContain('1 added');
    expect(html).toContain('OpenRouter');
    expect(html).toContain('perplexity/');
  });

  it('invites the first provider when there are none', () => {
    const html = render({ providers: [], defaultModel: null });
    expect(html).toContain('No providers yet.');
    expect(html).toContain('None yet.');
    expect(html).not.toContain('>Change</button>');
    expect(html).not.toContain('Your providers');
  });

  it('shows a failed attempt to change the default', () => {
    expect(render({ defaultError: 'Wait a moment.' })).toContain(
      'Wait a moment.',
    );
  });

  it('can start with a search that narrows both lists', () => {
    const html = render({ initialQuery: 'groq' });
    expect(html).toContain('data-preset="groq"');
    expect(html).not.toContain('data-preset="mistral"');
    expect(html).toContain('data-provider="p-groq"');
    expect(html).not.toContain('data-provider="p-ollama"');
  });

  it('never renders a key', () => {
    const leaky = {
      ...groq,
      key: { kind: 'stored', set: true, last4: 'wxyz', value: SECRET },
      keySealed: SECRET,
    } as unknown as ModelProviderView;
    const html = render({ providers: [leaky] });
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain('PLANTEDSECRET');
  });
});

describe('the draft', () => {
  it('starts from the preset for a new provider', () => {
    expect(draftFor(undefined, preset('groq'))).toMatchObject({
      name: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      keyMode: 'stored',
      keyValue: '',
    });
    expect(draftFor(undefined, preset('ollama')).keyMode).toBe('none');
    expect(draftFor(undefined, preset('custom'))).toMatchObject({
      baseUrl: '',
      keyMode: 'stored',
    });
  });

  it('starts from the saved provider, never carrying a key value', () => {
    const draft = draftFor(groq, preset('groq'));
    expect(draft.keyMode).toBe('stored');
    expect(draft.keyValue).toBe('');
    expect(draft.replacing).toBe(false);
    // A stored key that cannot be read must be pasted again.
    expect(
      draftFor({ ...groq, key: { kind: 'stored', set: false } }, preset('groq'))
        .replacing,
    ).toBe(true);
    expect(
      draftFor(
        { ...groq, key: { kind: 'env', set: true, envName: 'MY_KEY' } },
        preset('groq'),
      ),
    ).toMatchObject({ keyMode: 'env', envName: 'MY_KEY' });
  });

  it('checks the pasted key the way the server does', () => {
    expect(keyValueProblem('short')).toMatch(/at least 8/);
    expect(keyValueProblem('has a space inside')).toMatch(/no spaces/);
    expect(keyValueProblem('x'.repeat(4001))).toMatch(/at most 4000/);
    expect(keyValueProblem('  gsk_abcdefgh  ')).toBe('');
  });

  it('only warns when a key starts unlike the provider usually does', () => {
    expect(keyHintWarning('gsk_abcdefgh', preset('groq'))).toBe('');
    expect(keyHintWarning('sk-abcdefgh', preset('groq'))).toContain(
      'Groq keys usually start with gsk_',
    );
    expect(keyHintWarning('', preset('groq'))).toBe('');
    // Mistral has no known prefix: nothing to warn about.
    expect(keyHintWarning('anything-at-all', preset('mistral'))).toBe('');
    expect(keyHintWarning('sk-openai-key', preset('openai'))).toBe('');
    expect(keyHintWarning('sk-openai-key', preset('anthropic'))).toContain(
      'sk-ant-',
    );
    // A hint is not a problem: the draft still validates.
    const draft = {
      ...draftFor(undefined, preset('groq')),
      keyValue: 'sk-notgroqkey',
    };
    expect(draftProblems(draft, preset('groq'))).toEqual({});
  });

  it('validates addresses', () => {
    expect(baseUrlProblem('https://llm.example.com/v1')).toBe('');
    expect(baseUrlProblem('http://localhost:11434/v1')).toBe('');
    expect(baseUrlProblem('http://127.0.0.1:1234/v1')).toBe('');
    expect(baseUrlProblem('http://[::1]:8080')).toBe('');
    expect(baseUrlProblem('')).toMatch(/Enter the server address/);
    expect(baseUrlProblem('llm.example.com')).toMatch(/full address/);
    expect(baseUrlProblem('http://llm.example.com/v1')).toMatch(/https/);
    expect(baseUrlProblem('ftp://llm.example.com')).toMatch(/https/);
    expect(baseUrlProblem('https://me:pw@llm.example.com')).toMatch(/username/);
    expect(baseUrlProblem('https://llm.example.com/v1?key=1')).toMatch(/\?/);
    expect(
      baseUrlProblem(`https://llm.example.com/${'a'.repeat(500)}`),
    ).toMatch(/500/);
  });

  it('validates environment variable names and suggests one', () => {
    expect(envNameProblem('GROQ_API_KEY')).toBe('');
    expect(envNameProblem('')).toMatch(/Enter/);
    expect(envNameProblem('groq key')).toMatch(/capital letters/);
    expect(envNameProblem('1KEY')).toMatch(/capital letters/);
    expect(suggestEnvName(preset('groq'))).toBe('GROQ_API_KEY');
    expect(suggestEnvName(preset('lmstudio'))).toBe('LMSTUDIO_API_KEY');
  });

  it('requires a key where the preset needs one, and only then', () => {
    const groqDraft = draftFor(undefined, preset('groq'));
    expect(problemList(draftProblems(groqDraft, preset('groq')))).toEqual([
      'Paste your API key.',
    ]);
    const custom = {
      ...draftFor(undefined, preset('custom')),
      baseUrl: 'https://llm.example.com/v1',
    };
    expect(draftProblems(custom, preset('custom')).key).toMatch(/No key/);
    expect(
      draftProblems({ ...custom, keyMode: 'none' }, preset('custom')),
    ).toEqual({});
    expect(
      draftProblems(
        { ...groqDraft, keyMode: 'env', envName: 'bad name' },
        preset('groq'),
      ).envName,
    ).toBeTruthy();
    // No key needed for a key that is already stored and is not being replaced.
    expect(
      draftProblems(draftFor(groq, preset('groq')), preset('groq'), groq),
    ).toEqual({});
    expect(
      draftProblems(
        { ...draftFor(groq, preset('groq')), replacing: true },
        preset('groq'),
        groq,
      ).key,
    ).toBeTruthy();
    // The address is checked only where it can be typed.
    expect(
      draftProblems(
        { ...custom, baseUrl: '', keyMode: 'none' },
        preset('custom'),
      ).baseUrl,
    ).toBeTruthy();
    expect(
      draftProblems(
        { ...groqDraft, keyMode: 'none', baseUrl: '' },
        preset('groq'),
      ).baseUrl,
    ).toBeUndefined();
    expect(
      draftProblems(
        { ...groqDraft, keyMode: 'none', name: '  ' },
        preset('groq'),
      ).name,
    ).toBeTruthy();
  });

  it('creates with the key only in the request body', () => {
    const draft = {
      ...draftFor(undefined, preset('groq')),
      keyValue: `  ${SECRET}  `,
    };
    expect(createBody(draft, preset('groq'))).toEqual({
      presetId: 'groq',
      name: 'Groq',
      key: { kind: 'stored', value: SECRET },
    });
    expect(
      createBody(
        { ...draft, keyMode: 'env', envName: 'GROQ_API_KEY' },
        preset('groq'),
      ).key,
    ).toEqual({ kind: 'env', envName: 'GROQ_API_KEY' });
    const local = createBody(
      draftFor(undefined, preset('ollama')),
      preset('ollama'),
    );
    expect(local.key).toEqual({ kind: 'none' });
    expect(local).toMatchObject({ baseUrl: 'http://localhost:11434/v1' });
    const custom = createBody(
      {
        ...draftFor(undefined, preset('custom')),
        name: 'My server',
        baseUrl: ' https://llm.example.com/v1 ',
        keyMode: 'none',
      },
      preset('custom'),
    );
    expect(custom).toEqual({
      presetId: 'custom',
      name: 'My server',
      baseUrl: 'https://llm.example.com/v1',
      key: { kind: 'none' },
    });
    const anthropic = createBody(
      {
        ...draftFor(undefined, preset('anthropic')),
        keyValue: 'sk-ant-abcdefgh',
        workspaceId: ' wrkspc_1 ',
      },
      preset('anthropic'),
    );
    expect(anthropic.extra).toEqual({ anthropicWorkspaceId: 'wrkspc_1' });
    // A fixed-URL preset never sends one.
    expect(createBody(draft, preset('groq'))).not.toHaveProperty('baseUrl');
    // The workspace id belongs to Anthropic only.
    expect(
      createBody({ ...draft, workspaceId: 'x' }, preset('groq')),
    ).not.toHaveProperty('extra');
  });

  it('patches only what changed', () => {
    const base = draftFor(groq, preset('groq'));
    expect(patchBody(base, preset('groq'), groq)).toEqual({});
    expect(
      patchBody({ ...base, name: 'Work Groq ' }, preset('groq'), groq),
    ).toEqual({ name: 'Work Groq' });
    expect(
      patchBody(
        { ...base, replacing: true, keyValue: SECRET },
        preset('groq'),
        groq,
      ),
    ).toEqual({ key: { kind: 'stored', value: SECRET } });
    expect(
      patchBody(
        { ...base, keyMode: 'env', envName: 'MY_KEY' },
        preset('groq'),
        groq,
      ),
    ).toEqual({ key: { kind: 'env', envName: 'MY_KEY' } });
    expect(
      patchBody({ ...base, keyMode: 'none' }, preset('groq'), groq),
    ).toEqual({ key: { kind: 'none' } });
    // An address is only compared where it can be edited; trailing slashes do not count.
    const custom = provider('p-c', 'custom', {
      baseUrl: 'https://llm.example.com/v1',
      key: { kind: 'none', set: false },
    });
    const customDraft = draftFor(custom, preset('custom'));
    expect(
      patchBody(
        { ...customDraft, baseUrl: 'https://llm.example.com/v1/' },
        preset('custom'),
        custom,
      ),
    ).toEqual({});
    expect(
      patchBody(
        { ...customDraft, baseUrl: 'https://other.example.com/v1' },
        preset('custom'),
        custom,
      ),
    ).toEqual({ baseUrl: 'https://other.example.com/v1' });
    expect(
      patchBody(
        { ...base, baseUrl: 'https://evil.example.com' },
        preset('groq'),
        groq,
      ),
    ).toEqual({});
  });

  it('turns a choice into the two Dot fields', () => {
    expect(modelFields({ providerId: null, model: '' })).toEqual({
      model: null,
      modelProviderId: null,
    });
    expect(modelFields({ providerId: 'p-groq', model: ' llama ' })).toEqual({
      model: 'llama',
      modelProviderId: 'p-groq',
    });
  });
});

describe('small helpers', () => {
  it('summarises a test', () => {
    expect(testSummary({ ok: true, count: 42, latencyMs: 320 })).toBe(
      'Connected · 42 models · 320 ms',
    );
    expect(testSummary({ ok: true, count: 1, latencyMs: 80.4 })).toBe(
      'Connected · 1 model · 80 ms',
    );
    expect(testSummary({ ok: true, latencyMs: 90 })).toBe('Connected · 90 ms');
    expect(
      testSummary({ ok: false, latencyMs: 9, error: '401 Unauthorized' }),
    ).toBe('401 Unauthorized');
    expect(testSummary({ ok: false, latencyMs: 9 })).toMatch(/did not answer/);
  });

  it('names who still uses a provider', () => {
    expect(usedByMessage(['Dot A', 'Dot B', 'default model'])).toBe(
      'Used by: Dot A, Dot B, default model',
    );
    expect(usedByMessage([])).toBe('');
  });

  it('searches a model list by id and display name', () => {
    const list = [
      { id: 'llama-3.3-70b', name: 'Llama 3.3 70B' },
      { id: 'mixtral-8x7b' },
    ];
    expect(matchModels(list, '').length).toBe(2);
    expect(matchModels(list, 'LLAMA').map((m) => m.id)).toEqual([
      'llama-3.3-70b',
    ]);
    expect(matchModels(list, 'mixtral').map((m) => m.id)).toEqual([
      'mixtral-8x7b',
    ]);
    expect(matchModels(list, 'zzz')).toEqual([]);
  });

  it('formats context lengths and checks custom model ids', () => {
    expect(formatContext(128_000)).toBe('128K context');
    expect(formatContext(1_000_000)).toBe('1M context');
    expect(formatContext(2_500_000)).toBe('2.5M context');
    expect(formatContext(512)).toBe('512 context');
    expect(formatContext(undefined)).toBe('');
    expect(modelIdProblem('accounts/fireworks/models/x')).toBe('');
    expect(modelIdProblem('deepseek/deepseek-v4:free')).toBe('');
    expect(modelIdProblem('')).toBeTruthy();
    expect(modelIdProblem('has space')).toBeTruthy();
    expect(modelIdProblem('x'.repeat(201))).toBeTruthy();
  });
});

describe('provider requests', () => {
  afterEach(() => vi.unstubAllGlobals());

  const respond = (status: number, body?: unknown) =>
    vi.fn(
      async () =>
        new Response(body === undefined ? null : JSON.stringify(body), {
          status,
        }),
    );

  it('sends the owner token and a JSON body', async () => {
    const fetchMock = respond(200, { ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await providerRequest('/model-providers', 'POST', { presetId: 'groq' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('/api/model-providers');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"presetId":"groq"}');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer owner-token',
      'Content-Type': 'application/json',
    });
  });

  it('treats 204 as success with no body', async () => {
    vi.stubGlobal('fetch', respond(204));
    await expect(
      providerRequest('/model-providers/p1', 'DELETE'),
    ).resolves.toBeUndefined();
  });

  it('keeps the status and the Dots of a 409', async () => {
    vi.stubGlobal(
      'fetch',
      respond(409, {
        error: 'Groq is still in use by Dot A.',
        dots: ['Dot A', 'default model'],
      }),
    );
    const error = await providerRequest('/model-providers/p1', 'DELETE').catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ModelProviderRequestError);
    expect(error).toMatchObject({
      message: 'Groq is still in use by Dot A.',
      status: 409,
      dots: ['Dot A', 'default model'],
    });
  });

  it('passes a server message through, and falls back for an unreadable one', async () => {
    vi.stubGlobal('fetch', respond(400, { error: 'That name is taken.' }));
    await expect(
      providerRequest('/model-providers', 'POST', {}),
    ).rejects.toThrow('That name is taken.');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>', { status: 502 })),
    );
    await expect(providerRequest('/model-providers')).rejects.toThrow(
      'Request failed (502).',
    );
  });
});

describe('Provider page', () => {
  const shared = {
    providers: [envProvider, groq, ollama],
    presets: modelPresets,
    defaultModel: { providerId: 'env', model: 'deepseek/deepseek-v4' },
    onClose: noop,
    onSaved: noop,
    onDeleted: noop,
    onDefaultChanged: noop,
    onReload: noop,
    onCount: noop,
  };
  const page = (
    target: Parameters<typeof ModelProviderPage>[0]['target'],
    extra: Partial<Parameters<typeof ModelProviderPage>[0]> = {},
  ) =>
    renderToStaticMarkup(
      <ModelProviderPage {...shared} target={target} {...extra} />,
    );

  it('sets up a new provider in numbered steps with a way back', () => {
    const html = page({ kind: 'preset', preset: preset('groq') });
    expect(html).toContain('aria-label="Back to models"');
    expect(html).toContain('>Groq</h3>');
    expect(html).toContain('Fast open-weight models on Groq hardware.');
    for (const step of ['API key', 'Connection', 'Test', 'Models'])
      expect(html).toContain(`>${step}</h4>`);
    expect(html).toContain('Add provider');
    expect(html).toContain('>Cancel</button>');
    expect(html).toContain('cs-footer');
    expect(html).toContain('tests the connection as soon as you add');
    expect(html).toContain('href="https://console.groq.com/keys"');
    expect(html).toContain('Get a key');
    expect(html).toContain('href="https://console.groq.com/docs/openai"');
  });

  it('shows a masked, never-echoed key field with a show/hide eye', () => {
    const html = page({ kind: 'preset', preset: preset('groq') });
    expect(html).toMatch(/<input[^>]*type="password"/);
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('spellCheck="false"');
    expect(html).toContain('aria-label="Show key"');
    expect(html).toContain('aria-pressed="false"');
    const field = html.match(/<input[^>]*type="password"[^>]*>/)![0];
    expect(field).toContain('value=""');
  });

  it('offers a .env variable for every preset and "No key" only where optional', () => {
    const groqHtml = page({ kind: 'preset', preset: preset('groq') });
    expect(groqHtml).toContain('Use a variable from .env');
    expect(groqHtml).toContain('Paste a key');
    expect(groqHtml).not.toContain('No key');
    expect(groqHtml.match(/type="radio"/g)).toHaveLength(2);
    const ollamaHtml = page({ kind: 'preset', preset: preset('ollama') });
    expect(ollamaHtml).toContain('No key');
    expect(ollamaHtml.match(/type="radio"/g)).toHaveLength(3);
    // A local program starts on "No key".
    expect(ollamaHtml).toMatch(/checked=""[^>]*value="none"/);
    expect(ollamaHtml).not.toContain('type="password"');
    expect(page({ kind: 'preset', preset: preset('custom') })).toContain(
      'No key',
    );
  });

  it('locks the address for hosted presets and unlocks it for local and custom', () => {
    const locked = page({ kind: 'preset', preset: preset('groq') });
    expect(locked).toMatch(
      /<input[^>]*value="https:\/\/api\.groq\.com\/openai\/v1"[^>]*readOnly=""|<input[^>]*readOnly=""[^>]*value="https:\/\/api\.groq\.com\/openai\/v1"/,
    );
    expect(locked).toContain('Fixed for Groq.');
    const local = page({ kind: 'preset', preset: preset('ollama') });
    expect(local).toContain('value="http://localhost:11434/v1"');
    expect(local).not.toMatch(
      /value="http:\/\/localhost:11434\/v1"[^>]*readOnly/,
    );
    expect(local).toContain('Usually http://localhost');
    const custom = page({ kind: 'preset', preset: preset('custom') });
    expect(custom).toContain('placeholder="https://api.example.com/v1"');
    expect(custom).not.toContain('Fixed for');
  });

  it('asks for the Anthropic workspace id, optionally, and nowhere else', () => {
    const html = page({ kind: 'preset', preset: preset('anthropic') });
    expect(html).toContain('Workspace ID (optional)');
    expect(page({ kind: 'preset', preset: preset('groq') })).not.toContain(
      'Workspace ID',
    );
  });

  it('shows a saved key as its last four characters with Replace key', () => {
    const html = page({ kind: 'provider', id: 'p-groq' });
    expect(html).toContain('•••• wxyz');
    expect(html).toContain('Replace key');
    expect(html).toContain('Saved');
    expect(html).not.toMatch(/<input[^>]*type="password"/);
    expect(html).toContain('Save changes');
    expect(html.match(/<button[^>]*data-primary[^>]*>/)![0]).toContain(
      'disabled=""',
    );
    expect(html).toContain('Test connection');
    expect(html).toContain('Delete provider');
    expect(html).toContain('role="switch"');
    expect(html).toMatch(
      /role="switch"[^>]*checked=""|checked=""[^>]*role="switch"/,
    );
  });

  it('never prints a planted key, whatever the view carries', () => {
    const leaky = {
      ...groq,
      key: { kind: 'stored', set: true, last4: 'wxyz', value: SECRET },
      keySealed: SECRET,
      lastError: null,
    } as unknown as ModelProviderView;
    const html = page(
      { kind: 'provider', id: 'p-groq' },
      { providers: [leaky] },
    );
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain('PLANTEDSECRET');
    expect(html).toContain('•••• wxyz');
    // Neither does the creation form or the unreadable-key state.
    const fresh = page({ kind: 'preset', preset: preset('groq') });
    expect(fresh).not.toContain(SECRET);
    const unreadable = page(
      { kind: 'provider', id: 'p-groq' },
      { providers: [{ ...groq, key: { kind: 'stored', set: false } }] },
    );
    expect(unreadable).toContain('Key missing');
    expect(unreadable).toContain('New API key');
    expect(unreadable).not.toContain('Keep the saved key');
  });

  it('shows the variable name and whether it is set for a .env key', () => {
    const set = page(
      { kind: 'provider', id: 'p-env' },
      {
        providers: [
          provider('p-env', 'groq', {
            key: { kind: 'env', set: true, envName: 'GROQ_API_KEY' },
          }),
        ],
      },
    );
    expect(set).toContain('value="GROQ_API_KEY"');
    expect(set).toContain('cn-set');
    const unset = page(
      { kind: 'provider', id: 'p-env' },
      {
        providers: [
          provider('p-env', 'groq', {
            key: { kind: 'env', set: false, envName: 'GROQ_API_KEY' },
          }),
        ],
      },
    );
    expect(unset).toContain('cn-unset');
    expect(unset).toContain('Key missing');
  });

  it('shows the .env provider read-only: no key step, no footer, no delete', () => {
    const html = page({ kind: 'provider', id: 'env' });
    expect(html).toContain('Set in the server .env');
    expect(html).toContain('OPENAI_API_KEY');
    expect(html).toContain('From .env');
    expect(html).not.toContain('>API key</h4>');
    expect(html).not.toContain('Delete provider');
    expect(html).not.toContain('cs-footer');
    expect(html).not.toContain('role="switch"');
    expect(html).toContain('Test connection');
    expect(html).toContain('https://openrouter.ai/api/v1');
  });

  it('shows the models with capability chips, context and Set as default', () => {
    const html = page(
      { kind: 'provider', id: 'p-groq' },
      {
        initialModels: {
          models: [
            {
              id: 'llama-3.3-70b-versatile',
              name: 'Llama 3.3 70B',
              tools: true,
              contextLength: 128_000,
            },
            { id: 'old-model', tools: false },
            { id: 'plain-model' },
          ],
        },
        defaultModel: { providerId: 'p-groq', model: 'plain-model' },
      },
    );
    expect(html).toContain('3 models');
    expect(html).toContain('Llama 3.3 70B');
    expect(html).toContain('llama-3.3-70b-versatile');
    expect(html).toContain('mp-chip-ok');
    expect(html).toContain('>Tools<');
    expect(html).toContain('No tools');
    expect(html).toContain('128K context');
    expect(html.match(/Set as default/g)?.length).toBe(3); // 2 rows + the manual field
    expect(html).toContain('mp-badge-default');
    expect(html).toContain('Not in the list? Type a model id');
    expect(html).toContain('aria-label="Search models"');
  });

  it('says why a list could not be fetched and how to carry on', () => {
    const html = page(
      { kind: 'provider', id: 'p-groq' },
      {
        initialModels: { models: [], error: 'The list endpoint returned 404.' },
      },
    );
    expect(html).toContain('The list endpoint returned 404.');
    expect(html).toContain('type a model id');
  });

  it('shows test results', () => {
    const ok = page(
      { kind: 'provider', id: 'p-groq' },
      {
        initialTest: {
          phase: 'done',
          result: { ok: true, count: 42, latencyMs: 320 },
        },
      },
    );
    expect(ok).toContain('Connected · 42 models · 320 ms');
    const bad = page(
      { kind: 'provider', id: 'p-groq' },
      {
        initialTest: {
          phase: 'done',
          result: { ok: false, latencyMs: 12, error: '401 Unauthorized' },
        },
      },
    );
    expect(bad).toContain('401 Unauthorized');
    expect(bad).toContain('cs-banner-bad');
    const throttled = page(
      { kind: 'provider', id: 'p-groq' },
      {
        initialTest: {
          phase: 'failed',
          message: 'Wait a moment before testing this provider again.',
        },
      },
    );
    expect(throttled).toContain('Wait a moment before testing');
    expect(
      page(
        { kind: 'provider', id: 'p-groq' },
        { initialTest: { phase: 'busy' } },
      ),
    ).toContain('Testing…');
  });

  it('explains a stopped local program and a disabled provider', () => {
    const stopped = page(
      { kind: 'provider', id: 'p-ollama' },
      {
        providers: [{ ...ollama, lastError: 'connect ECONNREFUSED' }],
        initialModels: { models: [] },
      },
    );
    expect(stopped).toContain('Not running');
    expect(stopped).toContain('Start it, then test again.');
    const off = page(
      { kind: 'provider', id: 'p-groq' },
      { providers: [{ ...groq, enabled: false }] },
    );
    expect(off).toContain('Disabled');
    expect(off).toContain('Turn the provider on to see its models.');
  });

  it('says so when the provider is gone', () => {
    expect(page({ kind: 'provider', id: 'missing' })).toContain(
      'This provider is gone.',
    );
  });
});

describe('Models tab container', () => {
  it('renders the gallery from data it was given', () => {
    const html = renderToStaticMarkup(
      <ModelProvidersSettings
        initial={{
          providers: [envProvider, groq],
          presets: modelPresets,
          defaultModel: { providerId: 'p-groq', model: 'llama-3.3-70b' },
        }}
      />,
    );
    expect(html).toContain('cx-root');
    expect(html).toContain('Groq · llama-3.3-70b');
    expect(html).toContain('Your providers');
    expect(html).not.toContain('Loading models');
  });

  it('says Loading while the first request is out', () => {
    const html = renderToStaticMarkup(<ModelProvidersSettings />);
    expect(html).toContain('Loading models');
  });
});

describe('Model picker', () => {
  const lists: PickerProvider[] = [
    {
      id: 'env',
      name: 'Default (from .env)',
      presetId: 'openrouter',
      models: [
        { id: 'deepseek/deepseek-v4', tools: true, contextLength: 128_000 },
        { id: 'openai/gpt-5-mini', name: 'GPT-5 mini' },
      ],
    },
    {
      id: 'p-groq',
      name: 'Groq',
      presetId: 'groq',
      models: [
        { id: 'llama-3.3-70b-versatile', tools: true },
        { id: 'tiny-model', tools: false },
      ],
    },
    { id: 'p-empty', name: 'Empty', presetId: 'custom', models: [] },
  ];
  const data: ModelsData = {
    default: 'Default (from .env) · deepseek/deepseek-v4',
    providers: lists,
  };

  it('groups by provider and filters by model id, model name or provider name', () => {
    expect(pickerGroups(lists, '').map((g) => g.provider.id)).toEqual([
      'env',
      'p-groq',
      'p-empty',
    ]);
    const byId = pickerGroups(lists, 'llama');
    expect(byId.map((g) => g.provider.id)).toEqual(['p-groq']);
    expect(byId[0]!.models.map((m) => m.id)).toEqual([
      'llama-3.3-70b-versatile',
    ]);
    expect(pickerGroups(lists, 'gpt-5 MINI')[0]!.models).toHaveLength(1);
    // A matching provider name keeps all its models.
    expect(pickerGroups(lists, 'groq')[0]!.models).toHaveLength(2);
    expect(pickerGroups(lists, 'nothing-matches')).toEqual([]);
  });

  it('caps the rows drawn per provider but reports the total', () => {
    const many: PickerProvider = {
      id: 'or',
      name: 'OpenRouter',
      presetId: 'openrouter',
      models: Array.from({ length: GROUP_LIMIT + 40 }, (_, i) => ({
        id: `vendor/model-${i}`,
      })),
    };
    const [group] = pickerGroups([many], '');
    expect(group!.models).toHaveLength(GROUP_LIMIT);
    expect(group!.total).toBe(GROUP_LIMIT + 40);
    const [narrow] = pickerGroups([many], 'model-9');
    expect(narrow!.total).toBeLessThan(GROUP_LIMIT + 40);
  });

  it('orders options: default, every drawn model, then custom', () => {
    const groups = pickerGroups(lists, '');
    const options = pickerOptions(groups, true);
    expect(options[0]).toEqual({ kind: 'default' });
    expect(options.at(-1)).toEqual({ kind: 'custom' });
    expect(options).toHaveLength(1 + 4 + 1);
    expect(options[1]).toEqual({
      kind: 'model',
      providerId: 'env',
      model: 'deepseek/deepseek-v4',
    });
    expect(pickerOptions(groups, false)[0]).toMatchObject({ kind: 'model' });
  });

  it('labels a choice, and notices a provider that is gone', () => {
    expect(
      choiceLabel({ providerId: null, model: '' }, lists, 'Groq · llama').text,
    ).toBe('Default · Groq · llama');
    expect(
      choiceLabel({ providerId: null, model: '' }, undefined, null).text,
    ).toBe('Default model');
    expect(
      choiceLabel({ providerId: null, model: 'gpt-x' }, lists, null).text,
    ).toBe('Default provider · gpt-x');
    const groqChoice = choiceLabel(
      { providerId: 'p-groq', model: 'tiny-model' },
      lists,
      null,
    );
    expect(groqChoice.text).toBe('Groq · tiny-model');
    expect(groqChoice.stale).toBe(false);
    expect(groqChoice.provider?.presetId).toBe('groq');
    const gone = choiceLabel({ providerId: 'p-old', model: 'm' }, lists, null);
    expect(gone.text).toBe('p-old · m');
    expect(gone.stale).toBe(true);
    // Not stale while the list has not loaded yet.
    expect(
      choiceLabel({ providerId: 'p-old', model: 'm' }, undefined, null).stale,
    ).toBe(false);
  });

  it('renders a closed combobox trigger showing the current choice', () => {
    const html = renderToStaticMarkup(
      <ModelPicker
        id="dot-model"
        value={{ providerId: 'p-groq', model: 'tiny-model' }}
        onChange={noop}
        initialData={data}
      />,
    );
    expect(html).toContain('id="dot-model"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Groq · tiny-model');
    expect(html).not.toContain('role="listbox"');
  });

  it('shows the default on the trigger before anything is chosen', () => {
    const html = renderToStaticMarkup(
      <ModelPicker
        value={{ providerId: null, model: '' }}
        onChange={noop}
        defaultLabel="OpenRouter · deepseek/x"
      />,
    );
    expect(html).toContain('Default · OpenRouter · deepseek/x');
  });

  it('warns about a chosen provider that no longer exists', () => {
    const html = renderToStaticMarkup(
      <ModelPicker
        value={{ providerId: 'p-old', model: 'm' }}
        onChange={noop}
        initialData={data}
      />,
    );
    expect(html).toContain('no longer exists');
    expect(html).toContain('data-stale="true"');
  });

  it('opens onto an accessible listbox with groups, the default and a custom row', () => {
    const html = renderToStaticMarkup(
      <ModelPicker
        value={{ providerId: 'p-groq', model: 'tiny-model' }}
        onChange={noop}
        initialData={data}
        initialOpen
      />,
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('role="listbox"');
    expect(html).toMatch(/aria-controls="[^"]+-list"/);
    expect(html).toMatch(/aria-activedescendant="[^"]+-opt-0"/);
    expect(html).toContain('placeholder="Search models"');
    // Default first.
    expect(html).toContain(
      'Use default (Default (from .env) · deepseek/deepseek-v4)',
    );
    const options = html.match(/role="option"/g)!;
    expect(options).toHaveLength(1 + 4 + 1);
    // Groups with their provider names and a refresh button each.
    expect(html.match(/role="group"/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Groq"');
    expect(html).toContain('aria-label="Refresh Groq models"');
    expect(html).toContain('data-preset="groq"');
    // Display name, id, chips.
    expect(html).toContain('GPT-5 mini');
    expect(html).toContain('openai/gpt-5-mini');
    expect(html).toContain('>Tools<');
    expect(html).toContain('No tools');
    expect(html).toContain('128K context');
    // The current choice is selected and the default row is not.
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toMatch(/id="[^"]+-opt-4"[^>]*aria-selected="true"/);
    // The escape hatch, and a note for the empty provider.
    expect(html).toContain('Use a custom model id…');
    expect(html).toContain('No models listed.');
  });

  it('marks the default option as selected when the Dot follows the default', () => {
    const html = renderToStaticMarkup(
      <ModelPicker
        value={{ providerId: null, model: '' }}
        onChange={noop}
        initialData={data}
        initialOpen
      />,
    );
    expect(html).toMatch(/id="[^"]+-opt-0"[^>]*aria-selected="true"/);
  });

  it('drops the default option for the default-model chooser', () => {
    const html = renderToStaticMarkup(
      <ModelPicker
        variant="button"
        buttonLabel="Change"
        allowDefault={false}
        value={{ providerId: 'env', model: 'deepseek/deepseek-v4' }}
        onChange={noop}
        initialData={data}
        initialOpen
      />,
    );
    expect(html).toContain('>Change</button>');
    expect(html).not.toContain('Use default');
    expect(html.match(/role="option"/g)).toHaveLength(4 + 1);
    expect(html).toContain('mp-picker-button');
  });

  it('has no providers to offer yet', () => {
    const html = renderToStaticMarkup(
      <ModelPicker
        value={{ providerId: null, model: '' }}
        onChange={noop}
        initialData={{ providers: [] }}
        initialOpen
      />,
    );
    expect(html).toContain('No providers are turned on.');
    expect(html).toContain('Use a custom model id…');
  });
});

describe('Settings and Dot dialogs', () => {
  const workspace = (setup: Record<string, unknown>) =>
    ({
      spaces: [{ id: 's1', name: 'Everyday' }],
      dots: [],
      setup: {
        missing: [],
        search: false,
        browser: false,
        voice: false,
        ...setup,
      },
    }) as unknown as WorkspaceState;
  const state = {
    settings: { researchAllowed: true, memoryAllowed: true },
  } as unknown as State;
  const render = (
    dialog: Parameters<typeof WorkspaceDialog>[0]['dialog'],
    setup: Record<string, unknown> = {},
  ) =>
    renderToStaticMarkup(
      <WorkspaceDialog
        dialog={dialog}
        state={state}
        workspace={workspace(setup)}
        onClose={noop}
        mutate={async () => true}
      />,
    );

  it('adds a Models tab between General and Connectors', () => {
    const html = render({ type: 'settings', tab: 'general' });
    const order = ['General', 'Models', 'Connectors', 'About'].map((label) =>
      html.indexOf(`</svg>${label}</button>`),
    );
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('id="settings-tab-models"');
    expect(html).toContain('id="settings-panel-models"');
    expect(html).toMatch(/id="settings-panel-models"[^>]*hidden=""/);
  });

  it('opens straight on Models, loads it lazily and drops the Save button', () => {
    const html = render({ type: 'settings', tab: 'models' });
    expect(html).toMatch(/id="settings-tab-models"[^>]*aria-selected="true"/);
    expect(html).not.toMatch(/id="settings-panel-models"[^>]*hidden=""/);
    expect(html).toContain('Loading models');
    expect(html).not.toContain('>Save<');
    // The other tab's panel stays empty until it is opened.
    expect(render({ type: 'settings', tab: 'general' })).not.toContain(
      'Loading models',
    );
  });

  it('points the setup note at Settings → Models when no provider is usable', () => {
    const html = render(
      { type: 'settings', tab: 'general' },
      { missing: ['model provider'] },
    );
    expect(html).toContain('Add a model provider in');
    expect(html).toContain('Settings → Models');
    expect(html).toContain('or set OPENAI_API_KEY and restart.');
    const ready = render({ type: 'settings', tab: 'general' });
    expect(ready).not.toContain('Add a model provider in');
    expect(ready).toContain('A model provider is ready.');
  });

  it('puts the picker in the Dot form and shows the Dot’s provider and model', () => {
    const dot = {
      id: 'dot-1',
      name: 'Scout',
      instructions: 'Find things.',
      spaceId: 's1',
      spaceIds: ['s1'],
      researchAllowed: true,
      memoryAllowed: true,
      model: 'llama-3.3-70b-versatile',
      modelProviderId: 'p-groq',
      approvalMode: 'sensitive',
    } as unknown as Dot;
    const html = render({ type: 'dot', dot, spaceId: 's1' });
    expect(html).toContain('>Model</h3>');
    expect(html).toContain('id="dot-model"');
    expect(html).toContain('p-groq · llama-3.3-70b-versatile');
    expect(html).toContain('Settings → Models');
    expect(html).not.toContain('<datalist');
    expect(html).not.toContain('list="dot-model-options"');
  });
});
