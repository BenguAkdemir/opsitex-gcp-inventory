import { AppError, type AppErrorBody } from '../../domain/errors';

export type GcpOperation = 'connection' | 'list' | 'get' | 'machineType';

export interface TranslateContext {
  projectId: string;
  serviceAccount: string;
  operation: GcpOperation;
  resource?: string;
}

export interface GoogleErrorInfo {
  grpcCode: number | null;
  httpStatus: number | null;
  status: string | null;
  message: string;
  reason: string | null;
  metadata: Record<string, string>;
  legacyReasons: string[];
  networkCode: string | null;
  text: string;
}

const GRPC = {
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
} as const;

const NETWORK_ERROR_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const TOKEN_CREATOR_PERMISSION = 'iam.serviceAccounts.getAccessToken';
const REQUIRED_PERMISSION_PATTERN = /Required '([\w.]+)' permission for '([^']+)'/;
const PERMISSION_DENIED_ON_PATTERN = /Permission '([\w.]+)' denied on resource/;
const MAX_CAUSE_DEPTH = 6;

const DOCS = {
  adc: 'https://docs.cloud.google.com/docs/authentication/application-default-credentials',
  impersonation: 'https://docs.cloud.google.com/iam/docs/service-account-impersonation',
  customRoles: 'https://docs.cloud.google.com/iam/docs/creating-custom-roles',
  troubleshootAccess: 'https://docs.cloud.google.com/iam/docs/troubleshooting-access',
  quotas: 'https://docs.cloud.google.com/compute/api-quota',
};

export function translateGcpError(err: unknown, ctx: TranslateContext): AppError {
  if (err instanceof AppError) return err;
  const info = readGoogleError(err);
  const build = (status: number, body: AppErrorBody) => new AppError(status, body, { cause: err });

  if (/GOOGLE_APPLICATION_CREDENTIALS/.test(info.text)) {
    return build(503, credentialsFileUnreadable());
  }
  if (/Could not load the default credentials|Unable to find credentials/i.test(info.text)) {
    return build(503, credentialsNotFound(ctx));
  }
  if (/invalid_grant|invalid_rapt|reauth/i.test(info.text)) {
    return build(503, credentialsExpired(ctx));
  }
  if (isNetworkFailure(info)) {  // impersonation'dan önce: internet yokken o da düşer, asıl sebep ağ
    return build(504, unreachable(info));
  }
  if (/unable to impersonate/i.test(info.text) || info.metadata.permission === TOKEN_CREATOR_PERMISSION) {
    return build(502, impersonationDenied(ctx, info));
  }
  if (isApiDisabled(info)) {
    return build(502, apiDisabled(ctx, info));
  }
  if (info.grpcCode === GRPC.PERMISSION_DENIED || info.httpStatus === 403) {
    return build(502, permissionDenied(ctx, info));
  }
  if (info.grpcCode === GRPC.UNAUTHENTICATED || info.httpStatus === 401) {
    return build(503, credentialsExpired(ctx));
  }
  if (info.grpcCode === GRPC.NOT_FOUND || info.httpStatus === 404) {
    if (ctx.operation === 'get') return build(404, vmNotFound(ctx));
    if (ctx.operation === 'list') return build(502, projectNotFound(ctx, info));
  }
  if (info.grpcCode === GRPC.RESOURCE_EXHAUSTED || info.httpStatus === 429) {
    return build(503, rateLimited(info));
  }
  return build(502, unknownError(info));
}

export function isCredentialError(error: AppError): boolean {
  return (
    error.code === 'GCP_CREDENTIALS_NOT_FOUND' ||
    error.code === 'GCP_CREDENTIALS_EXPIRED' ||
    error.code === 'GCP_USER_CREDENTIALS_REJECTED' ||
    error.code === 'GCP_IMPERSONATION_DENIED'
  );
}

export function userCredentialsRejected(ctx: TranslateContext): AppError {
  return new AppError(503, {
    code: 'GCP_USER_CREDENTIALS_REJECTED',
    title: 'Servis kişisel kullanıcı hesabıyla çalıştırılamaz',
    detail:
      'Application Default Credentials bir kullanıcı hesabına ait (impersonation olmadan "gcloud auth application-default login" ile oluşturulmuş). ' +
      `Servis bilerek reddediyor: GCP'ye sadece ${ctx.serviceAccount} kimliğiyle, onun dar yetkisiyle gitmeli.`,
    action: 'ADC\'yi service account impersonation ile yeniden oluşturun, sonra Tekrar dene\'ye basın.',
    command: adcLoginCommand(ctx),
    docsUrl: DOCS.impersonation,
    retryable: false,
  });
}

