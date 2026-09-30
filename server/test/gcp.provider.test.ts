import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GoogleAuth, UserRefreshClient } from 'google-auth-library';
import { AppError } from '../src/domain/errors';
import { GcpInventoryProvider } from '../src/providers/gcp/gcp.provider';
import { COMPUTE_READONLY_SCOPE } from '../src/providers/gcp/gcp.session';
import {
  FAKE_SA_TOKEN,
  SERVICE_ACCOUNT,
  googleError,
  impersonatedAuth,
  startFakeGoogle,
  toRestJson,
  tokenRoute,
  type FakeGoogle,
} from './support/fake-google';

const PROJECT = 'servicepark-case';
const COMPUTE = `/compute/v1/projects/${PROJECT}`;
const AGGREGATED = `GET ${COMPUTE}/aggregated/instances`;
const TOKEN = `POST /v1/projects/-/serviceAccounts/${SERVICE_ACCOUNT}:generateAccessToken`;

const fixture = (name: string) =>
  toRestJson(JSON.parse(readFileSync(join(process.cwd(), 'test', 'fixtures', name), 'utf8')));

const machineTypeRoute = (zone: string, type: string, guestCpus: number, memoryMb: number, isSharedCpu: boolean) =>
  [`GET ${COMPUTE}/zones/${zone}/machineTypes/${type}`, () => ({ status: 200, body: { name: type, guestCpus, memoryMb, isSharedCpu } })] as const;

let fake: FakeGoogle;

