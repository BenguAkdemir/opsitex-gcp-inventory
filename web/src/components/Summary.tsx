import type { NormalizedVm } from '../api/types';

export function summaryParts(vms: NormalizedVm[]): string[] {
  const count = (match: (vm: NormalizedVm) => boolean) => vms.filter(match).length;
  const running = count((vm) => vm.state === 'running');
  const stopped = count((vm) => vm.state === 'stopped');
  const other = vms.length - running - stopped;
  const exposed = count((vm) => vm.network.publicIps.length > 0);
  const unowned = count((vm) => !vm.labels.owner);

  return [
    `${running} çalışıyor`,
    `${stopped} durdurulmuş`,
    other > 0 ? `${other} geçişte` : null,
    exposed > 0 ? `${exposed} dış IP'li` : null,
    unowned > 0 ? `${unowned} VM'de owner label'ı yok` : null,
  ].filter((part): part is string => part !== null);
}

export function Summary({ vms }: { vms: NormalizedVm[] }) {
  return (
    <p className="summary">
      <strong>{vms.length} VM</strong>
      {summaryParts(vms).map((part) => (
        <span key={part}> · {part}</span>
      ))}
    </p>
  );
}
