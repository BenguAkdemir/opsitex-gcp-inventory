import { useState, type ReactNode } from 'react';
import type { VmState } from '../api/types';

export const STATE_LABEL: Record<VmState, string> = {
  running: 'Çalışıyor',
  pending: 'Başlatılıyor',
  stopping: 'Durduruluyor',
  stopped: 'Durdurulmuş',
  suspended: 'Askıda',
  unknown: 'Bilinmiyor',
};

const STATE_DOT: Record<VmState, string> = {
  running: 'dot dot-good',
  pending: 'dot dot-warning dot-pulse',
  stopping: 'dot dot-warning dot-pulse',
  stopped: 'dot',
  suspended: 'dot',
  unknown: 'dot',
};

const PROVIDER_STATE_HINT: Record<string, string> = {
  TERMINATED: 'GCP\'de TERMINATED "durdurulmuş" demek, silinmiş değil. Disk ve ayarlar duruyor; CPU/RAM ücreti yazmaz.',
  SUSPENDED: 'Bellek içeriği diske yazılıp askıya alınmış.',
  REPAIRING: 'Google host arızası sonrası VM\'i onarıyor.',
};

export function StateBadge({ state, providerState }: { state: VmState; providerState: string }) {
  const hint = PROVIDER_STATE_HINT[providerState];
  return (
    <Tip
      content={
        <>
          GCP durumu: <strong>{providerState}</strong>
          {hint && <div style={{ marginTop: 4 }}>{hint}</div>}
        </>
      }
    >
      <span className="badge" tabIndex={0}>
        <span className={STATE_DOT[state]} aria-hidden="true" />
        {STATE_LABEL[state]}
      </span>
    </Tip>
  );
}

export function Tip({ content, children, align = 'center' }: { content: ReactNode; children: ReactNode; align?: 'center' | 'end' }) {
  return (
    <span className="tip">
      {children}
      <span className={`tip-body${align === 'end' ? ' tip-end' : ''}`} role="tooltip">
        {content}
      </span>
    </span>
  );
}

export function InfoTip({ label, children, align }: { label: string; children: ReactNode; align?: 'center' | 'end' }) {
  return (
    <Tip content={children} align={align}>
      <button type="button" className="info" aria-label={label}>
        i
      </button>
    </Tip>
  );
}

export function CopyButton({ value, label = 'Kopyala' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied('done');
    } catch {
      setCopied('failed');
    }
    setTimeout(() => setCopied('idle'), 1600);
  };
  const text = copied === 'done' ? 'Kopyalandı' : copied === 'failed' ? 'Kopyalanamadı' : label;
  return (
    <button type="button" className="btn btn-small" onClick={copy} aria-live="polite">
      {text}
    </button>
  );
}

export function CommandBlock({ command }: { command: string }) {
  return (
    <div className="command">
      <code>{command}</code>
      <CopyButton value={command} />
    </div>
  );
}

export function Check({ value, yes, no }: { value: boolean | null; yes: string; no: string }) {
  if (value === null) return <span className="muted">Bilinmiyor</span>;
  return (
    <span className={`check ${value ? 'check-yes' : 'check-no'}`}>
      <span aria-hidden="true">{value ? '✓' : '✕'}</span>
      {value ? yes : no}
    </span>
  );
}
