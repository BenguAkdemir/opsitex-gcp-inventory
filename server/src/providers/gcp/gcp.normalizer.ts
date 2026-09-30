import type { protos } from '@google-cloud/compute';
import type { MachineTypeInfo, NormalizedVm, ScopeLevel, VmState } from '../../domain/vm';

type RawInstance = protos.google.cloud.compute.v1.IInstance;

export interface NormalizeContext {
  project: string;
  machineTypes: ReadonlyMap<string, MachineTypeInfo>;
}

export function machineTypeKey(zone: string, machineType: string): string {
  return `${zone}/${machineType}`;
}

const DEFAULT_SA_SUFFIX = '-compute@developer.gserviceaccount.com';
const SCOPE_PREFIX = 'https://www.googleapis.com/auth/';
const FULL_SCOPE = `${SCOPE_PREFIX}cloud-platform`;

const CONSOLE_DEFAULT_SCOPES = new Set(
  [
    'devstorage.read_only',
    'logging.write',
    'monitoring.write',
    'service.management.readonly',
    'servicecontrol',
    'trace.append',
  ].map((s) => SCOPE_PREFIX + s),
);

const STATE_MAP: Record<string, VmState> = {
  RUNNING: 'running',
  PROVISIONING: 'pending',
  STAGING: 'pending',
  PENDING: 'pending',
  REPAIRING: 'pending',
  PENDING_STOP: 'stopping',
  STOPPING: 'stopping',
  SUSPENDING: 'stopping',
  DEPROVISIONING: 'stopping',
  TERMINATED: 'stopped',  // GCP'de durdurulmuş; AWS'deki terminated (silinmiş) ile karışmasın
  STOPPED: 'stopped',
  SUSPENDED: 'suspended',
};

const OS_FAMILY_BY_IMAGE_PROJECT: Record<string, string> = {
  'debian-cloud': 'debian',
  'ubuntu-os-cloud': 'ubuntu',
  'ubuntu-os-pro-cloud': 'ubuntu',
  'rhel-cloud': 'rhel',
  'rocky-linux-cloud': 'rocky',
  'centos-cloud': 'centos',
  'suse-cloud': 'suse',
  'cos-cloud': 'cos',
  'windows-cloud': 'windows',
};

const UNKNOWN_CPU_PLATFORM = 'Unknown CPU Platform';
const UNSPECIFIED_ARCHITECTURE = 'ARCHITECTURE_UNSPECIFIED';
const SYSTEM_LABEL_PREFIX = 'goog-';

const LICENSE_URL_PATTERN = /projects\/([^/]+)\/global\/licenses\/([^/]+)$/;
const DEBIAN_LICENSE_PATTERN = /^debian-(\d+)-([a-z]+)$/;
const UBUNTU_LICENSE_PATTERN = /^ubuntu-(?:(minimal|pro)-)?(\d{2})(\d{2})(-lts)?$/;
const CUSTOM_MACHINE_TYPE_PATTERN = /custom-(\d+)-(\d+)(?:-ext)?$/;

export function normalizeInstance(raw: RawInstance, ctx: NormalizeContext): NormalizedVm {
  const providerId = required(raw.id != null ? String(raw.id) : null, 'id');
  const name = required(raw.name, 'name');
  const zone = required(lastSegment(raw.zone), 'zone');
  const machineType = lastSegment(raw.machineType) ?? 'unknown';
  const machine = resolveMachineType(zone, machineType, ctx.machineTypes);

  const nics = raw.networkInterfaces ?? [];
  const interfaces = nics.map((nic) => ({
    name: nic.name ?? 'unknown',
    network: lastSegment(nic.network),
    subnet: lastSegment(nic.subnetwork),
    privateIp: nonEmpty(nic.networkIP),
    publicIp: nonEmpty(nic.accessConfigs?.[0]?.natIP),
    networkTier: nonEmpty(nic.accessConfigs?.[0]?.networkTier),
  }));

  const sa = raw.serviceAccounts?.[0];
  const serviceAccount = nonEmpty(sa?.email);
  const scopes = sa?.scopes ?? [];

  const bootDisk = raw.disks?.find((d) => d.boot === true);
  const { labels, systemLabels } = splitLabels(raw.labels ?? {});
  const providerState = raw.status ?? 'UNKNOWN';

  return {  // allowlist: SDK objesi asla spread edilmez (gölge alanlar, metadata)
    id: `gcp:${ctx.project}:${zone}:${providerId}`,
    provider: 'gcp',
    providerId,
    name,
    description: nonEmpty(raw.description),
    account: ctx.project,
    region: regionFromZone(zone),
    zone,
    state: STATE_MAP[providerState] ?? 'unknown',
    providerState,
    machine: {
      type: machineType,
      vcpus: machine?.vcpus ?? null,
      memoryMb: machine?.memoryMb ?? null,
      sharedCpu: machine?.sharedCpu ?? null,
      cpuPlatform: raw.cpuPlatform && raw.cpuPlatform !== UNKNOWN_CPU_PLATFORM ? raw.cpuPlatform : null,
    },
    os: parseOs(bootDisk?.licenses ?? [], bootDisk?.architecture),  // instance'ta OS alanı yok, boot disk lisansından
    network: {
      privateIps: interfaces.map((i) => i.privateIp).filter(isString),
      publicIps: nics.flatMap((nic) => (nic.accessConfigs ?? []).map((ac) => nonEmpty(ac.natIP)).filter(isString)),
      interfaces,
      tags: raw.tags?.items ?? [],
      ipForwarding: raw.canIpForward === true,
    },
    disks: (raw.disks ?? []).map((d) => ({
      name: lastSegment(d.source) ?? d.deviceName ?? 'unknown',
      boot: d.boot === true,
      sizeGb: int64ToNumber(d.diskSizeGb),
      mode: d.mode ?? null,
      autoDelete: d.autoDelete === true,
    })),
    identity: {
      serviceAccount,
      isDefaultServiceAccount: serviceAccount?.endsWith(DEFAULT_SA_SUFFIX) ?? false,
      scopeLevel: serviceAccount ? scopeLevelOf(scopes) : 'none',
      scopes,
    },
    security: {
      secureBoot: raw.shieldedInstanceConfig?.enableSecureBoot === true,
      vtpm: raw.shieldedInstanceConfig?.enableVtpm === true,
      integrityMonitoring: raw.shieldedInstanceConfig?.enableIntegrityMonitoring === true,
      confidentialCompute: raw.confidentialInstanceConfig?.enableConfidentialCompute === true,
      deletionProtection: raw.deletionProtection === true,
    },
    scheduling: {
      provisioningModel: provisioningModelOf(raw.scheduling),
      automaticRestart: typeof raw.scheduling?.automaticRestart === 'boolean' ? raw.scheduling.automaticRestart : null,
      onHostMaintenance: raw.scheduling?.onHostMaintenance ?? null,
      terminationAction: raw.scheduling?.instanceTerminationAction ?? null,
    },
    labels,
    systemLabels,
    timestamps: {
      createdAt: toUtcIso(raw.creationTimestamp),
      lastStartedAt: toUtcIso(raw.lastStartTimestamp),
      lastStoppedAt: toUtcIso(raw.lastStopTimestamp),
    },
    consoleUrl:
      `https://console.cloud.google.com/compute/instancesDetail/zones/${encodeURIComponent(zone)}` +
      `/instances/${encodeURIComponent(name)}?project=${encodeURIComponent(ctx.project)}`,
  };
}