export function readGoogleError(err: unknown): GoogleErrorInfo {
  const chain = causeChain(err);
  const info: GoogleErrorInfo = {
    grpcCode: null,
    httpStatus: null,
    status: null,
    message: '',
    reason: null,
    metadata: {},
    legacyReasons: [],
    networkCode: null,
    text: '',
  };
  const texts: string[] = [];

  for (const node of chain) {
    const code = node.code;
    if (typeof code === 'number' && info.grpcCode === null && code >= 0 && code <= 16) info.grpcCode = code;
    if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) info.networkCode ??= code;
    if (typeof node.httpStatusCode === 'number') info.httpStatus ??= node.httpStatusCode;
    if (typeof node.status === 'number') info.httpStatus ??= node.status;
    if (typeof node.reason === 'string') info.reason ??= node.reason;
    if (isStringRecord(node.errorInfoMetadata)) info.metadata = { ...node.errorInfoMetadata, ...info.metadata };
    if (typeof node.message === 'string') texts.push(node.message);

    const body = parseBody(node.response?.data) ?? parseBody(node.message);
    if (body) applyBody(info, body, texts);
  }

  const readable = texts.find((t) => t.trim() !== '' && !t.trim().startsWith('{')) ?? texts[0] ?? String(err);
  info.message ||= readable;
  info.text = texts.join('\n');
  const networkInText = [...NETWORK_ERROR_CODES].find((c) => info.text.includes(c));
  info.networkCode ??= networkInText ?? null;
  return info;
}

function applyBody(info: GoogleErrorInfo, body: GoogleApiErrorBody, texts: string[]): void {
  const e = body.error;
  if (typeof e.message === 'string' && e.message !== '') {
    info.message ||= e.message;
    texts.push(e.message);
  }
  if (typeof e.code === 'number') info.httpStatus ??= e.code;
  if (typeof e.status === 'string') info.status ??= e.status;
  for (const detail of e.details ?? []) {
    if (typeof detail?.['@type'] === 'string' && detail['@type'].endsWith('google.rpc.ErrorInfo')) {
      if (typeof detail.reason === 'string') info.reason ??= detail.reason;
      if (isStringRecord(detail.metadata)) info.metadata = { ...detail.metadata, ...info.metadata };
    }
  }
  for (const legacy of e.errors ?? []) {
    if (typeof legacy?.reason === 'string') info.legacyReasons.push(legacy.reason);
    if (typeof legacy?.message === 'string') texts.push(legacy.message);
  }
}

interface GoogleApiErrorBody {
  error: {
    code?: unknown;
    message?: unknown;
    status?: unknown;
    details?: Array<{ '@type'?: unknown; reason?: unknown; metadata?: unknown }>;
    errors?: Array<{ reason?: unknown; message?: unknown }>;
  };
}

