import { InstancesClient, MachineTypesClient } from '@google-cloud/compute';
import {
  BaseExternalAccountClient,
  Compute,
  ExternalAccountAuthorizedUserClient,
  GoogleAuth,
  Impersonated,
  JWT,
  UserRefreshClient,
  type AnyAuthClient,
} from 'google-auth-library';
import type { IdentityKind } from '../../domain/api';
import { log } from '../../log';

export const COMPUTE_READONLY_SCOPE = 'https://www.googleapis.com/auth/compute.readonly';

export type AuthFactory = () => GoogleAuth;

export interface ComputeEndpointOptions {
  apiEndpoint?: string;
  port?: number;
  protocol?: 'http' | 'https';
}

export interface SessionIdentity {
  kind: IdentityKind;
  principal: string | null;
}

export interface GcpSession {
  authClient: AnyAuthClient;
  identity: SessionIdentity;
  instances: InstancesClient;
  machineTypes: MachineTypesClient;
}

export const defaultAuthFactory: AuthFactory = () => new GoogleAuth({ scopes: [COMPUTE_READONLY_SCOPE] });

export async function openSession(createAuth: AuthFactory, endpoint: ComputeEndpointOptions = {}): Promise<GcpSession> {
  const auth = createAuth();
  const authClient = await auth.getClient();  // ADC hatası burada, client oluşmadan ve yakalanabilir çıkar
  const identity = await resolveIdentity(auth, authClient);  // kişisel hesap mı SA mı: UI'da göster, kişiseli reddet

  const instances = new InstancesClient({ ...endpoint, auth });  // kendi auth'umuzu veriyoruz; endpoint sadece testte dolu
  const machineTypes = new MachineTypesClient({ ...endpoint, auth });
  await Promise.all([instances.initialize(), machineTypes.initialize()]);  // arka planda kalırsa hata Node'u çökertiyordu

  return { authClient, identity, instances, machineTypes };
}

async function resolveIdentity(auth: GoogleAuth, client: AnyAuthClient): Promise<SessionIdentity> {
  if (client instanceof Impersonated) {
    return { kind: 'impersonated_service_account', principal: client.getTargetPrincipal() };
  }
  if (client instanceof UserRefreshClient || client instanceof ExternalAccountAuthorizedUserClient) {
    return { kind: 'user', principal: null };
  }
  if (client instanceof JWT) {
    return { kind: 'service_account', principal: client.email ?? null };
  }
  if (client instanceof BaseExternalAccountClient) {
    return { kind: 'external_account', principal: client.getServiceAccountEmail() };
  }
  if (client instanceof Compute) {
    try {
      const credentials = await auth.getCredentials();
      return { kind: 'service_account', principal: credentials.client_email ?? null };
    } catch (error) {
      log.warn('could not read service account email from metadata server', { error });
      return { kind: 'service_account', principal: null };
    }
  }
  return { kind: 'unknown', principal: null };
}
