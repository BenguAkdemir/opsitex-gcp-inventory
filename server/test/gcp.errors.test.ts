import { describe, expect, it } from 'vitest';
import { AppError, badRequest } from '../src/domain/errors';
import { translateGcpError, type TranslateContext } from '../src/providers/gcp/gcp.errors';

const ctx: TranslateContext = {
  projectId: 'servicepark-case',
  serviceAccount: 'inventory-reader@servicepark-case.iam.gserviceaccount.com',
  operation: 'list',
};

describe('translateGcpError', () => {
  it('ADC bulunamazsa impersonation ile login komutunu önerir', () => {
    const error = translateGcpError(
      new Error('Could not load the default credentials. Browse to https://cloud.google.com/docs/authentication/getting-started for more information.'),
      ctx,
    );
    expect(error.code).toBe('GCP_CREDENTIALS_NOT_FOUND');
    expect(error.status).toBe(503);
    expect(error.body.command).toBe(
      'gcloud auth application-default login --impersonate-service-account=inventory-reader@servicepark-case.iam.gserviceaccount.com',
    );
  });

  it('GOOGLE_APPLICATION_CREDENTIALS yanlış dosyayı gösteriyorsa bunu ayrıca söyler', () => {
    const error = translateGcpError(
      new Error(
        'Unable to read the credential file specified by the GOOGLE_APPLICATION_CREDENTIALS environment variable: The file at /tmp/yok.json does not exist, or it is not a file.',
      ),
      ctx,
    );
    expect(error.code).toBe('GCP_CREDENTIALS_NOT_FOUND');
    expect(error.body.title).toBe('GCP kimlik dosyası okunamadı');
    expect(error.body.command).toBe('unset GOOGLE_APPLICATION_CREDENTIALS && npm run dev');
  });

  it('kaynak kullanıcı oturumu düşmüşse (invalid_grant) süresi dolmuş der', () => {
    const cause = Object.assign(new Error('invalid_grant'), { response: { data: { error: 'invalid_grant', error_description: 'reauth related error (invalid_rapt)' } } });
    const error = translateGcpError(Object.assign(new Error('unable to impersonate: GaxiosError: invalid_grant', { cause }), { code: 3 }), ctx);
    expect(error.code).toBe('GCP_CREDENTIALS_EXPIRED');
  });

  it('cause zincirinin derinindeki ağ hatasını bulur', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND compute.googleapis.com'), { code: 'ENOTFOUND' });
    const error = translateGcpError(new Error('request failed', { cause }), ctx);
    expect(error.code).toBe('GCP_UNREACHABLE');
    expect(error.body.detail).toContain('ENOTFOUND');
  });

  it('zaten çevrilmiş hatayı değiştirmez', () => {
    const original = badRequest('x');
    expect(translateGcpError(original, ctx)).toBe(original);
  });

  it('tanınmayan hata yutulmaz: Google mesajı detayda kalır, cause saklanır', () => {
    const raw = Object.assign(new Error('Something odd happened'), { code: 13 });
    const error = translateGcpError(raw, ctx);
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('GCP_UNKNOWN_ERROR');
    expect(error.body.detail).toContain('Something odd happened');
    expect(error.cause).toBe(raw);
  });
});
