import type { ApiError, ApiErrorResponse, ConnectionInfo, InventoryResponse, VmDetailResponse } from './types';

export type ClientErrorCode = ApiError['code'] | 'SERVER_UNREACHABLE' | 'UNEXPECTED_RESPONSE';

export interface DisplayError extends Omit<ApiError, 'code' | 'requestId'> {
  code: ClientErrorCode;
  requestId: string | null;
}

export class InventoryApiError extends Error {
  readonly error: DisplayError;

  constructor(error: DisplayError) {
    super(`${error.code}: ${error.title}`);
    this.name = 'InventoryApiError';
    this.error = error;
  }
}

const SERVER_UNREACHABLE: DisplayError = {
  code: 'SERVER_UNREACHABLE',
  title: 'Envanter servisine ulaşılamıyor',
  detail:
    'Tarayıcı, GCP ile konuşan backend servisine (localhost:3001) bağlanamadı. Sorun GCP tarafında değil: servis çalışmıyor ya da farklı bir portta.',
  action: 'Servisi ayrı bir terminalde başlatın, sonra Tekrar dene\'ye basın.',
  command: 'cd server && npm run dev',
  docsUrl: null,
  retryable: true,
  requestId: null,
};

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { headers: { Accept: 'application/json' }, signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new InventoryApiError(SERVER_UNREACHABLE);
  }

  const body: unknown = await response.json().catch(() => null);
  if (response.ok && body !== null) return body as T;
  if (isApiErrorResponse(body)) throw new InventoryApiError(body.error);
  if (response.status >= 500) throw new InventoryApiError(SERVER_UNREACHABLE);
  throw new InventoryApiError({
    code: 'UNEXPECTED_RESPONSE',
    title: 'Beklenmeyen yanıt',
    detail: `${path} isteği HTTP ${response.status} döndü ve yanıt beklenen formatta değil.`,
    action: null,
    command: null,
    docsUrl: null,
    retryable: true,
    requestId: response.headers.get('x-request-id'),
  });
}

function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as ApiErrorResponse).error?.code === 'string'
  );
}

export const api = {
  connection: (signal?: AbortSignal) => getJson<ConnectionInfo>('/api/connection', signal),
  vms: (signal?: AbortSignal) => getJson<InventoryResponse>('/api/vms', signal),
  vm: (zone: string, name: string, signal?: AbortSignal) =>
    getJson<VmDetailResponse>(`/api/vms/${encodeURIComponent(zone)}/${encodeURIComponent(name)}`, signal),
};

export function toDisplayError(err: unknown): DisplayError {
  if (err instanceof InventoryApiError) return err.error;
  return {
    code: 'UNEXPECTED_RESPONSE',
    title: 'Beklenmeyen hata',
    detail: err instanceof Error ? err.message : String(err),
    action: null,
    command: null,
    docsUrl: null,
    retryable: true,
    requestId: null,
  };
}
