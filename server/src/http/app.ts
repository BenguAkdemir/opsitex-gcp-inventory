import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { ApiErrorResponse } from '../domain/api';
import { AppError, badRequest, internalError, routeNotFound } from '../domain/errors';
import type { InventoryProvider } from '../domain/provider';
import { log } from '../log';

const ZONE_PATTERN = /^[a-z]+(?:-[a-z]+)*\d+-[a-z]$/;
const INSTANCE_NAME_PATTERN = /^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/;

export function createApp(provider: InventoryProvider): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestContext);

  app.get('/api/connection', async (_req, res) => {  // try/catch yok: Express 5 async hatayı errorHandler'a taşır
    res.json(await provider.checkConnection());
  });

  app.get('/api/vms', async (_req, res) => {
    res.json(await provider.listVms());
  });

  app.get('/api/vms/:zone/:name', async (req, res) => {
    const { zone, name } = req.params;
    if (!ZONE_PATTERN.test(zone)) throw badRequest(`"${zone}" geçerli bir zone adı değil (ör. us-central1-a).`);
    if (!INSTANCE_NAME_PATTERN.test(name)) throw badRequest(`"${name}" geçerli bir VM adı değil.`);
    res.json(await provider.getVm(zone, name));
  });

  app.use('/api', (req) => {
    throw routeNotFound(req.method, req.originalUrl);
  });

  app.use(errorHandler);
  return app;
}

function requestContext(req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  const startedAt = performance.now();
  res.locals.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('Cache-Control', 'no-store');
  res.on('finish', () => {
    log.info('request', {
      requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(performance.now() - startedAt),
    });
  });
  next();
}

function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  const requestId: string = res.locals.requestId ?? randomUUID();
  const error = err instanceof AppError ? err : internalError(err);  // reçete değilse iç detay gizlenir, ham hali loglanır
  const level = error.status >= 500 ? 'error' : 'warn';
  log[level]('request failed', { requestId, code: error.code, status: error.status, error: error.cause ?? err });

  if (res.headersSent) {
    next(err);
    return;
  }
  const body: ApiErrorResponse = { error: { ...error.body, requestId } };
  res.status(error.status).json(body);
}
