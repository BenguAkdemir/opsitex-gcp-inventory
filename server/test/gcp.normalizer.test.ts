import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeInstance } from '../src/providers/gcp/gcp.normalizer';
import type { MachineTypeInfo } from '../src/domain/vm';

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(process.cwd(), 'test', 'fixtures', name), 'utf8'));

const machineTypes = new Map<string, MachineTypeInfo>([
  ['us-central1-a/e2-micro', { vcpus: 2, memoryMb: 1024, sharedCpu: true }],
  ['us-central1-b/e2-micro', { vcpus: 2, memoryMb: 1024, sharedCpu: true }],
  ['us-central1-a/e2-standard-2', { vcpus: 2, memoryMb: 8192, sharedCpu: false }],
]);

const ctx = { project: 'servicepark-case', machineTypes };

const normalize = (name: string) => normalizeInstance(fixture(name), ctx);

const synthetic = (mutate: (raw: any) => void) => {
  const raw = structuredClone(fixture('web-01.running.json'));
  mutate(raw);
  return normalizeInstance(raw, ctx);
};

describe('normalizeInstance', () => {
  it('web-01 (running) golden output ile birebir aynı', () => {
    const raw = fixture('web-01.running.json');
    const expected = fixture('web-01.running.expected.json');
    expect(normalizeInstance(raw, ctx)).toEqual(expected);
  });

  it.each([
    'web-01.running.json',
    'web-01.terminated.json',
    'app-01.terminated.json',
    'batch-01.terminated.json',
  ])('%s: SDK artığı hiçbir alanı dışarı sızdırmaz', (name) => {
    const json = JSON.stringify(normalize(name));
    expect(json).not.toMatch(/"_\w+"/);
    expect(json).not.toContain('metadata');
    expect(json).not.toContain('fingerprint');
    expect(json).not.toContain('selfLink');
    expect(json).not.toContain('shieldedInstanceInitialState');
  });
});

describe('web-01 (stopped)', () => {
  const vm = normalize('web-01.terminated.json');

  it('TERMINATED durdurulmuş demek, silinmiş değil', () => {
    expect(vm.state).toBe('stopped');
    expect(vm.providerState).toBe('TERMINATED');
  });

  it('accessConfig duruyor ama ephemeral IP bırakılmış', () => {
    expect(vm.network.publicIps).toEqual([]);
    expect(vm.network.interfaces[0]).toMatchObject({ publicIp: null, networkTier: 'PREMIUM' });
  });

  it('durmuş VM\'in "Unknown CPU Platform" değeri null olur', () => {
    expect(vm.machine.cpuPlatform).toBeNull();
  });
});

describe('app-01 (temiz baseline)', () => {
  const vm = normalize('app-01.terminated.json');

  it('service account yoksa kimlik boş ve scope seviyesi none', () => {
    expect(vm.identity).toEqual({
      serviceAccount: null,
      isDefaultServiceAccount: false,
      scopeLevel: 'none',
      scopes: [],
    });
  });

  it('dış IP yok', () => {
    expect(vm.network.publicIps).toEqual([]);
    expect(vm.network.interfaces[0].publicIp).toBeNull();
    expect(vm.network.interfaces[0].networkTier).toBeNull();
    expect(vm.network.privateIps).toEqual(['10.128.0.3']);
  });

  it('secure boot ve deletion protection açık', () => {
    expect(vm.security.secureBoot).toBe(true);
    expect(vm.security.deletionProtection).toBe(true);
  });

  it('kullanıcı label\'ları korunur, network tag yok', () => {
    expect(vm.labels).toEqual({ env: 'prod', team: 'backend', owner: 'bengu' });
    expect(vm.systemLabels).toEqual({});
    expect(vm.network.tags).toEqual([]);
  });
});

describe('batch-01 (spot, europe)', () => {
  const vm = normalize('batch-01.terminated.json');

  it('region zone\'dan türetilir', () => {
    expect(vm.zone).toBe('europe-west1-b');
    expect(vm.region).toBe('europe-west1');
  });

  it('spot ve zorunlu scheduling ayarları', () => {
    expect(vm.scheduling).toEqual({
      provisioningModel: 'spot',
      automaticRestart: false,
      onHostMaintenance: 'TERMINATE',
      terminationAction: 'STOP',
    });
  });

  it('console default scope seti "default" olarak etiketlenir', () => {
    expect(vm.identity.scopeLevel).toBe('default');
    expect(vm.identity.isDefaultServiceAccount).toBe(true);
    expect(vm.identity.scopes).toHaveLength(6);
  });

  it('ubuntu minimal lisansından okunur ad üretilir', () => {
    expect(vm.os).toEqual({
      name: 'Ubuntu 24.04 LTS (Minimal)',
      family: 'ubuntu',
      license: 'ubuntu-minimal-2404-lts',
      architecture: 'x86_64',
    });
  });

  it('machine type bilgisi gelmediyse tahmin edilmez', () => {
    expect(vm.machine).toEqual({
      type: 'e2-medium',
      vcpus: null,
      memoryMb: null,
      sharedCpu: null,
      cpuPlatform: null,
    });
  });
});

