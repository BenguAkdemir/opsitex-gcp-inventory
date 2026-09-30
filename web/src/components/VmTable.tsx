import type { NormalizedVm } from '../api/types';
import { absoluteTime, duration, machineSummary, relativeTime } from '../lib/format';
import { StateBadge, Tip } from './primitives';

interface Props {
  vms: NormalizedVm[];
  selectedId: string | null;
  onSelect: (vm: NormalizedVm) => void;
  now: number;
}

const COLUMNS = ['Ad', 'Durum', 'Zone', 'Makine', 'İç IP', 'Dış IP', 'OS', 'Çalışma', "Label'lar"];

export function VmTable({ vms, selectedId, onSelect, now }: Props) {
  return (
    <div className="card table-card">
      <table className="vms">
        <caption className="visually-hidden">Sanal makineler</caption>
        <thead>
          <tr>
            {COLUMNS.map((label) => (
              <th key={label} scope="col">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {vms.map((vm) => (
            <VmRow key={vm.id} vm={vm} selected={vm.id === selectedId} onSelect={onSelect} now={now} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VmRow({ vm, selected, onSelect, now }: { vm: NormalizedVm; selected: boolean; onSelect: (vm: NormalizedVm) => void; now: number }) {
  const labels = Object.entries(vm.labels);

  return (
    <tr
      className={selected ? 'selected' : undefined}
      tabIndex={0}
      aria-label={`${vm.name} ayrıntıları`}
      onClick={() => onSelect(vm)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(vm);
        }
      }}
    >
      <td className="col-name">
        <div className="cell-main">
          {vm.name}
          {vm.scheduling.provisioningModel === 'spot' && (
            <Tip content="Spot VM: Google kapasite gerektiğinde önceden haber vermeden durdurabilir. Durmuş görünmesi beklenen bir durum olabilir.">
              <span className="chip" tabIndex={0}>
                spot
              </span>
            </Tip>
          )}
        </div>
        {vm.description && <div className="cell-sub description">{vm.description}</div>}
      </td>
      <td className="nowrap">
        <StateBadge state={vm.state} providerState={vm.providerState} />
      </td>
      <td className="nowrap">
        <div>{vm.zone}</div>
        <div className="cell-sub">{vm.region}</div>
      </td>
      <td className="nowrap">
        <div className="mono">{vm.machine.type}</div>
        <div className="cell-sub">{machineSummary(vm.machine)}</div>
      </td>
      <td className="mono num nowrap">{vm.network.privateIps.join(', ') || <span className="muted">—</span>}</td>
      <td className="mono num nowrap">
        {vm.network.publicIps.length > 0 ? (
          vm.network.publicIps.join(', ')
        ) : vm.state !== 'running' && vm.network.interfaces.some((i) => i.networkTier !== null) ? (
          <Tip content="Bu VM'de dış IP yapılandırması var ama durdurulmuş: ephemeral IP stop'ta bırakılır, start'ta farklı bir IP gelebilir.">
            <span className="muted" tabIndex={0}>
              — (stop'ta bırakıldı)
            </span>
          </Tip>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="col-os">{vm.os.name ?? <span className="muted">—</span>}</td>
      <td className="nowrap">
        {vm.state === 'running' ? (
          <>
            <div className="num">{duration(vm.timestamps.lastStartedAt, now)}</div>
            <div className="cell-sub" title={absoluteTime(vm.timestamps.lastStartedAt)}>
              başladı {relativeTime(vm.timestamps.lastStartedAt, now)}
            </div>
          </>
        ) : (
          <>
            <div className="muted">çalışmıyor</div>
            <div className="cell-sub" title={absoluteTime(vm.timestamps.lastStoppedAt)}>
              {vm.timestamps.lastStoppedAt ? `durdu ${relativeTime(vm.timestamps.lastStoppedAt, now)}` : '—'}
            </div>
          </>
        )}
      </td>
      <td>
        {labels.length > 0 ? (
          <div className="labels">
            {labels.map(([k, v]) => (
              <span key={k} className="chip mono">
                {k}={v}
              </span>
            ))}
          </div>
        ) : (
          <span className="muted">yok</span>
        )}
      </td>
    </tr>
  );
}
