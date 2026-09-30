import type { protos } from '@google-cloud/compute';
import type { ConnectionInfo, InventoryResponse, InventoryWarning, VmDetailResponse } from '../../domain/api';
import type { InventoryProvider } from '../../domain/provider';
import type { MachineTypeInfo, NormalizedVm } from '../../domain/vm';
import { log } from '../../log';
import { isCredentialError, translateGcpError, userCredentialsRejected, type GcpOperation, type TranslateContext } from './gcp.errors';
import { lastSegment, machineTypeKey, normalizeInstance, parseCustomMachineType } from './gcp.normalizer';
import {
  COMPUTE_READONLY_SCOPE,
  defaultAuthFactory,
  openSession,
  type AuthFactory,
  type ComputeEndpointOptions,
  type GcpSession,
} from './gcp.session';

type RawInstance = protos.google.cloud.compute.v1.IInstance;

const NOISE_WARNING_CODES = new Set(['NO_RESULTS_ON_PAGE']);  // Google her boş zone için bu uyarıyı döner
const DEFAULT_CALL_TIMEOUT_MS = 15_000;  // kütüphane varsayılanı 10 dk tekrar deneme

export interface GcpProviderConfig {
  projectId: string;
  expectedServiceAccount: string;
}

export interface GcpProviderDeps {
  createAuth?: AuthFactory;
  endpoint?: ComputeEndpointOptions;
  callTimeoutMs?: number;
}

export class GcpInventoryProvider implements InventoryProvider {
  private session: Promise<GcpSession> | null = null;
  private readonly machineTypeCache = new Map<string, MachineTypeInfo>();
  private readonly createAuth: AuthFactory;
  private readonly endpoint: ComputeEndpointOptions;
  private readonly callOptions: { timeout: number };

  constructor(
    private readonly config: GcpProviderConfig,
    deps: GcpProviderDeps = {},
  ) {
    this.createAuth = deps.createAuth ?? defaultAuthFactory;
    this.endpoint = deps.endpoint ?? {};
    this.callOptions = { timeout: deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS };
  }

  checkConnection(): Promise<ConnectionInfo> {
    return this.run('connection', undefined, async (session) => {
      await session.authClient.getAccessToken();  // dosyanın varlığı yetmez, token gerçekten alınır
      const { principal, kind } = session.identity;
      return {
        provider: 'gcp',
        account: this.config.projectId,
        identity: {
          principal,
          kind,
          expectedPrincipal: this.config.expectedServiceAccount,
          matchesExpected: principal === this.config.expectedServiceAccount,
        },
        scopes: [COMPUTE_READONLY_SCOPE],
        checkedAt: new Date().toISOString(),
      };
    });
  }

  listVms(): Promise<InventoryResponse> {
    return this.run('list', undefined, async (session) => {
      const raws: RawInstance[] = [];
      const warnings: InventoryWarning[] = [];

      const pages = session.instances.aggregatedListAsync(
        { project: this.config.projectId, returnPartialSuccess: true },  // bir zone bozuksa liste düşmesin, uyarı olsun
        { ...this.callOptions, autoPaginate: false },  // *Async zaten sayfa sayfa; false verilmezse gax uyarı basar
      );
      for await (const [scope, scoped] of pages) {
        const warning = scoped.warning;
        if (warning?.code && !NOISE_WARNING_CODES.has(warning.code)) {
          warnings.push({ scope, code: warning.code, message: warning.message ?? '', command: null });
        }
        raws.push(...(scoped.instances ?? []));
      }

      const machineTypes = await this.resolveMachineTypes(session, raws, warnings);
      const vms = this.normalizeAll(raws, machineTypes, warnings);
      return {
        provider: 'gcp',
        account: this.config.projectId,
        fetchedAt: new Date().toISOString(),
        vms: vms.sort((a, b) => a.name.localeCompare(b.name)),
        warnings,
      };
    });
  }

