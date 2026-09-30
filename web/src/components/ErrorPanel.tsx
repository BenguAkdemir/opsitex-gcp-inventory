import type { DisplayError } from '../api/client';
import { CommandBlock, CopyButton } from './primitives';

interface Props {
  error: DisplayError;
  onRetry: () => void;
  retrying: boolean;
  compact?: boolean;
  staleSince?: string | null;
}

export function ErrorPanel({ error, onRetry, retrying, compact = false, staleSince = null }: Props) {
  return (
    <section className={`card panel error-panel${compact ? ' compact' : ''}`} role="alert" aria-live="assertive">
      <div className="error-head">
        <div>
          <h2>{error.title}</h2>
          {staleSince && (
            <p style={{ marginTop: 4 }}>
              Son yenileme başarısız. Aşağıdaki liste {staleSince} alınan son başarılı sonuç; güncel olmayabilir.
            </p>
          )}
        </div>
        <span className="chip mono">{error.code}</span>
      </div>

      <p>{error.detail}</p>
      {error.action && <p className="action">{error.action}</p>}
      {error.command && <CommandBlock command={error.command} />}

      <div className="error-footer">
        <button type="button" className="btn btn-primary" onClick={onRetry} disabled={retrying}>
          {retrying && <span className="spinner" aria-hidden="true" />}
          {error.retryable ? 'Tekrar dene' : 'Düzelttim, tekrar dene'}
        </button>
        {error.docsUrl && (
          <a href={error.docsUrl} target="_blank" rel="noreferrer">
            Dokümantasyon ↗
          </a>
        )}
        {error.requestId && (
          <span className="inline-status">
            requestId <code>{error.requestId}</code>
            <CopyButton value={error.requestId} />
          </span>
        )}
      </div>
    </section>
  );
}
