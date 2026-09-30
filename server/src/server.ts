import { existsSync } from 'node:fs';
import { ConfigError, loadConfig, type Config } from './config';
import { createApp } from './http/app';
import { log } from './log';
import { GcpInventoryProvider } from './providers/gcp/gcp.provider';

const HOST = '127.0.0.1';  // sadece bu makine: servis GCP'ye benim onayımla bağlanıyor

function readConfig(): Config {
  if (existsSync('.env')) process.loadEnvFile('.env');
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Konfigürasyon hatası:\n${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

const config = readConfig();
const provider = new GcpInventoryProvider(config);
const server = createApp(provider).listen(config.port, HOST);  // callback değil olaylar: Express 5 hatada da çağırır

server.on('listening', () => {
  log.info('server started', {
    url: `http://${HOST}:${config.port}`,
    project: config.projectId,
    expectedServiceAccount: config.expectedServiceAccount,
  });
});

server.on('error', (error: NodeJS.ErrnoException) => {
  const hint = error.code === 'EADDRINUSE' ? `Port ${config.port} kullanımda; .env içindeki PORT değerini değiştirin.` : undefined;
  log.error('server could not start', { error, hint });
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