function required(value: string | null | undefined, field: string): string {
  if (!value) throw new Error(`GCP instance is missing required field "${field}"`);
  return value;
}

export function lastSegment(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.split('/').pop() || null;
}

function regionFromZone(zone: string): string {
  return zone.replace(/-[a-z]$/, '');
}

function nonEmpty(value: string | null | undefined): string | null {
  return value ? value : null;
}

function isString(value: string | null): value is string {
  return value !== null;
}

function int64ToNumber(value: unknown): number | null {
  return value == null ? null : Number(String(value));
}

function resolveMachineType(
  zone: string,
  type: string,
  known: ReadonlyMap<string, MachineTypeInfo>,
): MachineTypeInfo | null {
  return known.get(machineTypeKey(zone, type)) ?? parseCustomMachineType(type);
}

export function parseCustomMachineType(type: string): MachineTypeInfo | null {
  const custom = CUSTOM_MACHINE_TYPE_PATTERN.exec(type);
  return custom ? { vcpus: Number(custom[1]), memoryMb: Number(custom[2]), sharedCpu: false } : null;
}

function parseOs(licenses: string[], architecture: string | null | undefined): NormalizedVm['os'] {
  const parsed = licenses
    .map((url) => LICENSE_URL_PATTERN.exec(url))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ license: m[2], family: OS_FAMILY_BY_IMAGE_PROJECT[m[1]] ?? null }));

  const pick = parsed.find((p) => p.family !== null) ?? parsed[0];

  return {
    name: pick ? formatOsName(pick.family, pick.license) : null,
    family: pick?.family ?? null,
    license: pick?.license ?? null,
    architecture: architecture && architecture !== UNSPECIFIED_ARCHITECTURE ? architecture.toLowerCase() : null,
  };
}

function formatOsName(family: string | null, license: string): string {
  if (family === 'debian') {
    const m = DEBIAN_LICENSE_PATTERN.exec(license);
    if (m) return `Debian ${m[1]} (${m[2]})`;
  }
  if (family === 'ubuntu') {
    const m = UBUNTU_LICENSE_PATTERN.exec(license);
    if (m) {
      const edition = m[1] ? ` (${m[1][0].toUpperCase()}${m[1].slice(1)})` : '';
      return `Ubuntu ${m[2]}.${m[3]}${m[4] ? ' LTS' : ''}${edition}`;
    }
  }
  return license;
}

function scopeLevelOf(scopes: string[]): ScopeLevel {
  if (scopes.length === 0) return 'none';
  if (scopes.includes(FULL_SCOPE)) return 'full';
  const isConsoleDefault =
    scopes.length === CONSOLE_DEFAULT_SCOPES.size && scopes.every((s) => CONSOLE_DEFAULT_SCOPES.has(s));
  return isConsoleDefault ? 'default' : 'custom';
}

function provisioningModelOf(s: RawInstance['scheduling']): NormalizedVm['scheduling']['provisioningModel'] {
  if (s?.provisioningModel === 'SPOT' || s?.preemptible === true) return 'spot';
  if (!s?.provisioningModel || s.provisioningModel === 'STANDARD') return 'standard';
  return 'unknown';
}

function splitLabels(all: Record<string, string>) {
  const labels: Record<string, string> = {};
  const systemLabels: Record<string, string> = {};
  for (const [key, value] of Object.entries(all)) {
    (key.startsWith(SYSTEM_LABEL_PREFIX) ? systemLabels : labels)[key] = value;
  }
  return { labels, systemLabels };
}

function toUtcIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
