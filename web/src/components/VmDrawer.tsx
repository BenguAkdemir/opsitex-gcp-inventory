import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, toDisplayError, type DisplayError } from '../api/client';
import type { InventoryWarning, NormalizedVm, ScopeLevel } from '../api/types';
import { absoluteTime, duration, formatMemory, relativeTime, shortScope } from '../lib/format';
import { Check, CopyButton, StateBadge } from './primitives';

interface Props {
  vm: NormalizedVm;
  now: number;
  onClose: () => void;
}

type Detail =
  | { status: 'loading' }
  | { status: 'fresh'; vm: NormalizedVm; fetchedAt: string; warnings: InventoryWarning[] }
  | { status: 'error'; error: DisplayError };

const SCOPE_EXPLANATION: Record<ScopeLevel, string> = {
  full: 'cloud-platform: VM içindeki her süreç, service account\'un IAM rolünün izin verdiği tüm API\'leri çağırabilir. Sınırı sadece IAM çizer.',
  default: 'Console\'daki "Allow default access" seti: Storage okuma, Logging/Monitoring yazma gibi dar izinler. Compute API\'ye erişim yok.',
  custom: 'Elle seçilmiş scope listesi.',
  none: 'VM\'e takılı bir kimlik yok: içinden GCP API\'leri çağrılamaz.',
};

