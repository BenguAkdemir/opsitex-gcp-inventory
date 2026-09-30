import { useCallback, useRef, useState } from 'react';
import type { NormalizedVm } from './api/types';
import { ConnectionBar } from './components/ConnectionBar';
import { ErrorPanel } from './components/ErrorPanel';
import { EmptyState, LoadingSkeleton } from './components/States';
import { Summary } from './components/Summary';
import { VmDrawer } from './components/VmDrawer';
import { VmTable } from './components/VmTable';
import { WarningsBanner } from './components/WarningsBanner';
import { useInventory, useNow } from './hooks/useInventory';
import { relativeTime } from './lib/format';

export function App() {
  const { connection, inventory, error, loading, refresh } = useInventory();
  const now = useNow(30_000);
  const [selected, setSelected] = useState<NormalizedVm | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const vms = inventory?.vms ?? [];
  const current = selected ? (vms.find((vm) => vm.id === selected.id) ?? selected) : null;

  const openVm = (vm: NormalizedVm) => {
    returnFocus.current = document.activeElement as HTMLElement | null;
    setSelected(vm);
  };
  const closeVm = useCallback(() => {
    setSelected(null);
    returnFocus.current?.focus();
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>GCP Compute Envanteri</h1>
          <p>Salt okunur envanter · veriler her yenilemede doğrudan Compute Engine API'den alınır</p>
        </div>
      </header>

      <ConnectionBar
        connection={connection}
        failed={error !== null && connection === null}
        loading={loading}
        lastSuccessAt={inventory?.fetchedAt ?? null}
        now={now}
        onRefresh={refresh}
      />

      {!inventory && loading && <LoadingSkeleton />}
      {!inventory && !loading && error && <ErrorPanel error={error} onRetry={refresh} retrying={loading} />}

      {inventory && (
        <>
          {error && (
            <ErrorPanel
              compact
              error={error}
              onRetry={refresh}
              retrying={loading}
              staleSince={relativeTime(inventory.fetchedAt, now)}
            />
          )}
          <div className={`stack${loading ? ' refreshing' : ''}`}>
            <WarningsBanner warnings={inventory.warnings} />
            {vms.length === 0 ? (
              <EmptyState
                project={inventory.account}
                principal={connection?.identity.principal ?? null}
                partial={inventory.warnings.length > 0}
              />
            ) : (
              <>
                <Summary vms={vms} />
                <VmTable vms={vms} selectedId={current?.id ?? null} onSelect={openVm} now={now} />
              </>
            )}
          </div>
        </>
      )}

      {current && <VmDrawer vm={current} now={now} onClose={closeVm} />}
    </div>
  );
}
