import { useCallback, useEffect, useRef, useState } from 'react';
import { api, toDisplayError, type DisplayError } from '../api/client';
import type { ConnectionInfo, InventoryResponse } from '../api/types';

export interface InventoryState {
  connection: ConnectionInfo | null;
  inventory: InventoryResponse | null;
  error: DisplayError | null;
  loading: boolean;
}

export function useInventory() {
  const [state, setState] = useState<InventoryState>({ connection: null, inventory: null, error: null, loading: true });
  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setState((s) => ({ ...s, loading: true }));

    const [connection, inventory] = await Promise.allSettled([  // biri düşerse diğerinin sonucu kaybolmasın
      api.connection(controller.signal),
      api.vms(controller.signal),
    ]);
    if (controller.signal.aborted) return;

    setState((s) => {
      if (connection.status === 'rejected') {
        return { ...s, connection: null, error: toDisplayError(connection.reason), loading: false };
      }
      if (inventory.status === 'rejected') {
        return { ...s, connection: connection.value, error: toDisplayError(inventory.reason), loading: false };
      }
      return { connection: connection.value, inventory: inventory.value, error: null, loading: false };
    });
  }, []);

  useEffect(() => {
    void load();
    return () => inFlight.current?.abort();
  }, [load]);

  return { ...state, refresh: load };
}

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
