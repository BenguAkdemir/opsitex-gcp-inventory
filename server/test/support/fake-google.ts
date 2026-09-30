import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GoogleAuth, Impersonated, OAuth2Client } from 'google-auth-library';
import { COMPUTE_READONLY_SCOPE, type AuthFactory } from '../../src/providers/gcp/gcp.session';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface FakeResponse {
  status: number;
  body: unknown;
}

export type Route = (request: RecordedRequest) => FakeResponse;

export interface FakeGoogle {
  port: number;
  url: string;
  requests: RecordedRequest[];
  routes: Map<string, Route>;
  close(): Promise<void>;
}

export const SERVICE_ACCOUNT = 'inventory-reader@servicepark-case.iam.gserviceaccount.com';
export const FAKE_SA_TOKEN = 'fake-service-account-token';

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const requests: RecordedRequest[] = [];
  const routes = new Map<string, Route>();

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const path = (req.url ?? '/').split('?')[0];
      const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        path,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : null,
      };
      requests.push(recorded);
      const route = routes.get(`${recorded.method} ${path}`);
      const response = route
        ? route(recorded)
        : { status: 404, body: { error: { code: 404, message: `fake route not defined: ${recorded.method} ${path}` } } };
      res.writeHead(response.status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(response.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    routes,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export function impersonatedAuth(fake: FakeGoogle): AuthFactory {
  return () => {
    const sourceClient = new OAuth2Client();
    sourceClient.setCredentials({ access_token: 'fake-user-token', expiry_date: Date.now() + 3_600_000 });
    const authClient = new Impersonated({
      sourceClient,
      targetPrincipal: SERVICE_ACCOUNT,
      targetScopes: [COMPUTE_READONLY_SCOPE],
      endpoint: fake.url,
    });
    return new GoogleAuth({ authClient });
  };
}

export function tokenRoute(): [string, Route] {
  return [
    `POST /v1/projects/-/serviceAccounts/${SERVICE_ACCOUNT}:generateAccessToken`,
    () => ({
      status: 200,
      body: { accessToken: FAKE_SA_TOKEN, expireTime: new Date(Date.now() + 3_600_000).toISOString() },
    }),
  ];
}

export function toRestJson(sdkObject: unknown): unknown {
  if (Array.isArray(sdkObject)) return sdkObject.map(toRestJson);
  if (sdkObject && typeof sdkObject === 'object') {
    return Object.fromEntries(
      Object.entries(sdkObject)
        .filter(([key]) => !key.startsWith('_'))
        .map(([key, value]) => [key, toRestJson(value)]),
    );
  }
  return sdkObject;
}

export function googleError(code: number, message: string, extra: Record<string, unknown> = {}): FakeResponse {
  return { status: code, body: { error: { code, message, ...extra } } };
}
