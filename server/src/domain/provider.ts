import type { ConnectionInfo, InventoryResponse, VmDetailResponse } from './api';

export interface InventoryProvider {
  checkConnection(): Promise<ConnectionInfo>;
  listVms(): Promise<InventoryResponse>;
  getVm(zone: string, name: string): Promise<VmDetailResponse>;
}
