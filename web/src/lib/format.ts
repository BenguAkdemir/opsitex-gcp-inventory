import type { NormalizedVm } from '../api/types';

const LOCALE = 'tr-TR';
const relative = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
const absolute = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' });
const decimal = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const RELATIVE_STEPS: Array<[number, Intl.RelativeTimeFormatUnit]> = [
  [365 * DAY, 'year'],
  [30 * DAY, 'month'],
  [DAY, 'day'],
  [HOUR, 'hour'],
  [MINUTE, 'minute'],
];

export function relativeTime(iso: string | null, now: number): string {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - now;
  if (Math.abs(diff) < 45_000) return 'az önce';
  for (const [size, unit] of RELATIVE_STEPS) {
    if (Math.abs(diff) >= size) return relative.format(Math.round(diff / size), unit);
  }
  return relative.format(Math.round(diff / 1000), 'second');
}

export function absoluteTime(iso: string | null): string {
  return iso ? absolute.format(new Date(iso)) : '—';
}

export function duration(fromIso: string | null, now: number): string {
  if (!fromIso) return '—';
  const ms = Math.max(0, now - new Date(fromIso).getTime());
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  if (days > 0) return `${days} g ${hours} sa`;
  if (hours > 0) return `${hours} sa ${minutes} dk`;
  return `${minutes} dk`;
}

export function formatMemory(mb: number | null): string {
  if (mb === null) return '—';
  return `${decimal.format(mb / 1024)} GB`;
}

export function machineSummary(machine: NormalizedVm['machine']): string {
  if (machine.vcpus === null || machine.memoryMb === null) return 'vCPU/RAM bilinmiyor';
  const shared = machine.sharedCpu ? ' (shared)' : '';
  return `${machine.vcpus} vCPU${shared} · ${formatMemory(machine.memoryMb)}`;
}

export function shortScope(scope: string): string {
  return scope.replace('https://www.googleapis.com/auth/', '');
}
