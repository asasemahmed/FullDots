import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Check, CircleAlert, LoaderCircle, Radio } from 'lucide-react';
import { api } from './api';
import type {
  ChannelInput,
  ChannelProvider,
  ChannelSettings,
} from '../shared/channels';
import type { Dot } from '../shared/types';
import './channels.css';

export interface ChannelsSettingsProps {
  dots: Dot[];
  active?: boolean;
}

interface ChannelDraft {
  enabled: boolean;
  dotId: string;
  workspaceId: string;
  ownerUserIdsText: string;
  chatId: string;
  botTokenInput: string;
  appTokenInput: string;
  clearBotToken: boolean;
  clearAppToken: boolean;
}

function parseOwnerUserIds(text: string): string[] {
  return text
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function createDefaultSettings(provider: ChannelProvider): ChannelSettings {
  return {
    provider,
    enabled: false,
    dotId: '',
    workspaceId: '',
    ownerUserIds: [],
    chatId: '',
    revision: 0,
    botTokenSet: false,
    appTokenSet: false,
    status: 'disabled',
    failure: null,
    ignored: 0,
  };
}

function createDraftFromSettings(settings: ChannelSettings): ChannelDraft {
  return {
    enabled: settings.enabled,
    dotId: settings.dotId,
    workspaceId: settings.workspaceId,
    ownerUserIdsText: settings.ownerUserIds.join(', '),
    chatId: settings.chatId,
    botTokenInput: '',
    appTokenInput: '',
    clearBotToken: false,
    clearAppToken: false,
  };
}

function statusPillClass(status: ChannelSettings['status']): string {
  switch (status) {
    case 'connected':
      return 'ch-status-pill status-connected';
    case 'connecting':
      return 'ch-status-pill status-connecting';
    case 'failed':
      return 'ch-status-pill status-failed';
    case 'disabled':
    default:
      return 'ch-status-pill status-disabled';
  }
}

function statusLabel(status: ChannelSettings['status']): string {
  switch (status) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting…';
    case 'failed':
      return 'Failed';
    case 'disabled':
    default:
      return 'Disabled';
  }
}

