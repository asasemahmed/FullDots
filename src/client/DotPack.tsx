import { useState } from 'react';
import { authHeaders } from './api';
import {
  DOT_PACK_MAX_CHARS,
  dotPackProblem,
  dotPackSchema,
  type DotPack,
} from '../shared/dot-pack';
import type { ApprovalMode, Dot } from '../shared/types';

const APPROVAL_LABEL: Record<ApprovalMode, string> = {
  sensitive: 'Sensitive: ask before risky actions',
  writes: 'Writes: ask before anything that changes data',
  off: 'Off',
};

/** What the import preview shows. A pack's "off" starts as Sensitive, so the preview says so. */
export function packSummary(pack: DotPack) {
  const rulesSet = Object.values(pack.rules).filter(
    (rule) => rule && rule !== 'inherit',
  ).length;
  const approval: ApprovalMode =
    pack.approvalMode === 'off' ? 'sensitive' : pack.approvalMode;
  return {
    name: pack.name,
    instructions: pack.instructions,
    rulesSet,
    approval,
    approvalLabel: APPROVAL_LABEL[approval],
    approvalNote:
      pack.approvalMode === 'off'
        ? 'The pack asks for Off. A pack cannot turn approvals off, so the Dot starts on Sensitive.'
        : undefined,
    prompts: pack.prompts.length,
  };
}

/** The checks the panel runs on a chosen file, before the owner sees a preview. */
export function readPackText(
  text: string,
): { ok: true; raw: unknown; pack: DotPack } | { ok: false; error: string } {
  if (text.length > DOT_PACK_MAX_CHARS)
    return {
      ok: false,
      error: 'This pack is too large. A Dot pack is at most 200 KB.',
    };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'This file is not valid JSON.' };
  }
  const parsed = dotPackSchema.safeParse(raw);
  if (!parsed.success)
    return { ok: false, error: dotPackProblem(parsed.error) };
  return { ok: true, raw, pack: parsed.data };
}

async function errorMessage(response: Response): Promise<string> {
  const data = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  return data?.error ?? `The export failed (${response.status}).`;
}

/** Saves the Dot as a pack file. Nothing is sent anywhere but the browser's download. */
export function ExportDotButton({ dot }: { dot: Dot }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const exportPack = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/dots/${dot.id}/pack`, {
        headers: authHeaders(),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const named = /filename="([^"]+)"/.exec(
        response.headers.get('content-disposition') ?? '',
      );
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = named?.[1] ?? 'dot.dot-pack.json';
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'The export did not work.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="dlg-pack-export">
      <button
        type="button"
        className="dlg-btn"
        disabled={busy}
        onClick={() => void exportPack()}
      >
        {busy ? 'Exporting…' : 'Export'}
      </button>
      {error && (
        <span className="dlg-hint" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

/**
 * Creates a Dot from a pack file. The file is checked here and again on the server; the owner sees
 * the preview and presses the button before anything is created.
 */
export function ImportDotPanel({
  mutate,
  onImported,
}: {
  mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
  onImported: () => void;
}) {
  const [loaded, setLoaded] = useState<{ raw: unknown; pack: DotPack } | null>(
    null,
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const read = async (file: File | undefined) => {
    setLoaded(null);
    setError('');
    if (!file) return;
    // Size first: a huge file is not read into memory.
    if (file.size > DOT_PACK_MAX_CHARS) {
      setError('This pack is too large. A Dot pack is at most 200 KB.');
      return;
    }
    const result = readPackText(await file.text());
    if (!result.ok) setError(result.error);
    else setLoaded({ raw: result.raw, pack: result.pack });
  };

  const create = async () => {
    if (!loaded) return;
    setBusy(true);
    setError('');
    const ok = await mutate('/dots/import-pack', 'POST', loaded.raw);
    setBusy(false);
    if (ok) onImported();
    else setError('The pack could not be imported. The reason is shown above.');
  };

  const summary = loaded ? packSummary(loaded.pack) : null;
  return (
    <section className="dlg-pack-import" aria-label="Import a Dot pack">
      <p className="dlg-hint">
        Have a Dot pack from another FullDots install? Choose the file to see
        what it creates. A pack never gives the new Dot connector or computer
        access.
      </p>
      <label className="dlg-pack-file">
        <span>Dot pack file</span>
        <input
          type="file"
          accept=".json,application/json"
          onChange={(event) => void read(event.target.files?.[0])}
        />
      </label>
      {error && (
        <p className="dlg-error" role="alert">
          {error}
        </p>
      )}
      {summary && (
        <div className="dlg-pack-preview">
          <dl>
            <dt>Name</dt>
            <dd>{summary.name}</dd>
            <dt>Role</dt>
            <dd className="dlg-pack-role">{summary.instructions}</dd>
            <dt>Rules set</dt>
            <dd>{summary.rulesSet}</dd>
            <dt>Approvals</dt>
            <dd>
              {summary.approvalLabel}
              {summary.approvalNote && (
                <span className="dlg-hint"> {summary.approvalNote}</span>
              )}
            </dd>
            <dt>Saved prompts</dt>
            <dd>{summary.prompts}</dd>
          </dl>
          <p className="dlg-hint">
            Creates a new Dot. It starts with no connector access, no computer
            access and the default model. Nothing else is changed.
          </p>
          <button
            type="button"
            className="dlg-btn dlg-primary"
            disabled={busy}
            onClick={() => void create()}
          >
            {busy ? 'Creating…' : 'Create this Dot'}
          </button>
        </div>
      )}
    </section>
  );
}
