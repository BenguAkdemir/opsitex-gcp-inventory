import type { NormalizedVm, ProviderName } from './vm';

export type ErrorCode =
  | 'GCP_CREDENTIALS_NOT_FOUND'
  | 'GCP_CREDENTIALS_EXPIRED'
  | 'GCP_USER_CREDENTIALS_REJECTED'
  | 'GCP_IMPERSONATION_DENIED'
  | 'GCP_PERMISSION_DENIED'
  | 'GCP_API_DISABLED'
  | 'GCP_PROJECT_NOT_FOUND'
  | 'GCP_UNREACHABLE'
  | 'GCP_RATE_LIMITED'
  | 'GCP_UNKNOWN_ERROR'
  | 'VM_NOT_FOUND'
  | 'BAD_REQUEST'
  | 'ROUTE_NOT_FOUND'
  | 'INTERNAL_ERROR';

export interface ApiError {
  code: ErrorCode;
  title: string;
  detail: string;
  action: string | null;
  command: string | null;
  docsUrl: string | null;
  retryable: boolean;
  requestId: string;
}

export interface ApiErrorResponse {
  error: ApiError;
}

export type IdentityKind = 'impersonated_service_account' | 'service_account' | 'external_account' | 'user' | 'unknown';

export interface ConnectionInfo {
  provider: ProviderName;
  account: string;
  identity: {
    principal: string | null;
    kind: IdentityKind;
    expectedPrincipal: string;
    matchesExpected: boolean;
  };
  scopes: string[];
  checkedAt: string;
}

export interface InventoryWarning {
  scope: string;
  code: string;
  message: string;
  command: string | null;
}

export interface InventoryResponse {
  provider: ProviderName;
  account: string;
  fetchedAt: string;
  warnings: InventoryWarning[];
  vms: NormalizedVm[];
}

export interface VmDetailResponse {
  fetchedAt: string;
  warnings: InventoryWarning[];
  vm: NormalizedVm;
}