function parseBody(value: unknown): GoogleApiErrorBody | null {  // 403'te Google gövdesi mesajın içinde JSON string gelir
  let candidate = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{')) return null;
    try {
      candidate = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (candidate && typeof candidate === 'object' && 'error' in candidate) {
    const error = (candidate as { error: unknown }).error;
    if (error && typeof error === 'object') return candidate as GoogleApiErrorBody;
  }
  return null;
}

type ErrorNode = {
  code?: unknown;
  status?: unknown;
  httpStatusCode?: unknown;
  reason?: unknown;
  errorInfoMetadata?: unknown;
  message?: unknown;
  response?: { data?: unknown };
  cause?: unknown;
  error?: unknown;
};

function causeChain(err: unknown): ErrorNode[] {
  const chain: ErrorNode[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && typeof current === 'object' && !seen.has(current) && chain.length < MAX_CAUSE_DEPTH) {
    seen.add(current);
    const node = current as ErrorNode;
    chain.push(node);
    current = node.cause ?? node.error;
  }
  return chain;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return !!value && typeof value === 'object' && Object.values(value).every((v) => typeof v === 'string');
}

function isNetworkFailure(info: GoogleErrorInfo): boolean {
  return (
    info.networkCode !== null ||
    info.grpcCode === GRPC.UNAVAILABLE ||
    info.grpcCode === GRPC.DEADLINE_EXCEEDED
  );
}

function isApiDisabled(info: GoogleErrorInfo): boolean {
  return (
    info.reason === 'SERVICE_DISABLED' ||
    info.legacyReasons.includes('accessNotConfigured') ||
    /has not been used in project|it is disabled/i.test(info.text)
  );
}

function missingPermission(info: GoogleErrorInfo): string | null {
  if (info.metadata.permission) return info.metadata.permission;
  const required = REQUIRED_PERMISSION_PATTERN.exec(info.text);
  if (required) return required[1];
  const denied = PERMISSION_DENIED_ON_PATTERN.exec(info.text);
  return denied ? denied[1] : null;
}

function adcLoginCommand(ctx: TranslateContext): string {
  return `gcloud auth application-default login --impersonate-service-account=${ctx.serviceAccount}`;
}

function credentialsNotFound(ctx: TranslateContext): AppErrorBody {
  return {
    code: 'GCP_CREDENTIALS_NOT_FOUND',
    title: 'GCP kimlik bilgisi bulunamadı',
    detail:
      'Servis Application Default Credentials (ADC) arıyor ama bu makinede bulamadı. ' +
      `Servis kişisel hesapla değil, ${ctx.serviceAccount} service account'unun kimliğine bürünerek çalışır.`,
    action: 'ADC\'yi service account impersonation ile oluşturun, sonra Tekrar dene\'ye basın (servisi yeniden başlatmak gerekmez).',
    command: adcLoginCommand(ctx),
    docsUrl: DOCS.adc,
    retryable: false,
  };
}

function credentialsFileUnreadable(): AppErrorBody {
  return {
    code: 'GCP_CREDENTIALS_NOT_FOUND',
    title: 'GCP kimlik dosyası okunamadı',
    detail:
      'GOOGLE_APPLICATION_CREDENTIALS ortam değişkeni bir dosyayı gösteriyor ama o dosya yok ya da okunamıyor. ' +
      'Bu değişken tanımlıyken kütüphane gcloud\'un ADC dosyasına hiç bakmaz.',
    action: 'Değişkeni kaldırıp servisi yeniden başlatın ya da değişkene doğru dosya yolunu verin.',
    command: 'unset GOOGLE_APPLICATION_CREDENTIALS && npm run dev',
    docsUrl: DOCS.adc,
    retryable: false,
  };
}

function credentialsExpired(ctx: TranslateContext): AppErrorBody {
  return {
    code: 'GCP_CREDENTIALS_EXPIRED',
    title: 'GCP oturumunun süresi dolmuş',
    detail:
      'ADC\'deki kaynak kimlik (gcloud ile açılan kullanıcı oturumu) artık geçerli değil: token süresi dolmuş, iptal edilmiş ' +
      'veya yeniden doğrulama isteniyor. Service account token\'ı bu oturumla üretildiği için istek yapılamıyor.',
    action: 'Oturumu yenileyin, sonra Tekrar dene\'ye basın.',
    command: adcLoginCommand(ctx),
    docsUrl: DOCS.adc,
    retryable: false,
  };
}

function impersonationDenied(ctx: TranslateContext, info: GoogleErrorInfo): AppErrorBody {
  return {
    code: 'GCP_IMPERSONATION_DENIED',
    title: 'Service account\'un kimliğine bürünülemedi',
    detail:
      `ADC'deki kullanıcı ${ctx.serviceAccount} için token üretemiyor (${TOKEN_CREATOR_PERMISSION}). ` +
      'Olası sebepler: Token Creator rolü verilmemiş, yeni verildiyse henüz yayılmamış (birkaç dakika sürebilir) ' +
      `ya da service account silinmiş. Google mesajı: ${info.message}`,
    action: 'Kullanıcınıza service account üzerinde Token Creator rolü verin; rol yeni verildiyse 1-2 dakika bekleyip tekrar deneyin.',
    command:
      `gcloud iam service-accounts add-iam-policy-binding ${ctx.serviceAccount} ` +
      `--member=user:YOUR_EMAIL --role=roles/iam.serviceAccountTokenCreator --project=${ctx.projectId}`,
    docsUrl: info.metadata.troubleshooter_url ?? DOCS.impersonation,
    retryable: true,
  };
}

function apiDisabled(ctx: TranslateContext, info: GoogleErrorInfo): AppErrorBody {
  const service = info.metadata.service ?? 'compute.googleapis.com';
  return {
    code: 'GCP_API_DISABLED',
    title: `${service} bu projede kapalı`,
    detail: `${ctx.projectId} projesinde ${service} etkin değil; API kapalıyken hiçbir VM listelenemez.`,
    action: 'API\'yi etkinleştirin. Yeni açıldıysa birkaç dakika sonra tekrar deneyin.',
    command: `gcloud services enable ${service} --project=${ctx.projectId}`,
    docsUrl:
      info.metadata.activationUrl ??
      `https://console.cloud.google.com/apis/library/${service}?project=${encodeURIComponent(ctx.projectId)}`,
    retryable: false,
  };
}

function permissionDenied(ctx: TranslateContext, info: GoogleErrorInfo): AppErrorBody {
  const permission = missingPermission(info);
  const what = permission ? `"${permission}" iznine` : 'bu işlem için gereken izne';
  return {
    code: 'GCP_PERMISSION_DENIED',
    title: permission ? `Eksik izin: ${permission}` : 'GCP isteği yetki nedeniyle reddedildi',
    detail:
      `${ctx.serviceAccount} ${what} sahip değil. ` +
      `Proje ID'si (${ctx.projectId}) var olan ama bu service account'un erişemediği bir projeyse GCP yine bu hatayı döner. ` +
      `Google mesajı: ${info.message}`,
    action: permission
      ? `İzni inventoryReader custom role'üne ekleyin ve GCP_PROJECT_ID değerinin doğru olduğunu kontrol edin.`
      : 'Service account\'un rolünü ve GCP_PROJECT_ID değerini kontrol edin.',
    command: permission
      ? `gcloud iam roles update inventoryReader --project=${ctx.projectId} --add-permissions=${permission}`
      : null,
    docsUrl: info.metadata.troubleshooter_url ?? (permission ? DOCS.customRoles : DOCS.troubleshootAccess),
    retryable: false,
  };
}

function projectNotFound(ctx: TranslateContext, info: GoogleErrorInfo): AppErrorBody {
  return {
    code: 'GCP_PROJECT_NOT_FOUND',
    title: `Proje bulunamadı: ${ctx.projectId}`,
    detail: `GCP bu proje ID'sini tanımıyor. Google mesajı: ${info.message}`,
    action: 'server/.env içindeki GCP_PROJECT_ID değerini kontrol edin (project name veya number değil, ID).',
    command: 'gcloud projects list --format="value(projectId)"',
    docsUrl: null,
    retryable: false,
  };
}

function vmNotFound(ctx: TranslateContext): AppErrorBody {
  return {
    code: 'VM_NOT_FOUND',
    title: 'VM bulunamadı',
    detail: `${ctx.resource ?? 'İstenen VM'} ${ctx.projectId} projesinde yok. Silinmiş ya da adı veya zone'u değişmiş olabilir.`,
    action: 'Listeyi yenileyin.',
    command: null,
    docsUrl: null,
    retryable: false,
  };
}

function unreachable(info: GoogleErrorInfo): AppErrorBody {
  const timedOut = info.grpcCode === GRPC.DEADLINE_EXCEEDED && info.networkCode === null;
  return {
    code: 'GCP_UNREACHABLE',
    title: timedOut ? 'Google API zaman aşımına uğradı' : 'Google API\'lerine ulaşılamıyor',
    detail: timedOut
      ? 'İstek süre sınırı içinde tamamlanmadı. Ağ yavaş olabilir ya da Google tarafında geçici bir sorun olabilir.'
      : `Sunucu googleapis.com adreslerine bağlanamadı${info.networkCode ? ` (${info.networkCode})` : ''}. İnternet bağlantısı, DNS, proxy veya VPN kaynaklı olabilir.`,
    action: 'Bağlantıyı kontrol edip tekrar deneyin.',
    command: null,
    docsUrl: null,
    retryable: true,
  };
}

function rateLimited(info: GoogleErrorInfo): AppErrorBody {
  return {
    code: 'GCP_RATE_LIMITED',
    title: 'GCP API kotası aşıldı',
    detail: `Compute Engine API istek limiti doldu. Google mesajı: ${info.message}`,
    action: 'Birkaç saniye bekleyip tekrar deneyin.',
    command: null,
    docsUrl: DOCS.quotas,
    retryable: true,
  };
}

function unknownError(info: GoogleErrorInfo): AppErrorBody {
  return {
    code: 'GCP_UNKNOWN_ERROR',
    title: 'GCP isteği başarısız oldu',
    detail: `Beklenmeyen bir GCP hatası. Google mesajı: ${info.message}`,
    action: 'Ayrıntılar sunucu logunda requestId ile kayıtlı.',
    command: null,
    docsUrl: null,
    retryable: false,
  };
}
