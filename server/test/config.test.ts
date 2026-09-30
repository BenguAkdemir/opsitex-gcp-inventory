import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('beklenen service account project ID\'den türetilir', () => {
    expect(loadConfig({ GCP_PROJECT_ID: 'servicepark-case' })).toEqual({
      projectId: 'servicepark-case',
      expectedServiceAccount: 'inventory-reader@servicepark-case.iam.gserviceaccount.com',
      port: 3001,
    });
  });

  it.each([
    ['project number', '844787416340'],
    ['project name', 'Servicepark Case'],
    ['çok kısa', 'abc'],
  ])('%s verilirse açıklayıcı hata verir', (_label, value) => {
    expect(() => loadConfig({ GCP_PROJECT_ID: value })).toThrow(ConfigError);
    expect(() => loadConfig({ GCP_PROJECT_ID: value })).toThrow(`GCP_PROJECT_ID="${value}" geçerli bir project ID değil`);
  });

  it('GCP_PROJECT_ID yoksa .env\'in nasıl oluşturulacağını söyler', () => {
    expect(() => loadConfig({})).toThrow(/server\/.env\.example/);
  });

  it('PORT sayı değilse reddedilir', () => {
    expect(() => loadConfig({ GCP_PROJECT_ID: 'servicepark-case', PORT: 'abc' })).toThrow(ConfigError);
  });
});
