export type ProviderName = 'gcp' | 'aws';
export type VmState = 'running' | 'pending' | 'stopping' | 'stopped' | 'suspended' | 'unknown';
export type ScopeLevel = 'full' | 'default' | 'custom' | 'none';

export interface MachineTypeInfo {
  vcpus: number;
  memoryMb: number;
  sharedCpu: boolean;
}

export interface NormalizedVm {
  id: string;
  provider: ProviderName;
  providerId: string;
  name: string;
  description: string | null;
  account: string;
  region: string;
  zone: string;
  state: VmState;
  providerState: string;
  machine: {
    type: string;
    vcpus: number | null;
    memoryMb: number | null;
    sharedCpu: boolean | null;
    cpuPlatform: string | null;
  };
  os: {
    name: string | null;
    family: string | null;
    license: string | null;
    architecture: string | null;
  };
  network: {
    privateIps: string[];
    publicIps: string[];
    interfaces: Array<{
      name: string;
      network: string | null;
      subnet: string | null;
      privateIp: string | null;
      publicIp: string | null;
      networkTier: string | null;
    }>;
    tags: string[];
    ipForwarding: boolean;
  };
  disks: Array<{
    name: string;
    boot: boolean;
    sizeGb: number | null;
    mode: string | null;
    autoDelete: boolean;
  }>;
  identity: {
    serviceAccount: string | null;
    isDefaultServiceAccount: boolean;
    scopeLevel: ScopeLevel;
    scopes: string[];
  };
  security: {
    secureBoot: boolean;
    vtpm: boolean;
    integrityMonitoring: boolean;
    confidentialCompute: boolean;
    deletionProtection: boolean;
  };
  scheduling: {
    provisioningModel: 'standard' | 'spot' | 'unknown';
    automaticRestart: boolean | null;
    onHostMaintenance: string | null;
    terminationAction: string | null;
  };
  labels: Record<string, string>;
  systemLabels: Record<string, string>;
  timestamps: {
    createdAt: string | null;
    lastStartedAt: string | null;
    lastStoppedAt: string | null;
  };
  consoleUrl: string;
}