describe('synthetic: gerçek filoda olmayan dallar', () => {
  const machineTypeUrl = (type: string) =>
    `https://www.googleapis.com/compute/v1/projects/servicepark-case/zones/us-central1-a/machineTypes/${type}`;

  it('custom machine type API\'ye gitmeden isimden çözülür', () => {
    const vm = synthetic((raw) => (raw.machineType = machineTypeUrl('n2-custom-4-8192')));
    expect(vm.machine).toMatchObject({ type: 'n2-custom-4-8192', vcpus: 4, memoryMb: 8192, sharedCpu: false });
  });

  it('extended memory custom tip de çözülür', () => {
    const vm = synthetic((raw) => (raw.machineType = machineTypeUrl('e2-custom-2-15360-ext')));
    expect(vm.machine).toMatchObject({ vcpus: 2, memoryMb: 15360, sharedCpu: false });
  });

  it('shared olmayan predefined tip map\'ten gelir', () => {
    const vm = synthetic((raw) => (raw.machineType = machineTypeUrl('e2-standard-2')));
    expect(vm.machine).toMatchObject({ vcpus: 2, memoryMb: 8192, sharedCpu: false });
  });

  it('goog- label\'ları sistem label\'ı olarak ayrılır', () => {
    const vm = synthetic((raw) => (raw.labels = { env: 'prod', 'goog-gke-node': '', 'goog-ops-agent-policy': 'v2' }));
    expect(vm.labels).toEqual({ env: 'prod' });
    expect(vm.systemLabels).toEqual({ 'goog-gke-node': '', 'goog-ops-agent-policy': 'v2' });
  });

  it('birden çok NIC ve accessConfig\'in hepsi toplanır', () => {
    const vm = synthetic((raw) => {
      const second = structuredClone(raw.networkInterfaces[0]);
      second.name = 'nic1';
      second.networkIP = '10.130.0.5';
      second.accessConfigs = [{ natIP: '34.1.1.1' }, { natIP: '34.2.2.2' }];
      raw.networkInterfaces.push(second);
    });
    expect(vm.network.privateIps).toEqual(['10.128.0.2', '10.130.0.5']);
    expect(vm.network.publicIps).toEqual(['35.254.243.8', '34.1.1.1', '34.2.2.2']);
    expect(vm.network.interfaces.map((i) => i.publicIp)).toEqual(['35.254.243.8', '34.1.1.1']);
  });

  it('tanınmayan status unknown olur, ham değer kaybolmaz', () => {
    const vm = synthetic((raw) => (raw.status = 'SOME_FUTURE_STATUS'));
    expect(vm.state).toBe('unknown');
    expect(vm.providerState).toBe('SOME_FUTURE_STATUS');
  });

  it('eski tip preemptible VM spot sayılır', () => {
    const vm = synthetic((raw) => (raw.scheduling = { preemptible: true, automaticRestart: false }));
    expect(vm.scheduling.provisioningModel).toBe('spot');
  });

  it('bilinmeyen provisioning model sessizce standard yapılmaz', () => {
    const vm = synthetic((raw) => (raw.scheduling.provisioningModel = 'FLEX_START'));
    expect(vm.scheduling.provisioningModel).toBe('unknown');
  });

  it('automaticRestart gelmezse false değil null olur', () => {
    const vm = synthetic((raw) => delete raw.scheduling.automaticRestart);
    expect(vm.scheduling.automaticRestart).toBeNull();
  });

  it('default setten farklı scope listesi custom olur', () => {
    const vm = synthetic((raw) => (raw.serviceAccounts[0].scopes = ['https://www.googleapis.com/auth/logging.write']));
    expect(vm.identity.scopeLevel).toBe('custom');
  });

  it('tanınmayan lisans ham adıyla gösterilir', () => {
    const vm = synthetic((raw) => {
      raw.disks[0].licenses = [
        'https://www.googleapis.com/compute/v1/projects/windows-cloud/global/licenses/windows-server-2022-dc',
      ];
    });
    expect(vm.os).toMatchObject({ name: 'windows-server-2022-dc', family: 'windows' });
  });

  it('birden çok lisansta OS ailesi bilinen lisans seçilir', () => {
    const vm = synthetic((raw) => {
      raw.disks[0].licenses = [
        'https://www.googleapis.com/compute/v1/projects/some-vendor/global/licenses/agent-addon',
        'https://www.googleapis.com/compute/v1/projects/debian-cloud/global/licenses/debian-12-bookworm',
      ];
    });
    expect(vm.os).toMatchObject({ name: 'Debian 12 (bookworm)', family: 'debian' });
  });

  it('int64 alan sayı olarak gelse de doğru çevrilir', () => {
    const vm = synthetic((raw) => (raw.disks[0].diskSizeGb = 250));
    expect(vm.disks[0].sizeGb).toBe(250);
  });

  it('geçersiz timestamp null olur', () => {
    const vm = synthetic((raw) => (raw.lastStopTimestamp = 'not-a-date'));
    expect(vm.timestamps.lastStoppedAt).toBeNull();
  });

  it.each(['id', 'name', 'zone'])('kimlik alanı %s yoksa hata fırlatır', (field) => {
    expect(() => synthetic((raw) => delete raw[field])).toThrow(`missing required field "${field}"`);
  });
});
