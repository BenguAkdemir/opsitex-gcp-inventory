import { describe, expect, it } from 'vitest';
import { duration, formatMemory, machineSummary, relativeTime } from './format';

const now = Date.parse('2026-09-29T10:00:00Z');

describe('format', () => {
  it('göreli zamanı Türkçe yazar', () => {
    expect(relativeTime('2026-09-29T09:59:40Z', now)).toBe('az önce');
    expect(relativeTime('2026-09-29T07:00:00Z', now)).toBe('3 saat önce');
    expect(relativeTime('2026-09-26T10:00:00Z', now)).toBe('3 gün önce');
    expect(relativeTime(null, now)).toBe('—');
  });

  it('çalışma süresini gün/saat/dakika olarak yazar', () => {
    expect(duration('2026-09-29T09:15:00Z', now)).toBe('45 dk');
    expect(duration('2026-09-28T07:30:00Z', now)).toBe('1 g 2 sa');
  });

  it('shared-core tipi açıkça belirtir, bilinmeyen boyutu uydurmaz', () => {
    expect(machineSummary({ type: 'e2-micro', vcpus: 2, memoryMb: 1024, sharedCpu: true, cpuPlatform: null })).toBe('2 vCPU (shared) · 1 GB');
    expect(machineSummary({ type: 'e2-medium', vcpus: null, memoryMb: null, sharedCpu: null, cpuPlatform: null })).toBe('vCPU/RAM bilinmiyor');
    expect(formatMemory(614)).toBe('0,6 GB');
  });
});
