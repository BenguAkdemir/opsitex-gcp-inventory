type Level = 'info' | 'warn' | 'error';

function write(level: Level, message: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...fields }, errorReplacer);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function errorReplacer(_key: string, value: unknown): unknown {  // JSON.stringify(Error) = {}; token da loga düşmesin
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      code: (value as { code?: unknown }).code,
      stack: value.stack?.split('\n').slice(0, 6).join('\n'),
      cause: value.cause,
    };
  }
  return value;
}

export const log = {
  info: (message: string, fields: Record<string, unknown> = {}) => write('info', message, fields),
  warn: (message: string, fields: Record<string, unknown> = {}) => write('warn', message, fields),
  error: (message: string, fields: Record<string, unknown> = {}) => write('error', message, fields),
};