export function VmDrawer({ vm: listVm, now, onClose }: Props) {
  const [detail, setDetail] = useState<Detail>({ status: 'loading' });
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    setDetail({ status: 'loading' });
    api
      .vm(listVm.zone, listVm.name, controller.signal)
      .then((res) => setDetail({ status: 'fresh', vm: res.vm, fetchedAt: res.fetchedAt, warnings: res.warnings }))
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setDetail({ status: 'error', error: toDisplayError(err) });
      });
    return () => controller.abort();
  }, [listVm.zone, listVm.name]);

  const vm = detail.status === 'fresh' ? detail.vm : listVm;

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
        <header className="drawer-header">
          <div className="drawer-title">
            <h2 id="drawer-title">{vm.name}</h2>
            <div style={{ display: 'flex', gap: 8 }}>
              <a className="btn" href={vm.consoleUrl} target="_blank" rel="noreferrer">
                Console'da aç ↗
              </a>
              <button ref={closeRef} type="button" className="btn btn-ghost" onClick={onClose} aria-label="Kapat">
                ✕
              </button>
            </div>
          </div>
          <div className="drawer-meta">
            <StateBadge state={vm.state} providerState={vm.providerState} />
            <span>·</span>
            <span>{vm.zone}</span>
            <span>·</span>
            <span className="mono">{vm.machine.type}</span>
            {vm.scheduling.provisioningModel === 'spot' && <span className="chip">spot</span>}
          </div>
          <DetailStatus detail={detail} now={now} />
        </header>

        <div className="drawer-body">
          <Section title="Genel">
            <Facts
              rows={[
                ['Instance ID', <IdValue value={vm.providerId} />],
                ['Envanter ID', <IdValue value={vm.id} />],
                ['Açıklama', vm.description ?? <span className="muted">—</span>],
                ['Konum', `${vm.zone} (${vm.region})`],
                ['Oluşturulma', <TimeValue iso={vm.timestamps.createdAt} now={now} />],
                ['Son başlatma', <TimeValue iso={vm.timestamps.lastStartedAt} now={now} />],
                ['Son durdurma', <TimeValue iso={vm.timestamps.lastStoppedAt} now={now} />],
                [
                  'Çalışma süresi',
                  vm.state === 'running' ? duration(vm.timestamps.lastStartedAt, now) : <span className="muted">Çalışmıyor</span>,
                ],
              ]}
            />
          </Section>

          <Section title="Makine">
            <Facts
              rows={[
                ['Machine type', <span className="mono">{vm.machine.type}</span>],
                [
                  'vCPU / RAM',
                  vm.machine.vcpus === null ? (
                    <span className="muted">Bilinmiyor (machine type bilgisi alınamadı)</span>
                  ) : (
                    <>
                      {vm.machine.vcpus} vCPU · {formatMemory(vm.machine.memoryMb)}
                      {vm.machine.sharedCpu && (
                        <div className="note">Shared-core: vCPU sayısı sürekli değil, kısa süreli burst kapasitesi.</div>
                      )}
                    </>
                  ),
                ],
                [
                  'CPU platform',
                  vm.machine.cpuPlatform ?? <span className="muted">— (durmuş VM'e fiziksel host atanmaz)</span>,
                ],
                [
                  'Provisioning',
                  vm.scheduling.provisioningModel === 'spot' ? (
                    <>
                      Spot
                      <div className="note">
                        Google kapasite gerektiğinde durdurabilir.
                        {vm.scheduling.terminationAction === 'STOP' && ' Termination action STOP: VM silinmez, durdurulur.'}
                        {vm.scheduling.terminationAction === 'DELETE' && ' Termination action DELETE: VM geri alındığında silinir.'}
                      </div>
                    </>
                  ) : vm.scheduling.provisioningModel === 'standard' ? (
                    'Standard'
                  ) : (
                    <span className="muted">Bilinmiyor</span>
                  ),
                ],
                ['Host bakımında', vm.scheduling.onHostMaintenance ?? '—'],
                ['Otomatik yeniden başlatma', <Check value={vm.scheduling.automaticRestart} yes="Açık" no="Kapalı" />],
              ]}
            />
          </Section>

          <Section title="İşletim sistemi">
            <Facts
              rows={[
                ['OS', vm.os.name ?? <span className="muted">—</span>],
                ['Lisans', vm.os.license ? <span className="mono">{vm.os.license}</span> : <span className="muted">—</span>],
                ['Mimari', vm.os.architecture ?? <span className="muted">—</span>],
              ]}
            />
          </Section>

          <Section title="Ağ">
            <table className="mini-table">
              <thead>
                <tr>
                  <th>NIC</th>
                  <th>Network / subnet</th>
                  <th>İç IP</th>
                  <th>Dış IP</th>
                  <th>Tier</th>
                </tr>
              </thead>
              <tbody>
                {vm.network.interfaces.map((nic) => (
                  <tr key={nic.name}>
                    <td className="mono">{nic.name}</td>
                    <td>
                      {nic.network ?? '—'} / {nic.subnet ?? '—'}
                    </td>
                    <td className="mono">{nic.privateIp ?? '—'}</td>
                    <td className="mono">{nic.publicIp ?? '—'}</td>
                    <td>{nic.networkTier ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ marginTop: 10 }}>
              <Facts
                rows={[
                  [
                    'Network tag\'ler',
                    vm.network.tags.length > 0 ? (
                      <>
                        {vm.network.tags.map((t) => (
                          <span key={t} className="chip mono" style={{ marginRight: 4 }}>
                            {t}
                          </span>
                        ))}
                        <div className="note">Firewall kuralları bu tag'lere göre hedeflenir (label değil).</div>
                      </>
                    ) : (
                      <span className="muted">yok</span>
                    ),
                  ],
                  ['IP forwarding', <Check value={vm.network.ipForwarding} yes="Açık" no="Kapalı" />],
                ]}
              />
            </div>
          </Section>

          <Section title="Diskler">
            <table className="mini-table">
              <thead>
                <tr>
                  <th>Ad</th>
                  <th>Boot</th>
                  <th>Boyut</th>
                  <th>Mod</th>
                  <th>VM ile silinir</th>
                </tr>
              </thead>
              <tbody>
                {vm.disks.map((d) => (
                  <tr key={d.name}>
                    <td className="mono">{d.name}</td>
                    <td>{d.boot ? 'Evet' : 'Hayır'}</td>
                    <td className="num">{d.sizeGb === null ? '—' : `${d.sizeGb} GB`}</td>
                    <td>{d.mode ?? '—'}</td>
                    <td>{d.autoDelete ? 'Evet' : 'Hayır'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section title="Kimlik (VM'e takılı service account)">
            <Facts
              rows={[
                [
                  'Service account',
                  vm.identity.serviceAccount ? (
                    <>
                      <span className="mono">{vm.identity.serviceAccount}</span>
                      {vm.identity.isDefaultServiceAccount && (
                        <div className="note">Compute Engine default service account: projede genellikle Editor rolüne sahiptir.</div>
                      )}
                    </>
                  ) : (
                    <span className="muted">Yok</span>
                  ),
                ],
                [
                  'Scope seviyesi',
                  <>
                    <span className="chip">{vm.identity.scopeLevel}</span>
                    <div className="note">{SCOPE_EXPLANATION[vm.identity.scopeLevel]}</div>
                  </>,
                ],
                [
                  'Scope\'lar',
                  vm.identity.scopes.length > 0 ? (
                    <div className="labels" style={{ maxWidth: 'none' }}>
                      {vm.identity.scopes.map((s) => (
                        <span key={s} className="chip mono">
                          {shortScope(s)}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="muted">yok</span>
                  ),
                ],
              ]}
            />
            <div className="note" style={{ marginTop: 8 }}>
              Etkin yetki = IAM rolü ∩ scope. Bu servis IAM policy'sini okuma yetkisine sahip değil; rolü değil, sadece
              VM'e takılı kimliği ve scope'u görür.
            </div>
          </Section>

          <Section title="Güvenlik ayarları">
            <Facts
              rows={[
                ['Secure Boot', <Check value={vm.security.secureBoot} yes="Açık" no="Kapalı" />],
                ['vTPM', <Check value={vm.security.vtpm} yes="Açık" no="Kapalı" />],
                ['Integrity monitoring', <Check value={vm.security.integrityMonitoring} yes="Açık" no="Kapalı" />],
                ['Confidential VM', <Check value={vm.security.confidentialCompute} yes="Açık" no="Kapalı" />],
                ['Silme koruması', <Check value={vm.security.deletionProtection} yes="Açık" no="Kapalı" />],
              ]}
            />
          </Section>

          <Section title="Label'lar">
            <LabelList labels={vm.labels} empty="Kullanıcı label'ı yok." />
            {Object.keys(vm.systemLabels).length > 0 && (
              <>
                <div className="note" style={{ margin: '10px 0 4px' }}>
                  Sistem label'ları (goog-, GCP servisleri ekler):
                </div>
                <LabelList labels={vm.systemLabels} empty="" />
              </>
            )}
          </Section>
        </div>
      </aside>
    </>
  );
}

function DetailStatus({ detail, now }: { detail: Detail; now: number }) {
  if (detail.status === 'loading') {
    return (
      <div className="inline-status">
        <span className="spinner" aria-hidden="true" /> GCP'den güncel hali alınıyor…
      </div>
    );
  }
  if (detail.status === 'error') {
    return (
      <div className="inline-status" role="alert">
        <span className="dot dot-critical" aria-hidden="true" />
        <span>
          <strong>{detail.error.title}.</strong> {detail.error.detail} Liste verisi gösteriliyor.
        </span>
      </div>
    );
  }
  return (
    <>
      <div className="inline-status">
        <span className="dot dot-good" aria-hidden="true" /> GCP'den güncel hali alındı ({relativeTime(detail.fetchedAt, now)})
      </div>
      {detail.warnings.map((w) => (
        <div key={w.scope} className="inline-status">
          <span className="dot dot-warning" aria-hidden="true" />
          {w.message}
        </div>
      ))}
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="facts">
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'contents' }}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function IdValue({ value }: { value: string }) {
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <span className="mono">{value}</span>
      <CopyButton value={value} />
    </span>
  );
}

function TimeValue({ iso, now }: { iso: string | null; now: number }) {
  if (!iso) return <span className="muted">—</span>;
  return (
    <span title={iso}>
      {absoluteTime(iso)} <span className="muted">({relativeTime(iso, now)})</span>
    </span>
  );
}

function LabelList({ labels, empty }: { labels: Record<string, string>; empty: string }) {
  const entries = Object.entries(labels);
  if (entries.length === 0) return empty ? <span className="muted">{empty}</span> : null;
  return (
    <div className="labels" style={{ maxWidth: 'none' }}>
      {entries.map(([k, v]) => (
        <span key={k} className="chip mono">
          {k}={v}
        </span>
      ))}
    </div>
  );
}
