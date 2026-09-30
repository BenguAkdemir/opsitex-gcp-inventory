import type { InventoryWarning } from '../api/types';
import { CommandBlock } from './primitives';

const CODE_HINT: Record<string, string> = {
  UNREACHABLE: 'Bu zone şu an yanıt vermiyor; oradaki VM\'ler listede olmayabilir.',
  NORMALIZE_FAILED: 'Bu VM\'in verisi beklenen formatta değil; atlandı, sunucu loguna kaydedildi.',
};

export function WarningsBanner({ warnings }: { warnings: InventoryWarning[] }) {
  if (warnings.length === 0) return null;
  const count = (match: (w: InventoryWarning) => boolean) => warnings.filter(match).length;
  const unreachable = count((w) => w.code === 'UNREACHABLE');
  const machineTypes = count((w) => w.scope.startsWith('machineTypes/'));
  const skipped = count((w) => w.code === 'NORMALIZE_FAILED');
  const other = warnings.length - unreachable - machineTypes - skipped;
  const parts = [
    unreachable > 0 && `${unreachable} zone okunamadı`,
    machineTypes > 0 && `${machineTypes} machine type için vCPU/RAM alınamadı`,
    skipped > 0 && `${skipped} VM listelenemedi`,
    other > 0 && `${other} diğer uyarı`,
  ].filter(Boolean);
  const summary = `${unreachable > 0 || skipped > 0 ? 'Liste eksik olabilir' : 'Bazı bilgiler eksik'}: ${parts.join(' · ')}`;

  return (
    <section className="card warnings" aria-live="polite">
      <details>
        <summary>{summary}</summary>
        <ul>
          {warnings.map((w) => (
            <li key={`${w.scope}-${w.code}`}>
              <div>
                <span className="chip mono">{w.code}</span> <code>{w.scope}</code>
              </div>
              <div>{w.message || CODE_HINT[w.code] || 'Ayrıntı yok.'}</div>
              {w.message && CODE_HINT[w.code] && <div className="note">{CODE_HINT[w.code]}</div>}
              {w.command && <CommandBlock command={w.command} />}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
