import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeInstance } from '../src/providers/gcp/gcp.normalizer';
import type { MachineTypeInfo } from '../src/domain/vm';

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(process.cwd(), 'test', 'fixtures', name), 'utf8'));

// CPU/RAM instance'ta yok; gerçek serviste machineTypes.get'ten gelir. Testte elle veriyoruz.
const machineTypes = new Map<string, MachineTypeInfo>([
  ['us-central1-a/e2-micro', { vcpus: 2, memoryMb: 1024, sharedCpu: true }],
]);

const ctx = { project: 'servicepark-case', machineTypes };

describe('normalizeInstance', () => {
  it('web-01 (running) golden output ile birebir aynı', () => {
    const raw = fixture('web-01.running.json');
    const expected = fixture('web-01.running.expected.json');
    expect(normalizeInstance(raw, ctx)).toEqual(expected);
  });

  it('SDK artığı hiçbir alanı dışarı sızdırmaz', () => {
    const json = JSON.stringify(normalizeInstance(fixture('web-01.running.json'), ctx));
    expect(json).not.toMatch(/"_\w+"/);      // _natIP gibi gölge alanlar
    expect(json).not.toContain('metadata');  // metadata ve izi
    expect(json).not.toContain('fingerprint');
    expect(json).not.toContain('selfLink');
  });
});