export function ChannelsSettings({
  dots,
  active = true,
}: ChannelsSettingsProps) {
  const [serverSettings, setServerSettings] = useState<
    Record<ChannelProvider, ChannelSettings>
  >(() => ({
    slack: createDefaultSettings('slack'),
    telegram: createDefaultSettings('telegram'),
  }));

  const [drafts, setDrafts] = useState<Record<ChannelProvider, ChannelDraft>>(
    () => ({
      slack: createDraftFromSettings(createDefaultSettings('slack')),
      telegram: createDraftFromSettings(createDefaultSettings('telegram')),
    }),
  );

  const [isDirty, setIsDirty] = useState<Record<ChannelProvider, boolean>>({
    slack: false,
    telegram: false,
  });
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState<Record<ChannelProvider, boolean>>({
    slack: false,
    telegram: false,
  });
  const [error, setError] = useState<Record<ChannelProvider, string>>({
    slack: '',
    telegram: '',
  });
  const [success, setSuccess] = useState<Record<ChannelProvider, string>>({
    slack: '',
    telegram: '',
  });

  const applyServerUpdate = useCallback((list: ChannelSettings[]) => {
    setServerSettings((prev) => {
      const next = { ...prev };
      for (const item of list) {
        next[item.provider] = item;
      }
      return next;
    });

    setDrafts((prevDrafts) => {
      const nextDrafts = { ...prevDrafts };
      for (const item of list) {
        const provider = item.provider;
        // Preserve user's dirty inputs if they have uncommitted edits
        if (!isDirtyRef.current[provider]) {
          nextDrafts[provider] = {
            ...nextDrafts[provider],
            enabled: item.enabled,
            dotId: item.dotId,
            workspaceId: item.workspaceId,
            ownerUserIdsText: item.ownerUserIds.join(', '),
            chatId: item.chatId,
          };
        }
      }
      return nextDrafts;
    });
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await api<ChannelSettings[]>('/channels');
      applyServerUpdate(data);
      setLoadError('');
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : 'Could not load channels.',
      );
    } finally {
      setLoading(false);
    }
  }, [applyServerUpdate]);

  useEffect(() => {
    void load();
  }, [load]);

  // Periodic polling for status/telemetry while tab is active
  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const data = await api<ChannelSettings[]>('/channels');
        if (cancelled) return;
        applyServerUpdate(data);
      } catch {
        // Background polling errors do not disrupt the user
      }
    };

    const interval = setInterval(() => {
      void poll();
    }, 5000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [active, applyServerUpdate]);

  const updateDraft = (
    provider: ChannelProvider,
    changes: Partial<ChannelDraft>,
  ) => {
    setIsDirty((prev) => ({ ...prev, [provider]: true }));
    setError((prev) => ({ ...prev, [provider]: '' }));
    setSuccess((prev) => ({ ...prev, [provider]: '' }));
    setDrafts((prev) => ({
      ...prev,
      [provider]: { ...prev[provider], ...changes },
    }));
  };

  const saveChannel = async (provider: ChannelProvider) => {
    if (saving[provider]) return;
    const draft = drafts[provider];

    const ownerUserIds = parseOwnerUserIds(draft.ownerUserIdsText);
    if (provider === 'telegram') {
      const hasInvalidOwner = ownerUserIds.some((id) => !/^\d+$/.test(id));
      if (hasInvalidOwner) {
        setError((prev) => ({
          ...prev,
          telegram: 'Telegram owner user IDs must be numeric.',
        }));
        return;
      }
    }
    const chatId = draft.chatId.trim();
    if (chatId !== '' && !/^-?\d+$/.test(chatId)) {
      setError((prev) => ({
        ...prev,
        [provider]:
          'Chat ID must be empty or a numeric ID (e.g. 123456789 or -1001234567890).',
      }));
      return;
    }
    if (ownerUserIds.length > 100) {
      setError((prev) => ({
        ...prev,
        [provider]: 'Maximum 100 owner user IDs allowed.',
      }));
      return;
    }
    const tooLongOwner = ownerUserIds.find((id) => id.length > 100);
    if (tooLongOwner) {
      setError((prev) => ({
        ...prev,
        [provider]: 'Owner user IDs must be 100 characters or less.',
      }));
      return;
    }
    if (draft.botTokenInput.trim().length > 512) {
      setError((prev) => ({
        ...prev,
        [provider]: 'Bot token must be 512 characters or less.',
      }));
      return;
    }
    if (draft.appTokenInput.trim().length > 512) {
      setError((prev) => ({
        ...prev,
        [provider]: 'App token must be 512 characters or less.',
      }));
      return;
    }

    setSaving((prev) => ({ ...prev, [provider]: true }));
    setError((prev) => ({ ...prev, [provider]: '' }));
    setSuccess((prev) => ({ ...prev, [provider]: '' }));

    const body: ChannelInput = {
      enabled: draft.enabled,
      dotId: draft.dotId,
      workspaceId: draft.workspaceId.trim(),
      ownerUserIds,
      chatId,
      ...(draft.clearBotToken
        ? { botToken: null }
        : draft.botTokenInput.trim()
          ? { botToken: draft.botTokenInput.trim() }
          : {}),
      ...(provider === 'slack'
        ? draft.clearAppToken
          ? { appToken: null }
          : draft.appTokenInput.trim()
            ? { appToken: draft.appTokenInput.trim() }
            : {}
        : {}),
    };

    try {
      const updated = await api<ChannelSettings>(
        `/channels/${provider}`,
        'PUT',
        body,
      );
      setServerSettings((prev) => ({ ...prev, [provider]: updated }));
      setDrafts((prev) => ({
        ...prev,
        [provider]: {
          ...prev[provider],
          enabled: updated.enabled,
          dotId: updated.dotId,
          workspaceId: updated.workspaceId,
          ownerUserIdsText: updated.ownerUserIds.join(', '),
          chatId: updated.chatId,
          botTokenInput: '',
          appTokenInput: '',
          clearBotToken: false,
          clearAppToken: false,
        },
      }));
      setIsDirty((prev) => ({ ...prev, [provider]: false }));
      setSuccess((prev) => ({
        ...prev,
        [provider]: `${provider === 'slack' ? 'Slack' : 'Telegram'} settings saved.`,
      }));
    } catch (err) {
      setError((prev) => ({
        ...prev,
        [provider]:
          err instanceof Error
            ? err.message
            : 'Could not save channel settings.',
      }));
    } finally {
      setSaving((prev) => ({ ...prev, [provider]: false }));
    }
  };

  const onCardKeyDown =
    (provider: ChannelProvider) => (event: ReactKeyboardEvent) => {
      if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
        event.preventDefault();
        void saveChannel(provider);
      }
    };

  const slack = serverSettings.slack;
  const slackDraft = drafts.slack;
  const telegram = serverSettings.telegram;
  const telegramDraft = drafts.telegram;

  return (
    <div className="ch-root" data-channels-settings>
      <div className="ch-head">
        <h3>Channels</h3>
        <p>Connect your Dots directly to Slack and Telegram.</p>
      </div>

      <div
        className="ch-banner"
        role="region"
        aria-label="Channels information"
      >
        <div className="ch-banner-title">
          <Radio size={16} aria-hidden="true" />
          <strong>Direct messaging channels</strong>
        </div>
        <p>
          Messages and replies pass directly through Slack or Telegram. No
          hosted CopilotKit account is used; Slack Socket Mode and Telegram
          polling need no public endpoint.
        </p>
        <p>
          Plain text such as &ldquo;yes&rdquo; never approves; approval buttons
          are single-use.
        </p>
        <p>
          Chat-only authorization is allowed only for the owner&rsquo;s private
          positive-ID DM; groups need explicit user IDs.
        </p>
      </div>

      {loading && (
        <p className="ch-loading" role="status">
          Loading channels…
        </p>
      )}

      {loadError && (
        <div className="dlg-error" role="alert">
          <CircleAlert size={16} aria-hidden="true" />
          <span>{loadError}</span>
          <button
            type="button"
            className="dlg-btn dlg-btn-sm"
            onClick={() => void load()}
          >
            Try again
          </button>
        </div>
      )}

      {!loading && !loadError && (
        <div className="ch-cards">
          {/* Slack Channel Card */}
          <section
            className="ch-card"
            aria-labelledby="slack-heading"
            onKeyDown={onCardKeyDown('slack')}
          >
            <fieldset className="ch-fieldset" disabled={saving.slack}>
              <div className="ch-card-header">
                <div className="ch-card-title-group">
                  <h4 id="slack-heading" className="ch-card-title">
                    Slack
                  </h4>
                  <div className="ch-meta">
                    <span
                      className={statusPillClass(slack.status)}
                      role="status"
                      aria-label={`Slack status: ${statusLabel(slack.status)}`}
                    >
                      {statusLabel(slack.status)}
                    </span>
                    <span
                      className="ch-ignored-badge"
                      title="Messages ignored from unauthorized users or invalid approval responses"
                    >
                      Ignored: {slack.ignored}
                    </span>
                  </div>
                </div>
                <label className="ch-switch-label">
                  <strong>Enable</strong>
                  <input
                    type="checkbox"
                    role="switch"
                    className="dlg-sr"
                    checked={slackDraft.enabled}
                    onChange={(e) =>
                      updateDraft('slack', { enabled: e.target.checked })
                    }
                  />
                  <span className="dlg-switch-track" aria-hidden="true" />
                </label>
              </div>

              {slack.failure && (
                <div
                  className="dlg-error ch-failure-box"
                  role="alert"
                  aria-live="polite"
                >
                  <CircleAlert size={16} aria-hidden="true" />
                  <span>Connection failure: {slack.failure}</span>
                </div>
              )}

              <div className="ch-field-group">
                <label className="dlg-label" htmlFor="slack-dot-select">
                  Assigned Dot
                </label>
                <select
                  id="slack-dot-select"
                  className="dlg-input dlg-select"
                  value={slackDraft.dotId}
                  onChange={(e) =>
                    updateDraft('slack', { dotId: e.target.value })
                  }
                >
                  <option value="">Choose a Dot</option>
                  {dots.map((dot) => (
                    <option key={dot.id} value={dot.id}>
                      {dot.name}
                    </option>
                  ))}
                </select>
                <p className="dlg-hint">
                  The Dot that receives messages and replies in Slack.
                </p>
              </div>

              <div className="ch-field-group">
                <div className="ch-token-header">
                  <label className="dlg-label" htmlFor="slack-bot-token-input">
                    Bot Token
                  </label>
                  <div className="ch-token-status">
                    <span
                      className={`ch-token-badge ${slack.botTokenSet ? 'is-set' : ''}`}
                    >
                      {slack.botTokenSet ? 'Set' : 'Not set'}
                    </span>
                    {slack.botTokenSet && !slackDraft.clearBotToken && (
                      <button
                        type="button"
                        className="ch-clear-btn"
                        disabled={saving.slack}
                        onClick={() =>
                          updateDraft('slack', { clearBotToken: true })
                        }
                      >
                        Clear saved token
                      </button>
                    )}
                    {slackDraft.clearBotToken && (
                      <span className="ch-clear-notice">
                        Will be cleared on save
                        <button
                          type="button"
                          className="ch-undo-btn"
                          disabled={saving.slack}
                          onClick={() =>
                            updateDraft('slack', { clearBotToken: false })
                          }
                        >
                          Keep token
                        </button>
                      </span>
                    )}
                  </div>
                </div>
                <input
                  id="slack-bot-token-input"
                  type="password"
                  autoComplete="new-password"
                  className="dlg-input"
                  placeholder={
                    slackDraft.clearBotToken
                      ? 'Token will be cleared on save'
                      : slack.botTokenSet
                        ? '••••••••  (blank preserves stored token)'
                        : 'xoxb-...'
                  }
                  disabled={slackDraft.clearBotToken}
                  value={slackDraft.botTokenInput}
                  onChange={(e) =>
                    updateDraft('slack', {
                      botTokenInput: e.target.value,
                      clearBotToken: false,
                    })
                  }
                />
                <p className="dlg-hint">
                  Slack Bot User OAuth Token starting with xoxb-. Blank input
                  preserves current token.
                </p>
              </div>

              <div className="ch-field-group">
                <div className="ch-token-header">
                  <label className="dlg-label" htmlFor="slack-app-token-input">
                    App Token
                  </label>
                  <div className="ch-token-status">
                    <span
                      className={`ch-token-badge ${slack.appTokenSet ? 'is-set' : ''}`}
                    >
                      {slack.appTokenSet ? 'Set' : 'Not set'}
                    </span>
                    {slack.appTokenSet && !slackDraft.clearAppToken && (
                      <button
                        type="button"
                        className="ch-clear-btn"
                        disabled={saving.slack}
                        onClick={() =>
                          updateDraft('slack', { clearAppToken: true })
                        }
                      >
                        Clear saved token
                      </button>
                    )}
                    {slackDraft.clearAppToken && (
                      <span className="ch-clear-notice">
                        Will be cleared on save
                        <button
                          type="button"
                          className="ch-undo-btn"
                          disabled={saving.slack}
                          onClick={() =>
                            updateDraft('slack', { clearAppToken: false })
                          }
                        >
                          Keep token
                        </button>
                      </span>
                    )}
                  </div>
                </div>
                <input
                  id="slack-app-token-input"
                  type="password"
                  autoComplete="new-password"
                  className="dlg-input"
                  placeholder={
                    slackDraft.clearAppToken
                      ? 'Token will be cleared on save'
                      : slack.appTokenSet
                        ? '••••••••  (blank preserves stored token)'
                        : 'xapp-...'
                  }
                  disabled={slackDraft.clearAppToken}
                  value={slackDraft.appTokenInput}
                  onChange={(e) =>
                    updateDraft('slack', {
                      appTokenInput: e.target.value,
                      clearAppToken: false,
                    })
                  }
                />
                <p className="dlg-hint">
                  Slack App-Level Token for Socket Mode with connections:write
                  scope starting with xapp-.
                </p>
              </div>

              <div className="ch-field-group">
                <label className="dlg-label" htmlFor="slack-workspace-id-input">
                  Allowed Workspace ID
                </label>
                <input
                  id="slack-workspace-id-input"
                  type="text"
                  className="dlg-input"
                  placeholder="T0123456789"
                  value={slackDraft.workspaceId}
                  onChange={(e) =>
                    updateDraft('slack', { workspaceId: e.target.value })
                  }
                />
                <p className="dlg-hint">
                  Slack Team/Workspace ID (e.g. T0123456789) to restrict
                  incoming events.
                </p>
              </div>

              <div className="ch-field-group">
                <label
                  className="dlg-label"
                  htmlFor="slack-owner-user-ids-input"
                >
                  Allowed Owner User IDs
                </label>
                <textarea
                  id="slack-owner-user-ids-input"
                  className="dlg-input dlg-textarea"
                  rows={2}
                  placeholder="U0123456789, U9876543210"
                  value={slackDraft.ownerUserIdsText}
                  onChange={(e) =>
                    updateDraft('slack', { ownerUserIdsText: e.target.value })
                  }
                />
                <p className="dlg-hint">
                  Authorized Slack member IDs allowed to converse with this Dot
                  and approve actions. Comma or newline separated.
                </p>
              </div>

              <div className="ch-card-footer">
                <div className="ch-feedback">
                  {success.slack && (
                    <span className="ch-success-text" role="status">
                      <Check size={16} aria-hidden="true" />
                      <span>{success.slack}</span>
                    </span>
                  )}
                  {error.slack && (
                    <span className="ch-error-text" role="alert">
                      <CircleAlert size={16} aria-hidden="true" />
                      <span>{error.slack}</span>
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="dlg-btn dlg-primary"
                  disabled={saving.slack}
                  onClick={() => void saveChannel('slack')}
                >
                  {saving.slack ? (
                    <>
                      <LoaderCircle
                        size={14}
                        className="cx-spin"
                        aria-hidden="true"
                      />
                      <span>Saving…</span>
                    </>
                  ) : (
                    'Save Slack'
                  )}
                </button>
              </div>
            </fieldset>
          </section>

          {/* Telegram Channel Card */}
          <section
            className="ch-card"
            aria-labelledby="telegram-heading"
            onKeyDown={onCardKeyDown('telegram')}
          >
            <fieldset className="ch-fieldset" disabled={saving.telegram}>
              <div className="ch-card-header">
                <div className="ch-card-title-group">
                  <h4 id="telegram-heading" className="ch-card-title">
                    Telegram
                  </h4>
                  <div className="ch-meta">
                    <span
                      className={statusPillClass(telegram.status)}
                      role="status"
                      aria-label={`Telegram status: ${statusLabel(telegram.status)}`}
                    >
                      {statusLabel(telegram.status)}
                    </span>
                    <span
                      className="ch-ignored-badge"
                      title="Messages ignored from unauthorized users or invalid approval responses"
                    >
                      Ignored: {telegram.ignored}
                    </span>
                  </div>
                </div>
                <label className="ch-switch-label">
                  <strong>Enable</strong>
                  <input
                    type="checkbox"
                    role="switch"
                    className="dlg-sr"
                    checked={telegramDraft.enabled}
                    onChange={(e) =>
                      updateDraft('telegram', { enabled: e.target.checked })
                    }
                  />
                  <span className="dlg-switch-track" aria-hidden="true" />
                </label>
              </div>

              {telegram.failure && (
                <div
                  className="dlg-error ch-failure-box"
                  role="alert"
                  aria-live="polite"
                >
                  <CircleAlert size={16} aria-hidden="true" />
                  <span>Connection failure: {telegram.failure}</span>
                </div>
              )}

              <div className="ch-field-group">
                <label className="dlg-label" htmlFor="telegram-dot-select">
                  Assigned Dot
                </label>
                <select
                  id="telegram-dot-select"
                  className="dlg-input dlg-select"
                  value={telegramDraft.dotId}
                  onChange={(e) =>
                    updateDraft('telegram', { dotId: e.target.value })
                  }
                >
                  <option value="">Choose a Dot</option>
                  {dots.map((dot) => (
                    <option key={dot.id} value={dot.id}>
                      {dot.name}
                    </option>
                  ))}
                </select>
                <p className="dlg-hint">
                  The Dot that receives messages and replies in Telegram.
                </p>
              </div>

              <div className="ch-field-group">
                <div className="ch-token-header">
                  <label
                    className="dlg-label"
                    htmlFor="telegram-bot-token-input"
                  >
                    Bot Token
                  </label>
                  <div className="ch-token-status">
                    <span
                      className={`ch-token-badge ${telegram.botTokenSet ? 'is-set' : ''}`}
                    >
                      {telegram.botTokenSet ? 'Set' : 'Not set'}
                    </span>
                    {telegram.botTokenSet && !telegramDraft.clearBotToken && (
                      <button
                        type="button"
                        className="ch-clear-btn"
                        disabled={saving.telegram}
                        onClick={() =>
                          updateDraft('telegram', { clearBotToken: true })
                        }
                      >
                        Clear saved token
                      </button>
                    )}
                    {telegramDraft.clearBotToken && (
                      <span className="ch-clear-notice">
                        Will be cleared on save
                        <button
                          type="button"
                          className="ch-undo-btn"
                          disabled={saving.telegram}
                          onClick={() =>
                            updateDraft('telegram', { clearBotToken: false })
                          }
                        >
                          Keep token
                        </button>
                      </span>
                    )}
                  </div>
                </div>
                <input
                  id="telegram-bot-token-input"
                  type="password"
                  autoComplete="new-password"
                  className="dlg-input"
                  placeholder={
                    telegramDraft.clearBotToken
                      ? 'Token will be cleared on save'
                      : telegram.botTokenSet
                        ? '••••••••  (blank preserves stored token)'
                        : '123456:ABC-DEF...'
                  }
                  disabled={telegramDraft.clearBotToken}
                  value={telegramDraft.botTokenInput}
                  onChange={(e) =>
                    updateDraft('telegram', {
                      botTokenInput: e.target.value,
                      clearBotToken: false,
                    })
                  }
                />
                <p className="dlg-hint">
                  Telegram Bot API token from @BotFather. Blank input preserves
                  current token.
                </p>
              </div>

              <div className="ch-field-group">
                <label
                  className="dlg-label"
                  htmlFor="telegram-owner-user-ids-input"
                >
                  Allowed Owner User IDs (numeric)
                </label>
                <textarea
                  id="telegram-owner-user-ids-input"
                  className="dlg-input dlg-textarea"
                  rows={2}
                  placeholder="123456789, 987654321"
                  value={telegramDraft.ownerUserIdsText}
                  onChange={(e) =>
                    updateDraft('telegram', {
                      ownerUserIdsText: e.target.value,
                    })
                  }
                />
                <p className="dlg-hint">
                  Telegram numeric user IDs of authorized owners. Comma or
                  newline separated.
                </p>
              </div>

              <div className="ch-field-group">
                <label className="dlg-label" htmlFor="telegram-chat-id-input">
                  Allowed Chat ID (optional)
                </label>
                <input
                  id="telegram-chat-id-input"
                  type="text"
                  className="dlg-input"
                  placeholder="e.g. 123456789 or -1001234567890"
                  value={telegramDraft.chatId}
                  onChange={(e) =>
                    updateDraft('telegram', { chatId: e.target.value })
                  }
                />
                <p className="dlg-hint">
                  Chat-only authorization is allowed only for the owner&rsquo;s
                  private positive-ID DM; groups need explicit user IDs.
                </p>
              </div>

              <div className="ch-card-footer">
                <div className="ch-feedback">
                  {success.telegram && (
                    <span className="ch-success-text" role="status">
                      <Check size={16} aria-hidden="true" />
                      <span>{success.telegram}</span>
                    </span>
                  )}
                  {error.telegram && (
                    <span className="ch-error-text" role="alert">
                      <CircleAlert size={16} aria-hidden="true" />
                      <span>{error.telegram}</span>
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="dlg-btn dlg-primary"
                  disabled={saving.telegram}
                  onClick={() => void saveChannel('telegram')}
                >
                  {saving.telegram ? (
                    <>
                      <LoaderCircle
                        size={14}
                        className="cx-spin"
                        aria-hidden="true"
                      />
                      <span>Saving…</span>
                    </>
                  ) : (
                    'Save Telegram'
                  )}
                </button>
              </div>
            </fieldset>
          </section>
        </div>
      )}
    </div>
  );
}
