import type { ConnectionInfo } from '../api/types';
import { relativeTime, shortScope } from '../lib/format';
import { InfoTip, Tip } from './primitives';

interface Props {
  connection: ConnectionInfo | null;
  failed: boolean;
  loading: boolean;
  lastSuccessAt: string | null;
  now: number;
  onRefresh: () => void;
}

const KIND_LABEL: Record<ConnectionInfo['identity']['kind'], string> = {
  impersonated_service_account: 'impersonation',
  service_account: 'service account',
  external_account: 'workload identity',
  user: 'kullanıcı hesabı',
  unknown: 'bilinmeyen',
};

export function ConnectionBar({ connection, failed, loading, lastSuccessAt, now, onRefresh }: Props) {
  const status = loading && !connection ? 'checking' : failed || !connection ? 'down' : 'up';
  const mismatch = connection && !connection.identity.matchesExpected;

  return (
    <section className="card connection-bar" aria-label="GCP bağlantısı">
      <div className="connection-status">
        <span
          className={`dot ${status === 'up' ? 'dot-good' : status === 'down' ? 'dot-critical' : 'dot-warning dot-pulse'}`}
          aria-hidden="true"
        />
        {status === 'up' ? 'Bağlı' : status === 'down' ? 'Bağlantı yok' : 'Kontrol ediliyor'}
      </div>

      <dl className="connection-facts">
        <div>
          <dt>Kimlik</dt>
          <dd className="mono">{connection?.identity.principal ?? '—'}</dd>
          {connection && <span className="chip">{KIND_LABEL[connection.identity.kind]}</span>}
          {mismatch && (
            <Tip content={`Beklenen kimlik: ${connection.identity.expectedPrincipal}`}>
              <span className="chip chip-warn" tabIndex={0}>
                beklenenden farklı
              </span>
            </Tip>
          )}
          <InfoTip label="Kimlik hakkında">
            Servis GCP'ye kişisel hesapla değil, bu service account'un kısa ömürlü token'ıyla gider. Yetkisi sadece
            okuma: compute.instances.list/get ve compute.machineTypes.get.
          </InfoTip>
        </div>
        <div>
          <dt>Token scope</dt>
          <dd className="mono">{connection ? connection.scopes.map(shortScope).join(', ') : '—'}</dd>
        </div>
        <div>
          <dt>Proje</dt>
          <dd className="mono">{connection?.account ?? '—'}</dd>
        </div>
        <div>
          <dt>Son senkron</dt>
          <dd title={lastSuccessAt ?? undefined}>{lastSuccessAt ? relativeTime(lastSuccessAt, now) : '—'}</dd>
        </div>
      </dl>

      <button type="button" className="btn" onClick={onRefresh} disabled={loading}>
        {loading ? <span className="spinner" aria-hidden="true" /> : <span aria-hidden="true">↻</span>}
        {loading ? 'Yenileniyor' : 'Yenile'}
      </button>
    </section>
  );
}
