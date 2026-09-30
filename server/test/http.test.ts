import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/http/app';
import type { InventoryProvider } from '../src/domain/provider';
import { AppError } from '../src/domain/errors';
import { normalizeInstance } from '../src/providers/gcp/gcp.normalizer';

const web01 = normalizeInstance(
  JSON.parse(readFileSync(join(process.cwd(), 'test', 'fixtures', 'web-01.running.json'), 'utf8')),
  { project: 'servicepark-case', machineTypes: new Map() },
);

let server: Server | undefined;

async function serve(provider: Partial<InventoryProvider>): Promise<string> {
  server = createApp(provider as InventoryProvider).listen(0, '127.0.0.1');
  await new Promise((resolve) => server!.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve));
  server = undefined;
});

describe('HTTP API', () => {
  it('GET /api/vms provider\'ın normalize listesini olduğu gibi döner', async () => {
    const base = await serve({
      listVms: async () => ({ provider: 'gcp', account: 'servicepark-case', fetchedAt: '2026-09-29T08:00:00.000Z', vms: [web01], warnings: [] }),
    });
    const res = await fetch(`${base}/api/vms`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(body.vms[0]).toMatchObject({ name: 'web-01', provider: 'gcp', state: 'running' });
    expect(body.warnings).toEqual([]);
  });

  it('kısmi sonuç uyarıları cevaba aynen geçer', async () => {
    const base = await serve({
      listVms: async () => ({
        provider: 'gcp',
        account: 'servicepark-case',
        fetchedAt: '2026-09-29T08:00:00.000Z',
        vms: [],
        warnings: [{ scope: 'zones/me-west1-a', code: 'UNREACHABLE', message: 'x', command: null }],
      }),
    });
    const body = await (await fetch(`${base}/api/vms`)).json();
    expect(body.warnings).toHaveLength(1);
    expect(body.vms).toEqual([]);
  });

  it('AppError, requestId ile aynı JSON sözleşmesinde döner', async () => {
    const base = await serve({
      listVms: async () => {
        throw new AppError(502, {
          code: 'GCP_PERMISSION_DENIED',
          title: 'Eksik izin: compute.instances.list',
          detail: 'd',
          action: 'a',
          command: 'c',
          docsUrl: null,
          retryable: false,
        });
      },
    });
    const res = await fetch(`${base}/api/vms`);
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body.error).toMatchObject({ code: 'GCP_PERMISSION_DENIED', command: 'c', retryable: false });
    expect(body.error.requestId).toBe(res.headers.get('x-request-id'));
  });

  it('beklenmeyen hata 500 döner ve iç detayı sızdırmaz', async () => {
    const base = await serve({
      listVms: async () => {
        throw new TypeError('cannot read properties of undefined (secret internals)');
      },
    });
    const res = await fetch(`${base}/api/vms`);
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(JSON.parse(text).error.code).toBe('INTERNAL_ERROR');
    expect(text).not.toContain('secret internals');
  });

  it('geçersiz zone GCP\'ye gitmeden 400 döner', async () => {
    const getVm = vi.fn();
    const base = await serve({ getVm });
    const res = await fetch(`${base}/api/vms/not-a-zone/web-01`);
    expect(res.status).toBe(400);
    expect(getVm).not.toHaveBeenCalled();
  });

  it('GET /api/vms/:zone/:name tek VM\'i döner', async () => {
    const base = await serve({ getVm: async () => ({ fetchedAt: '2026-09-29T08:00:00.000Z', vm: web01, warnings: [] }) });
    const body = await (await fetch(`${base}/api/vms/us-central1-a/web-01`)).json();
    expect(body.vm.name).toBe('web-01');
    expect(body.vm.zone).toBe('us-central1-a');
  });

  it('tanımsız endpoint JSON 404 döner', async () => {
    const base = await serve({});
    const res = await fetch(`${base}/api/unknown`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('ROUTE_NOT_FOUND');
  });
});
