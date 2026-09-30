import { z } from 'zod';

const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;  // name/number burada yakalanır, API sadece ID ister

const EnvSchema = z.object({
  GCP_PROJECT_ID: z
    .string({ error: 'GCP_PROJECT_ID tanımlı değil. server/.env.example dosyasını server/.env olarak kopyalayın.' })
    .regex(PROJECT_ID_PATTERN, {
      error: (issue) =>
        `GCP_PROJECT_ID="${String(issue.input)}" geçerli bir project ID değil. ` +
        'Project name veya project number değil, ID olmalı (ör. servicepark-case).',
    }),
  GCP_SERVICE_ACCOUNT: z.email('GCP_SERVICE_ACCOUNT geçerli bir e-posta değil.').optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
});

export interface Config {
  projectId: string;
  expectedServiceAccount: string;
  port: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(z.prettifyError(parsed.error));
  }
  const { GCP_PROJECT_ID, GCP_SERVICE_ACCOUNT, PORT } = parsed.data;
  return {
    projectId: GCP_PROJECT_ID,
    expectedServiceAccount: GCP_SERVICE_ACCOUNT ?? `inventory-reader@${GCP_PROJECT_ID}.iam.gserviceaccount.com`,
    port: PORT,
  };
}