  getVm(zone: string, name: string): Promise<VmDetailResponse> {
    return this.run('get', `${zone}/${name}`, async (session) => {
      const [raw] = await session.instances.get(
        { project: this.config.projectId, zone, instance: name },
        this.callOptions,
      );
      const warnings: InventoryWarning[] = [];
      const machineTypes = await this.resolveMachineTypes(session, [raw], warnings);
      const vm = normalizeInstance(raw, { project: this.config.projectId, machineTypes });
      this.warnIfUnknownState(vm);
      return { fetchedAt: new Date().toISOString(), vm, warnings };
    });
  }

  private async run<T>(operation: GcpOperation, resource: string | undefined, work: (s: GcpSession) => Promise<T>): Promise<T> {
    const ctx = this.context(operation, resource);
    try {
      return await work(await this.getSession(ctx));
    } catch (err) {
      const error = translateGcpError(err, ctx);
      if (isCredentialError(error)) this.session = null;  // yeni ADC restart'sız okunsun
      throw error;
    }
  }

  private getSession(ctx: TranslateContext): Promise<GcpSession> {
    this.session ??= openSession(this.createAuth, this.endpoint)  // paralel istekler aynı oturum promise'ini bekler
      .then((session) => {
        if (session.identity.kind === 'user') throw userCredentialsRejected(ctx);
        return session;
      })
      .catch((err: unknown) => {
        this.session = null;
        throw err;
      });
    return this.session;
  }

  private async resolveMachineTypes(
    session: GcpSession,
    raws: RawInstance[],
    warnings: InventoryWarning[],
  ): Promise<ReadonlyMap<string, MachineTypeInfo>> {
    const missing = new Map<string, { zone: string; type: string }>();
    for (const raw of raws) {
      const zone = lastSegment(raw.zone);
      const type = lastSegment(raw.machineType);
      if (!zone || !type || parseCustomMachineType(type)) continue;  // custom tip isimden çözülür, API'ye gidilmez
      const key = machineTypeKey(zone, type);
      if (!this.machineTypeCache.has(key)) missing.set(key, { zone, type });
    }

    await Promise.all(
      [...missing].map(async ([key, { zone, type }]) => {
        try {
          const [machineType] = await session.machineTypes.get(
            { project: this.config.projectId, zone, machineType: type },
            this.callOptions,
          );
          if (typeof machineType.guestCpus !== 'number' || typeof machineType.memoryMb !== 'number') {
            throw new Error(`machine type ${key} response has no guestCpus/memoryMb`);
          }
          this.machineTypeCache.set(key, {
            vcpus: machineType.guestCpus,
            memoryMb: machineType.memoryMb,
            sharedCpu: machineType.isSharedCpu === true,
          });
        } catch (err) {
          const error = translateGcpError(err, this.context('machineType', key));
          log.warn('machine type lookup failed', { key, code: error.code, error: err });
          warnings.push({
            scope: `machineTypes/${key}`,
            code: error.code,
            message: `${key} için vCPU/RAM bilgisi alınamadı: ${error.body.title}`,
            command: error.body.command,
          });
        }
      }),
    );

    return this.machineTypeCache;
  }

  private normalizeAll(
    raws: RawInstance[],
    machineTypes: ReadonlyMap<string, MachineTypeInfo>,
    warnings: InventoryWarning[],
  ): NormalizedVm[] {
    const vms: NormalizedVm[] = [];
    for (const raw of raws) {
      try {
        const vm = normalizeInstance(raw, { project: this.config.projectId, machineTypes });
        this.warnIfUnknownState(vm);
        vms.push(vm);
      } catch (err) {
        log.error('instance could not be normalized', { name: raw.name, zone: raw.zone, error: err });
        warnings.push({
          scope: lastSegment(raw.zone) ?? 'unknown-zone',
          code: 'NORMALIZE_FAILED',
          message: `${raw.name ?? 'Adı olmayan bir VM'} listelenemedi: ${err instanceof Error ? err.message : String(err)}`,
          command: null,
        });
      }
    }
    return vms;
  }

  private warnIfUnknownState(vm: NormalizedVm): void {
    if (vm.state === 'unknown') {
      log.warn('unmapped GCP instance status', { vm: vm.id, providerState: vm.providerState });
    }
  }

  private context(operation: GcpOperation, resource?: string): TranslateContext {
    return {
      projectId: this.config.projectId,
      serviceAccount: this.config.expectedServiceAccount,
      operation,
      resource,
    };
  }
}
