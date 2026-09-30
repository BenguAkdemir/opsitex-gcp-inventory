import type { ApiError, ErrorCode } from './api';

export type AppErrorBody = Omit<ApiError, 'requestId'>;

export class AppError extends Error {
  readonly status: number;
  readonly body: AppErrorBody;

  constructor(status: number, body: AppErrorBody, options?: { cause?: unknown }) {
    super(`${body.code}: ${body.title}`, options);
    this.name = 'AppError';
    this.status = status;
    this.body = body;
  }

  get code(): ErrorCode {
    return this.body.code;
  }
}

export function badRequest(detail: string): AppError {
  return new AppError(400, {
    code: 'BAD_REQUEST',
    title: 'Geçersiz istek',
    detail,
    action: null,
    command: null,
    docsUrl: null,
    retryable: false,
  });
}

export function routeNotFound(method: string, path: string): AppError {
  return new AppError(404, {
    code: 'ROUTE_NOT_FOUND',
    title: 'Böyle bir endpoint yok',
    detail: `${method} ${path} tanımlı değil.`,
    action: 'Kullanılabilir endpoint\'ler: GET /api/connection, GET /api/vms, GET /api/vms/:zone/:name',
    command: null,
    docsUrl: null,
    retryable: false,
  });
}

export function internalError(cause: unknown): AppError {
  return new AppError(
    500,
    {
      code: 'INTERNAL_ERROR',
      title: 'Beklenmeyen sunucu hatası',
      detail: 'Servis içinde beklenmeyen bir hata oluştu. Ayrıntılar sunucu logunda bu requestId ile kayıtlı.',
      action: 'Sunucu loglarında requestId ile arayın.',
      command: null,
      docsUrl: null,
      retryable: false,
    },
    { cause },
  );
}