function provider(overrides: { port?: number } = {}) {
  return new GcpInventoryProvider(
    { projectId: PROJECT, expectedServiceAccount: SERVICE_ACCOUNT },
    {
      createAuth: impersonatedAuth(fake),
      endpoint: { apiEndpoint: '127.0.0.1', port: overrides.port ?? fake.port, protocol: 'http' },
      callTimeoutMs: 1_500,
    },
  );
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => {
      throw new Error('expected the call to fail');
    },
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

beforeEach(async () => {
  fake = await startFakeGoogle();
  fake.routes.set(...tokenRoute());
  fake.routes.set(AGGREGATED, () => ({
    status: 200,
    body: {
      items: {
        'zones/us-central1-a': { instances: [fixture('web-01.running.json')] },
        'zones/us-central1-b': { instances: [fixture('app-01.terminated.json')] },
        'zones/europe-west1-b': { instances: [fixture('batch-01.terminated.json')] },
        'zones/asia-east1-a': { warning: { code: 'NO_RESULTS_ON_PAGE', message: 'There are no results for scope' } },
        'zones/me-west1-a': { warning: { code: 'UNREACHABLE', message: 'The zone is unreachable' } },
      },
    },
  }));
  fake.routes.set(...machineTypeRoute('us-central1-a', 'e2-micro', 2, 1024, true));
  fake.routes.set(...machineTypeRoute('us-central1-b', 'e2-micro', 2, 1024, true));
  fake.routes.set(...machineTypeRoute('europe-west1-b', 'e2-medium', 2, 4096, true));
});

afterEach(async () => {
  await fake.close();
});

describe('listVms', () => {
  it('tüm zone\'lardaki VM\'leri normalize edip isme göre sıralar', async () => {
    const snapshot = await provider().listVms();
    expect(snapshot.vms.map((vm) => vm.name)).toEqual(['app-01', 'batch-01', 'web-01']);
    expect(snapshot.vms.find((vm) => vm.name === 'batch-01')?.machine).toMatchObject({ vcpus: 2, memoryMb: 4096, sharedCpu: true });
  });

  it('NO_RESULTS_ON_PAGE gürültüsünü atar, UNREACHABLE zone\'u uyarı olarak döndürür', async () => {
    const snapshot = await provider().listVms();
    expect(snapshot.warnings).toEqual([
      { scope: 'zones/me-west1-a', code: 'UNREACHABLE', message: 'The zone is unreachable', command: null },
    ]);
  });

  it('token compute.readonly scope\'u ile istenir, Compute\'a service account token\'ı gider', async () => {
    await provider().listVms();
    const tokenRequest = fake.requests.find((r) => r.path.endsWith(':generateAccessToken'));
    expect(tokenRequest?.body).toMatchObject({ scope: [COMPUTE_READONLY_SCOPE] });
    const computeRequest = fake.requests.find((r) => r.path.startsWith(COMPUTE));
    expect(computeRequest?.headers.authorization).toBe(`Bearer ${FAKE_SA_TOKEN}`);
  });

  it('machine type bilgisi cache\'lenir: ikinci listelemede tekrar sorulmaz', async () => {
    const p = provider();
    await p.listVms();
    await p.listVms();
    const lookups = fake.requests.filter((r) => r.path.includes('/machineTypes/'));
    expect(lookups).toHaveLength(3);
  });

  it('machine type izni yoksa liste yine döner, eksik izin uyarıda komutla gösterilir', async () => {
    fake.routes.set(`GET ${COMPUTE}/zones/europe-west1-b/machineTypes/e2-medium`, () =>
      googleError(403, "Required 'compute.machineTypes.get' permission for 'projects/servicepark-case/zones/europe-west1-b/machineTypes/e2-medium'"),
    );
    const snapshot = await provider().listVms();
    expect(snapshot.vms).toHaveLength(3);
    expect(snapshot.vms.find((vm) => vm.name === 'batch-01')?.machine.vcpus).toBeNull();
    expect(snapshot.warnings).toContainEqual(
      expect.objectContaining({
        scope: 'machineTypes/europe-west1-b/e2-medium',
        code: 'GCP_PERMISSION_DENIED',
        command: `gcloud iam roles update inventoryReader --project=${PROJECT} --add-permissions=compute.machineTypes.get`,
      }),
    );
  });

  it('normalize edilemeyen tek VM listeyi düşürmez, uyarıya dönüşür', async () => {
    const broken = fixture('app-01.terminated.json') as Record<string, unknown>;
    delete broken.id;
    fake.routes.set(AGGREGATED, () => ({
      status: 200,
      body: { items: { 'zones/us-central1-a': { instances: [fixture('web-01.running.json'), broken] } } },
    }));
    const snapshot = await provider().listVms();
    expect(snapshot.vms.map((vm) => vm.name)).toEqual(['web-01']);
    expect(snapshot.warnings).toContainEqual(expect.objectContaining({ code: 'NORMALIZE_FAILED' }));
  });
});

describe('hata çevirisi (gerçek kütüphane + sahte Google API)', () => {
  it('Token Creator yoksa impersonation hatası döner; izin gelince aynı süreç düzelir', async () => {
    fake.routes.set(TOKEN, () =>
      googleError(403, "Permission 'iam.serviceAccounts.getAccessToken' denied on resource (or it may not exist).", {
        status: 'PERMISSION_DENIED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'IAM_PERMISSION_DENIED',
            domain: 'iam.googleapis.com',
            metadata: { permission: 'iam.serviceAccounts.getAccessToken' },
          },
        ],
      }),
    );
    const p = provider();
    const error = await failure(p.listVms());
    expect(error.code).toBe('GCP_IMPERSONATION_DENIED');
    expect(error.body.retryable).toBe(true);
    expect(error.body.command).toContain('roles/iam.serviceAccountTokenCreator');

    fake.routes.set(...tokenRoute());
    await expect(p.listVms()).resolves.toMatchObject({ account: PROJECT });
  });

  it('eksik izin ErrorInfo metadata\'sından okunur', async () => {
    fake.routes.set(AGGREGATED, () =>
      googleError(403, "Required 'compute.instances.list' permission for 'projects/servicepark-case'", {
        errors: [{ reason: 'forbidden', message: "Required 'compute.instances.list' permission for 'projects/servicepark-case'" }],
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'IAM_PERMISSION_DENIED',
            domain: 'compute.googleapis.com',
            metadata: { permission: 'compute.instances.list' },
          },
        ],
      }),
    );
    const error = await failure(provider().listVms());
    expect(error.code).toBe('GCP_PERMISSION_DENIED');
    expect(error.body.title).toBe('Eksik izin: compute.instances.list');
    expect(error.body.command).toBe(`gcloud iam roles update inventoryReader --project=${PROJECT} --add-permissions=compute.instances.list`);
  });

  it('ErrorInfo yoksa izin adı mesajdan çıkarılır', async () => {
    fake.routes.set(AGGREGATED, () => googleError(403, "Required 'compute.instances.list' permission for 'projects/servicepark-case'"));
    const error = await failure(provider().listVms());
    expect(error.body.title).toBe('Eksik izin: compute.instances.list');
  });

  it('Compute API kapalıysa etkinleştirme komutu ve activation linki döner', async () => {
    const activationUrl = 'https://console.developers.google.com/apis/api/compute.googleapis.com/overview?project=844787416340';
    fake.routes.set(AGGREGATED, () =>
      googleError(403, 'Compute Engine API has not been used in project 844787416340 before or it is disabled.', {
        status: 'PERMISSION_DENIED',
        errors: [{ reason: 'accessNotConfigured', message: 'Access Not Configured.' }],
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'SERVICE_DISABLED',
            domain: 'googleapis.com',
            metadata: { service: 'compute.googleapis.com', consumer: 'projects/844787416340', activationUrl },
          },
        ],
      }),
    );
    const error = await failure(provider().listVms());
    expect(error.code).toBe('GCP_API_DISABLED');
    expect(error.body.command).toBe(`gcloud services enable compute.googleapis.com --project=${PROJECT}`);
    expect(error.body.docsUrl).toBe(activationUrl);
  });

  it('listelemede 404 proje bulunamadı demektir', async () => {
    fake.routes.set(AGGREGATED, () => googleError(404, "The resource 'projects/servicepark-case' was not found"));
    const error = await failure(provider().listVms());
    expect(error.code).toBe('GCP_PROJECT_NOT_FOUND');
  });

  it('tek VM sorgusunda 404 VM bulunamadı demektir', async () => {
    const error = await failure(provider().getVm('us-central1-a', 'ghost'));
    expect(error.code).toBe('VM_NOT_FOUND');
    expect(error.status).toBe(404);
    expect(error.body.detail).toContain('us-central1-a/ghost');
  });

  it('kota aşımı tekrar denenebilir olarak işaretlenir', async () => {
    fake.routes.set(AGGREGATED, () => googleError(429, "Quota exceeded for quota metric 'Read requests'", { status: 'RESOURCE_EXHAUSTED' }));
    const error = await failure(provider().listVms());
    expect(error.code).toBe('GCP_RATE_LIMITED');
    expect(error.body.retryable).toBe(true);
  });

  it('Google\'a ulaşılamıyorsa süre sınırı içinde UNREACHABLE döner', async () => {
    const closed = await startFakeGoogle();
    const closedPort = closed.port;
    await closed.close();
    const started = Date.now();
    const error = await failure(provider({ port: closedPort }).listVms());
    expect(error.code).toBe('GCP_UNREACHABLE');
    expect(error.body.title).toBe('Google API\'lerine ulaşılamıyor');
    expect(error.body.detail).toContain('ECONNREFUSED');
    expect(error.body.retryable).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('kullanıcı hesabıyla oluşturulmuş ADC reddedilir', async () => {
    const p = new GcpInventoryProvider(
      { projectId: PROJECT, expectedServiceAccount: SERVICE_ACCOUNT },
      {
        createAuth: () =>
          new GoogleAuth({ authClient: new UserRefreshClient({ clientId: 'id', clientSecret: 'secret', refreshToken: 'token' }) }),
        endpoint: { apiEndpoint: '127.0.0.1', port: fake.port, protocol: 'http' },
      },
    );
    const error = await failure(p.listVms());
    expect(error.code).toBe('GCP_USER_CREDENTIALS_REJECTED');
    expect(fake.requests.filter((r) => r.path.startsWith(COMPUTE))).toHaveLength(0);
  });
});

describe('checkConnection', () => {
  it('kimliği, beklenen SA ile eşleşmesini ve token scope\'unu döner', async () => {
    const info = await provider().checkConnection();
    expect(info).toMatchObject({
      account: PROJECT,
      identity: {
        principal: SERVICE_ACCOUNT,
        kind: 'impersonated_service_account',
        expectedPrincipal: SERVICE_ACCOUNT,
        matchesExpected: true,
      },
      scopes: [COMPUTE_READONLY_SCOPE],
    });
  });
});
